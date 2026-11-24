import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseServerAddress } from '../session/lan_discovery.js';

const PUBLIC_DIR = new URL('./public/', import.meta.url);
const INDEX_HTML = readFileSync(new URL('index.html', PUBLIC_DIR), 'utf8');
const STYLE_CSS = readFileSync(new URL('style.css', PUBLIC_DIR), 'utf8');
const APP_JS = readFileSync(new URL('app.js', PUBLIC_DIR), 'utf8');

const MAX_BODY_BYTES = 64 * 1024;
const VALID_HOST_RE = /^[a-zA-Z0-9._:-]{1,253}$/;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const VALID_CONTROLS = new Set(['toggle_ai', 'pause_ai', 'resume_ai', 'recall_home', 'safe_disconnect']);
const VALID_INV_ACTIONS = new Set(['equip', 'drop']);

export class DashboardServer {
  constructor({
    host = '127.0.0.1',
    port = 3000,
    authToken = null,
    getState,
    onCommand,
    onConnect = null,
    onControl = null,
    onInventoryAction = null,
    onGetNearby = null,
    getInbox = null,
    onSay = null,
    onMacro = null,
    onPlanExecute = null,
    onSmelt = null,
    onScratchpad = null,
    sseIntervalMs = 250,
    log = () => {},
  } = {}) {
    this.host = host;
    this.port = port;
    this.authToken = authToken ? String(authToken).trim() || null : null;
    this.getState = getState;
    this.onCommand = onCommand;
    this.onConnect = onConnect;
    this.onControl = onControl;
    this.onInventoryAction = onInventoryAction;
    this.onGetNearby = onGetNearby;
    this.getInbox = getInbox;
    this.onSay = onSay;
    this.onMacro = onMacro;
    this.onPlanExecute = onPlanExecute;
    this.onSmelt = onSmelt;
    this.onScratchpad = onScratchpad;
    this.sseIntervalMs = Math.max(50, Number(sseIntervalMs) || 250);
    this.log = log;
    this.server = null;
    this._sseClients = new Set();
    this._sseTimer = null;
  }

  _isLoopbackHost(host) {
    const h = String(host ?? '').trim().toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  }

  _extractToken(req, url) {
    const authHeader = String(req.headers.authorization ?? '').trim();
    if (/^Bearer\s+/i.test(authHeader)) {
      return authHeader.replace(/^Bearer\s+/i, '').trim();
    }
    const headerToken = req.headers['x-dashboard-token'];
    if (typeof headerToken === 'string' && headerToken.trim()) {
      return headerToken.trim();
    }
    const queryToken = url?.searchParams?.get('token');
    return queryToken ? String(queryToken).trim() : '';
  }

  _hasValidToken(req, url) {
    if (!this.authToken) return true;
    const provided = this._extractToken(req, url);
    if (!provided) return false;
    const expectedBuf = Buffer.from(this.authToken, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (expectedBuf.byteLength !== providedBuf.byteLength) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  _isAuthorizedPost(req, url) {
    if (this.authToken && !this._hasValidToken(req, url)) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
    const origin = req.headers.origin;
    if (origin) {
      const sameHostOrigin = Boolean(
        this.authToken &&
        req.headers.host &&
        (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`)
      );
      if (!LOOPBACK_ORIGIN_RE.test(origin) && !sameHostOrigin) {
        return { ok: false, status: 403, error: 'Cross-origin POST rejected' };
      }
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return { ok: false, status: 415, error: 'Content-Type must be application/json' };
    }
    return { ok: true };
  }

  async _readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        throw err;
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  _sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  _ensureSseTimer() {
    if (this._sseTimer || this._sseClients.size === 0) return;
    this._sseTimer = setInterval(() => {
      if (this._sseClients.size === 0) {
        clearInterval(this._sseTimer);
        this._sseTimer = null;
        return;
      }
      this.broadcast();
    }, this.sseIntervalMs);
    this._sseTimer.unref?.();
  }

  broadcast() {
    if (this._sseClients.size === 0) return;
    let frame;
    try {
      const snapshot = this.getState ? this.getState() : {};
      frame = `data: ${JSON.stringify(snapshot)}\n\n`;
    } catch {
      return;
    }
    for (const res of Array.from(this._sseClients)) {
      if (res.writableEnded || res.destroyed) {
        this._sseClients.delete(res);
        continue;
      }
      try {
        res.write(frame);
      } catch {
        this._sseClients.delete(res);
      }
    }
  }

  async start() {
    if (this.server) return this.address();
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(INDEX_HTML);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        res.end(STYLE_CSS);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(APP_JS);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        if (this.authToken && !this._hasValidToken(req, url)) {
          return this._sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        }
        const snapshot = this.getState ? this.getState() : {};
        this._sendJson(res, 200, snapshot);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/nearby') {
        if (this.authToken && !this._hasValidToken(req, url)) {
          return this._sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        }
        const rawRadius = Number(url.searchParams.get('radius'));
        const radius = Number.isFinite(rawRadius) && rawRadius > 0
          ? Math.max(1, Math.min(64, rawRadius))
          : 24;
        const nearby = this.onGetNearby
          ? await this.onGetNearby({ radius })
          : {
              connected: false,
              position: null,
              dimension: null,
              ownerPosition: null,
              players: [],
              mobs: [],
              items: [],
              blocks: {},
            };
        this._sendJson(res, 200, nearby);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/inbox') {
        if (this.authToken && !this._hasValidToken(req, url)) {
          return this._sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        }
        const rawSince = Number(url.searchParams.get('sinceId'));
        const sinceId = Number.isInteger(rawSince) && rawSince >= 0 ? rawSince : 0;
        const rawLimit = Number(url.searchParams.get('limit'));
        const limit = Number.isInteger(rawLimit) && rawLimit > 0
          ? Math.max(1, Math.min(100, rawLimit))
          : 30;
        const source = url.searchParams.get('source') || null;
        const inbox = this.getInbox
          ? await this.getInbox({ sinceId, limit, source })
          : { latestId: 0, messages: [] };
        this._sendJson(res, 200, inbox);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        const s = this.getState ? this.getState() : {};
        this._sendJson(res, 200, {
          ok: true,
          connected: Boolean(s.connected),
          state: s.state ?? 'unknown',
          aiPaused: Boolean(s.aiPaused),
          watchdog: s.watchdog ?? null,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/scratchpad') {
        if (this.authToken && !this._hasValidToken(req, url)) {
          return this._sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        }
        const data = this.onScratchpad
          ? await this.onScratchpad({ action: 'get' })
          : { ok: true, action: 'get', scratchpad: null, summary: null };
        this._sendJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        if (this.authToken && !this._hasValidToken(req, url)) {
          return this._sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        this._sseClients.add(res);
        const cleanupClient = () => {
          this._sseClients.delete(res);
          if (this._sseClients.size === 0 && this._sseTimer) {
            clearInterval(this._sseTimer);
            this._sseTimer = null;
          }
        };
        req.on('close', cleanupClient);
        res.on('close', cleanupClient);
        res.on('error', cleanupClient);
        try {
          const snapshot = this.getState ? this.getState() : {};
          res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        } catch {}
        this._ensureSseTimer();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/connect') {
        const auth = this._isAuthorizedPost(req, url);
        if (!auth.ok) return this._sendJson(res, auth.status, { ok: false, error: auth.error });
        try {
          const body = await this._readJsonBody(req);
          const rawHost = body.host != null ? String(body.host).trim() : '';
          const parsedAddr = rawHost ? parseServerAddress(rawHost, { defaultPort: 25565 }) : null;
          if (rawHost && (!parsedAddr || !parsedAddr.host || !VALID_HOST_RE.test(parsedAddr.host))) {
            return this._sendJson(res, 400, { ok: false, error: 'Host không hợp lệ' });
          }

          const hasExplicitPort = body.port != null && String(body.port).trim() !== '';
          let portNum;
          if (hasExplicitPort) {
            const p = Number(body.port);
            if (!Number.isInteger(p) || p < 1 || p > 65535) {
              return this._sendJson(res, 400, { ok: false, error: 'Cổng LAN không hợp lệ (1-65535)' });
            }
            portNum = parsedAddr?.isE4mc && parsedAddr.explicitPort ? parsedAddr.port : p;
          } else if (parsedAddr?.host) {
            portNum = parsedAddr.port;
          } else {
            return this._sendJson(res, 400, { ok: false, error: 'Cổng LAN không hợp lệ (1-65535)' });
          }

          const host = parsedAddr?.host || 'localhost';
          if (this.onConnect) {
            const connectOpts = {
              host,
              port: portNum,
              owner: String(body.owner || '').trim().slice(0, 16),
            };
            const version = body.version != null ? String(body.version).trim().slice(0, 32) : '';
            if (version) connectOpts.version = version;
            const mcAuth = body.auth != null ? String(body.auth).trim().toLowerCase() : '';
            if (mcAuth === 'offline' || mcAuth === 'microsoft') {
              connectOpts.auth = mcAuth;
            }
            await this.onConnect(connectOpts);
          }
          return this._sendJson(res, 200, { ok: true, host, port: portNum });
        } catch (err) {
          return this._sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/command') {
        const auth = this._isAuthorizedPost(req, url);
        if (!auth.ok) return this._sendJson(res, auth.status, { ok: false, error: auth.error });
        try {
          const body = await this._readJsonBody(req);
          const cmd = String(body.command ?? '').trim().slice(0, 500);
          if (!cmd) return this._sendJson(res, 400, { ok: false, error: 'command required' });
          const result = this.onCommand ? await this.onCommand(cmd) : null;
          this.broadcast();
          return this._sendJson(res, 200, {
            ok: true,
            ...(result && typeof result === 'object' ? { result } : {}),
          });
        } catch (err) {
          return this._sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/say') {
        const auth = this._isAuthorizedPost(req, url);
        if (!auth.ok) return this._sendJson(res, auth.status, { ok: false, error: auth.error });
        try {
          const body = await this._readJsonBody(req);
          const message = String(body.message ?? '').trim().slice(0, 500);
          if (!message) return this._sendJson(res, 400, { ok: false, error: 'message required' });
          const rawWhisper = body.whisperTo != null ? String(body.whisperTo).trim().slice(0, 16) : '';
          const whisperTo = rawWhisper || null;
          const instant = Boolean(body.instant);
          const result = this.onSay
            ? await this.onSay({ message, whisperTo, instant })
            : { ok: false, error: 'Bot chưa sẵn sàng' };
          if (result?.ok === false) {
            return this._sendJson(res, result.status ?? 409, {
              ok: false,
              error: result.error ?? 'Không gửi được tin nhắn',
            });
          }
          this.broadcast();
          return this._sendJson(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
        } catch (err) {
          return this._sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/control') {
        const auth = this._isAuthorizedPost(req, url);
        if (!auth.ok) return this._sendJson(res, auth.status, { ok: false, error: auth.error });
        try {
          const body = await this._readJsonBody(req);
          const action = String(body.action ?? '').trim();
          if (!VALID_CONTROLS.has(action)) {
            return this._sendJson(res, 400, { ok: false, error: 'Invalid control action' });
          }
          const result = this.onControl ? await this.onControl({ action }) : null;
          this.broadcast();
          return this._sendJson(res, 200, { ok: true, action, result });
        } catch (err) {
          return this._sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/inventory/action') {
        const auth = this._isAuthorizedPost(req, url);
        if (!auth.ok) return this._sendJson(res, auth.status, { ok: false, error: auth.error });
        try {
          const body = await this._readJsonBody(req);
          const action = String(body.action ?? '').trim();
          const itemName = String(body.itemName ?? '').trim().slice(0, 120);
          const slot = body.slot != null ? Number(body.slot) : null;
          if (!VALID_INV_ACTIONS.has(action) || !itemName) {
            return this._sendJson(res, 400, { ok: false, error: 'Invalid inventory action or itemName' });
          }
          const result = this.onInventoryAction ? await this.onInventoryAction({ action, itemName, slot }) : null;
          this.broadcast();
          return this._sendJson(res, 200, { ok: true, action, itemName, result });
        } catch (err) {
          return this._sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/macro') {
        const auth = this._isAuthorizedPost(req, url);
        if (!auth.ok) return this._sendJson(res, auth.status, { ok: false, error: auth.error });
        try {
          const body = await this._readJsonBody(req);
          const macro = String(body.macro ?? '').trim();
          const wait = body.wait !== false;
          if (!macro) {
            return this._sendJson(res, 400, { ok: false, error: 'macro required' });
          }
          const result = this.onMacro
            ? await this.onMacro({ macro, wait })
            : { ok: false, status: 503, error: 'Macro runner chưa sẵn sàng' };
          if (result?.ok === false && result?.status) {
            return this._sendJson(res, result.status, {
              ok: false,
              error: result.error ?? 'Macro failed',
              ...result,
            });
          }
          this.broadcast();
          return this._sendJson(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
        } catch (err) {
          return this._sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/plan') {
        const auth = this._isAuthorizedPost(req, url);
        if (!auth.ok) return this._sendJson(res, auth.status, { ok: false, error: auth.error });
        try {
          const body = await this._readJsonBody(req);
          const goal = String(body.goal ?? '').trim().slice(0, 300);
          const steps = body.steps;
          const onDanger = body.onDanger === 'abort_and_notify' ? 'abort_and_notify' : 'pause_and_resume';
          const wait = body.wait !== false;
          if (!Array.isArray(steps) || steps.length === 0) {
            return this._sendJson(res, 400, { ok: false, error: 'steps array required' });
          }
          const result = this.onPlanExecute
            ? await this.onPlanExecute({ goal, steps, onDanger, wait })
            : { ok: false, status: 503, error: 'Plan executor chưa sẵn sàng' };
          if (result?.ok === false && result?.status) {
            return this._sendJson(res, result.status, {
              ok: false,
              error: result.error ?? 'Plan failed',
              ...result,
            });
          }
          this.broadcast();
          return this._sendJson(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
        } catch (err) {
          return this._sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/smelt') {
        const auth = this._isAuthorizedPost(req, url);
        if (!auth.ok) return this._sendJson(res, auth.status, { ok: false, error: auth.error });
        try {
          const body = await this._readJsonBody(req);
          const action = String(body.action ?? 'status').trim();
          const target = String(body.target ?? '').trim().slice(0, 120);
          const count = body.count != null ? Number(body.count) : 1;
          const force = Boolean(body.force);
          const result = this.onSmelt
            ? await this.onSmelt({ action, target, count, force })
            : { ok: false, status: 503, error: 'Smelting manager chưa sẵn sàng' };
          if (result?.ok === false && result?.status) {
            return this._sendJson(res, result.status, {
              ok: false,
              error: result.error ?? 'Smelt failed',
              ...result,
            });
          }
          this.broadcast();
          return this._sendJson(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
        } catch (err) {
          return this._sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/scratchpad') {
        const auth = this._isAuthorizedPost(req, url);
        if (!auth.ok) return this._sendJson(res, auth.status, { ok: false, error: auth.error });
        try {
          const body = await this._readJsonBody(req);
          const action = String(body.action ?? 'get').trim();
          const goal = String(body.goal ?? '').trim().slice(0, 300);
          const steps = Array.isArray(body.steps) ? body.steps.slice(0, 20).map(s => String(s ?? '').trim()).filter(Boolean) : [];
          const note = body.note != null ? String(body.note).trim().slice(0, 500) : '';
          const result = this.onScratchpad
            ? await this.onScratchpad({ action, goal, steps, note })
            : { ok: false, status: 503, error: 'Scratchpad chưa sẵn sàng' };
          if (result?.ok === false && result?.status) {
            return this._sendJson(res, result.status, {
              ok: false,
              error: result.error ?? 'Scratchpad action failed',
              ...result,
            });
          }
          this.broadcast();
          return this._sendJson(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
        } catch (err) {
          return this._sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
        }
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });

    const addr = this.address();
    this.log(`🌐 Dashboard đang chạy tại http://${addr.host}:${addr.port}`);
    if (!this.authToken && !this._isLoopbackHost(this.host)) {
      this.log('⚠️ Dashboard đang bind non-loopback mà chưa đặt DASHBOARD_TOKEN!');
    }
    return addr;
  }

  address() {
    if (!this.server) return null;
    const info = this.server.address();
    if (!info || typeof info === 'string') return { host: this.host, port: this.port };
    return { host: info.address, port: info.port };
  }

  async stop() {
    if (this._sseTimer) {
      clearInterval(this._sseTimer);
      this._sseTimer = null;
    }
    for (const client of this._sseClients) {
      try { client.end(); } catch {}
    }
    this._sseClients.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(() => resolve()));
  }
}

export default DashboardServer;
