import crypto from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MINECRAFT_FORMAT_RE = /\u00a7[0-9a-fk-or]/gi;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
const VALID_ADDRESS_HOST_RE = /^[a-zA-Z0-9._-]{1,253}$/;

export function isSameHost(hostA, hostB) {
  const a = String(hostA ?? '').trim().toLowerCase();
  const b = String(hostB ?? '').trim().toLowerCase();
  if (!a || !b) return a === b;
  if (LOOPBACK_HOSTS.has(a) && LOOPBACK_HOSTS.has(b)) return true;
  return a === b;
}

export function isE4mcHost(host) {
  const h = String(host ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  return Boolean(h) && (h === 'e4mc.link' || h.endsWith('.e4mc.link'));
}

export function isLocalHostAddress(host) {
  const h = String(host ?? '').trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').toLowerCase();
  if (!h) return true;
  if (LOOPBACK_HOSTS.has(h) || h === 'host.docker.internal' || h.endsWith('.local')) {
    return true;
  }
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    const c = Number(ipv4[3]);
    const d = Number(ipv4[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  return false;
}

export function parseServerAddress(raw, { defaultPort = 25565 } = {}) {
  if (raw == null || (typeof raw !== 'string' && typeof raw !== 'number')) return null;
  let text = String(raw).trim();
  if (!text) return null;

  const parsedDefaultPort = Number(defaultPort);
  const fallbackPort = Number.isInteger(parsedDefaultPort) && parsedDefaultPort >= 1 && parsedDefaultPort <= 65535
    ? parsedDefaultPort
    : 25565;

  const domainChatMatch =
    text.match(/hosted on domain\s*\[([^\]]+)\]/i) ||
    text.match(/(?:tên miền|ten mien)\s*\[([^\]]+)\]/i);
  if (domainChatMatch) {
    text = domainChatMatch[1].trim();
  } else {
    const portChatMatch =
      text.match(/hosted on port\s*\[?(\d{1,5})\]?/i) ||
      text.match(/(?:tại cổng|tai cong)\s*\[?(\d{1,5})\]?/i);
    if (portChatMatch) {
      text = portChatMatch[1].trim();
    }
  }

  text = text.replace(/^(?:tcp|minecraft):\/\//i, '').replace(/\/+$/, '').trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const portNum = Number(text);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
    return { host: null, port: portNum, explicitPort: true, isE4mc: false, isRemote: false };
  }

  if (/\s/.test(text)) return null;

  const bracketMatch = text.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracketMatch) {
    const inner = bracketMatch[1].trim();
    const outerPortStr = bracketMatch[2] ?? null;
    if (net.isIP(inner) === 6) {
      let portNum = fallbackPort;
      if (outerPortStr != null) {
        portNum = Number(outerPortStr);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
      }
      const cleanHost = inner.toLowerCase();
      return {
        host: cleanHost,
        port: portNum,
        explicitPort: outerPortStr != null,
        isE4mc: false,
        isRemote: !isLocalHostAddress(cleanHost),
      };
    }
    if (outerPortStr) {
      text = `${inner}:${outerPortStr}`;
    } else {
      text = inner;
    }
  }

  if (net.isIP(text) === 6) {
    const cleanHost = text.toLowerCase();
    return {
      host: cleanHost,
      port: fallbackPort,
      explicitPort: false,
      isE4mc: false,
      isRemote: !isLocalHostAddress(cleanHost),
    };
  }

  const colonParts = text.split(':');
  if (colonParts.length > 2) return null;

  let hostPart = text;
  let portNum = fallbackPort;
  let explicitPort = false;
  if (colonParts.length === 2) {
    hostPart = colonParts[0];
    const portStr = colonParts[1];
    if (!/^\d{1,5}$/.test(portStr)) return null;
    portNum = Number(portStr);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
    explicitPort = true;
  }

  if (!VALID_ADDRESS_HOST_RE.test(hostPart) || hostPart.startsWith('.') || hostPart.endsWith('.')) {
    return null;
  }

  return {
    host: hostPart,
    port: portNum,
    explicitPort,
    isE4mc: isE4mcHost(hostPart),
    isRemote: !isLocalHostAddress(hostPart),
  };
}

export function parseConsoleConnectInput(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;

  if (/^\d{1,5}$/.test(text)) {
    return parseServerAddress(text);
  }

  const connectCmd = text.match(/^(?:connect|ket\s*noi|kết\s*nối|e4mc|vao\s*server|vào\s*server)\s+(.+)$/i);
  if (connectCmd) {
    return parseServerAddress(connectCmd[1].trim());
  }

  if (/hosted on (?:domain|port)|(?:tổ chức|to chuc)\s+(?:tại|tai)\s+(?:tên miền|ten mien|cổng|cong)/i.test(text)) {
    return parseServerAddress(text);
  }

  if (!/\s/.test(text) && !/^https?:\/\//i.test(text)) {
    const parsed = parseServerAddress(text);
    if (!parsed || !parsed.host) return null;
    const isBracketed = /^\[.+\]$/.test(text);
    if (
      parsed.explicitPort ||
      isBracketed ||
      parsed.host.includes('.') ||
      parsed.host.toLowerCase() === 'localhost' ||
      parsed.host === '::1'
    ) {
      return parsed;
    }
  }

  return null;
}

function unwrapNbtOrChatNode(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (node instanceof Error) {
    return node.message || String(node);
  }
  if (Array.isArray(node)) {
    return node.map(unwrapNbtOrChatNode).join('');
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'string' && 'value' in node) {
      const t = node.type;
      if (t === 'string' || t === 'int' || t === 'short' || t === 'byte' || t === 'float' || t === 'double' || t === 'long') {
        return node.value == null ? '' : String(node.value);
      }
      if (t === 'list') {
        const items = Array.isArray(node.value)
          ? node.value
          : (Array.isArray(node.value?.value) ? node.value.value : null);
        return items ? items.map(unwrapNbtOrChatNode).join('') : unwrapNbtOrChatNode(node.value);
      }
      return unwrapNbtOrChatNode(node.value);
    }

    const parts = [];
    if (node[''] !== undefined) parts.push(unwrapNbtOrChatNode(node['']));
    if (node.text !== undefined) parts.push(unwrapNbtOrChatNode(node.text));
    if (node.translate !== undefined) {
      const key = unwrapNbtOrChatNode(node.translate);
      if (node.with !== undefined) {
        const rawWith = Array.isArray(node.with)
          ? node.with.map(unwrapNbtOrChatNode)
          : (typeof node.with === 'object' && node.with.type === 'list'
            ? (Array.isArray(node.with.value?.value) ? node.with.value.value : (Array.isArray(node.with.value) ? node.with.value : [])).map(unwrapNbtOrChatNode)
            : [unwrapNbtOrChatNode(node.with)]);
        const cleanWith = rawWith.filter(Boolean);
        parts.push(cleanWith.length ? `${key} (${cleanWith.join(', ')})` : key);
      } else {
        parts.push(key);
      }
    }
    if (node.extra !== undefined) parts.push(unwrapNbtOrChatNode(node.extra));

    const joined = parts.join('');
    if (joined) return joined;

    if (typeof node.toString === 'function' && node.toString !== Object.prototype.toString) {
      return node.toString();
    }
    try {
      return JSON.stringify(node);
    } catch {
      return String(node);
    }
  }
  return String(node);
}

export function formatMinecraftReason(reasonOrErr) {
  return unwrapNbtOrChatNode(reasonOrErr)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function explainConnectionIssue(reasonOrErr, config = {}) {
  const rawText = formatMinecraftReason(reasonOrErr);
  const errCode = reasonOrErr && typeof reasonOrErr === 'object' ? String(reasonOrErr.code || '') : '';
  const combined = `${errCode} ${rawText}`.trim();
  if (!combined) return null;

  const authMode = config?.minecraft?.auth === 'microsoft' ? 'microsoft' : 'offline';
  if (
    authMode !== 'microsoft' &&
    /unverified_username|failed to verify username|invalid session|invalid_public_key|not authenticated with minecraft\.net|failed to log in:\s*null/i.test(rawText)
  ) {
    return {
      code: 'online_mode_required',
      rawText,
      hint: 'Server/e4mc đang bật Online Mode (yêu cầu tài khoản bản quyền) trong khi bot đang kết nối chế độ offline. Cách xử lý: (1) Nếu mở LAN trên cùng máy tính với bot, hãy kết nối qua 127.0.0.1:<cổng_LAN> (Auto-LAN); (2) Nếu vào qua *.e4mc.link, nhờ chủ map cài mod tắt Online Mode cho LAN (LanServerProperties / Custom LAN / e4mc-offline) HOẶC đặt "auth": "microsoft" trong config.json (chạy với tài khoản bản quyền cho bot).',
    };
  }

  if (
    /this server requires .* installed on your client|received .* registry entries that are unknown|this server requires fml|mod rejections/i.test(rawText)
  ) {
    return {
      code: 'modded_client_required',
      rawText,
      hint: 'Server có cài mod thêm block/item riêng (Fabric/Forge/NeoForge). Nếu là Fabric, bot sẽ tự đồng bộ Fabric Registry Sync; nếu là Forge/NeoForge hoặc mod bắt buộc code riêng phía client, cần gỡ mod bắt buộc client hoặc dùng bản Fabric tương thích.',
    };
  }

  const host = config?.minecraft?.host || '';
  if (
    isE4mcHost(host) &&
    (errCode === 'ENOTFOUND' || /no such domain|quiclime|domain not found|e4mc.*offline|enotfound|etimedout/i.test(rawText))
  ) {
    return {
      code: 'e4mc_domain_inactive',
      rawText,
      hint: `Tên miền e4mc (${host || 'e4mc.link'}) không tồn tại hoặc chủ map đã đóng LAN. Mỗi lần bấm Open to LAN, e4mc có thể cấp domain mới — hãy dán lại domain mới.`,
    };
  }

  return null;
}

export function collectLocalIpv4Addresses() {
  const ips = new Set(['127.0.0.1']);
  try {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      if (!Array.isArray(entries)) continue;
      for (const iface of entries) {
        if (iface?.family === 'IPv4' && iface.address) {
          ips.add(iface.address);
        }
      }
    }
  } catch {}
  return ips;
}

export function parseLanAnnouncement(raw, remoteAddress = '127.0.0.1', localIps = new Set()) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  const motdMatch = text.match(/\[MOTD\]([\s\S]*?)\[\/MOTD\]/);
  const adMatch = text.match(/\[AD\](\d{1,5})\[\/AD\]/);
  if (!motdMatch || !adMatch) return null;

  const port = Number(adMatch[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const motd = motdMatch[1].replace(MINECRAFT_FORMAT_RE, '').trim();
  const sepIdx = motd.indexOf(' - ');
  let ownerHint = null;
  let worldName = null;
  if (sepIdx !== -1) {
    ownerHint = motd.slice(0, sepIdx).trim() || null;
    worldName = motd.slice(sepIdx + 3).trim() || null;
  } else {
    worldName = motd || null;
  }

  const cleanRemote = String(remoteAddress ?? '').replace(/^::ffff:/i, '').trim();
  const isLocal = !cleanRemote || cleanRemote === '127.0.0.1' || cleanRemote === '::1' || localIps.has(cleanRemote);
  const host = isLocal ? '127.0.0.1' : cleanRemote;

  return {
    host,
    port,
    motd,
    ownerHint,
    worldName,
  };
}

export function resolveWorldDbPath(worldName, { baseDir = 'data' } = {}) {
  const trimmed = String(worldName ?? '').trim();
  if (!trimmed) {
    return path.join(baseDir, 'bot_memory.db');
  }

  const ascii = trimmed
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');

  const slug = ascii || 'world';
  const hash = crypto.createHash('sha1').update(trimmed.toLowerCase()).digest('hex').slice(0, 6);
  return path.join(baseDir, 'worlds', `${slug}-${hash}.db`);
}

export function probeTcpPort(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve(ok);
    };

    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => finish(false), Math.max(50, Number(timeoutMs) || 600));
    timer.unref?.();

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function probeMinecraftServer(host, port = 25565, timeoutMs = 600) {
  const totalMs = Math.max(100, Number(timeoutMs) || 600);
  const startAt = Date.now();
  const cleanHost = String(host ?? '').trim();
  const portNum = Number(port) || 25565;
  if (!cleanHost) return false;

  let targetHost = cleanHost;
  let targetPort = portNum;

  if (portNum === 25565 && net.isIP(cleanHost) === 0 && !isLocalHostAddress(cleanHost)) {
    const srvTimeoutMs = Math.max(50, Math.floor(totalMs / 2));
    try {
      const addresses = await Promise.race([
        dns.promises.resolveSrv(`_minecraft._tcp.${cleanHost}`).catch(() => []),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve([]), srvTimeoutMs);
          t.unref?.();
        }),
      ]);
      if (Array.isArray(addresses) && addresses.length > 0 && addresses[0]?.name) {
        targetHost = addresses[0].name;
        if (Number.isInteger(addresses[0].port) && addresses[0].port >= 1 && addresses[0].port <= 65535) {
          targetPort = addresses[0].port;
        }
      }
    } catch {}
  }

  const elapsed = Date.now() - startAt;
  const remainingMs = Math.max(100, totalMs - elapsed);
  return probeTcpPort(targetHost, targetPort, remainingMs);
}

export class LanDiscovery {
  constructor({
    port = 4445,
    multicastAddr = '224.0.2.60',
    staleMs = 8000,
    onWorld = null,
    log = () => {},
    createSocketFn = null,
  } = {}) {
    this.port = port;
    this.multicastAddr = multicastAddr;
    this.staleMs = Math.max(1000, Number(staleMs) || 8000);
    this.onWorld = onWorld;
    this.log = log;
    this.createSocketFn = createSocketFn;
    this.worlds = new Map();
    this.socket = null;
    this._pruneTimer = null;
    this._localIps = collectLocalIpv4Addresses();
  }

  _joinMulticast() {
    if (!this.socket || typeof this.socket.addMembership !== 'function') return;
    const tried = new Set();
    for (const ip of ['127.0.0.1', ...this._localIps]) {
      if (!ip || tried.has(ip)) continue;
      tried.add(ip);
      try {
        this.socket.addMembership(this.multicastAddr, ip);
      } catch {}
    }
    try {
      this.socket.addMembership(this.multicastAddr);
    } catch {}
  }

  pruneStale(now = Date.now()) {
    for (const [key, entry] of this.worlds.entries()) {
      if (now - entry.lastSeenAt > this.staleMs) {
        this.worlds.delete(key);
      }
    }
  }

  listActive(now = Date.now()) {
    this.pruneStale(now);
    return Array.from(this.worlds.values());
  }

  handleMessage(raw, remoteAddress = '127.0.0.1', now = Date.now()) {
    const parsed = parseLanAnnouncement(raw, remoteAddress, this._localIps);
    if (!parsed) return null;

    this.pruneStale(now);
    const key = `${parsed.host}:${parsed.port}`;
    const existing = this.worlds.get(key);
    const isNew = !existing;
    const record = {
      ...parsed,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    this.worlds.set(key, record);
    this.onWorld?.({ ...record, isNew }, this.listActive(now));
    return { ...record, isNew };
  }

  start() {
    if (this.socket) return this.socket;
    this._localIps = collectLocalIpv4Addresses();
    const socket = this.createSocketFn
      ? this.createSocketFn({ type: 'udp4', reuseAddr: true })
      : dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      this.log(`⚠️ LAN discovery lỗi: ${err.message}`);
    });

    socket.on('listening', () => {
      this._joinMulticast();
    });

    socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg, rinfo?.address || '127.0.0.1');
    });

    if (typeof socket.bind === 'function') {
      socket.bind(this.port);
    }

    const intervalMs = Math.max(1000, Math.floor(this.staleMs / 2));
    this._pruneTimer = setInterval(() => this.pruneStale(), intervalMs);
    this._pruneTimer.unref?.();

    return socket;
  }

  stop() {
    if (this._pruneTimer) {
      clearInterval(this._pruneTimer);
      this._pruneTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.removeAllListeners?.(); } catch {}
      try { socket.close?.(); } catch {}
    }
  }
}

export default LanDiscovery;
