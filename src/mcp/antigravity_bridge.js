import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const DEFAULT_BOT_AGENT_MODEL = 'gemini-4-hydrogen-low';

export function shouldWakeAntigravity(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if ((msg.kind === 'chat' || msg.kind === 'whisper') && msg.isOwner === true && msg.handledByBot === false) {
    return true;
  }
  if (msg.kind === 'alert' && msg.alertType === 'stuck') {
    return true;
  }
  return false;
}

function findUuidInJsonValue(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['conversation_id', 'conversationId', 'recipient_id', 'id']) {
    if (typeof value[key] === 'string') {
      const m = value[key].match(UUID_RE);
      if (m) return m[0];
    }
  }
  for (const v of Object.values(value)) {
    if (v && typeof v === 'object') {
      const nested = findUuidInJsonValue(v);
      if (nested) return nested;
    }
  }
  return null;
}

function extractUuidFromText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const found = findUuidInJsonValue(parsed);
      if (found) return found;
    } catch {}
  }
  const direct = raw.match(UUID_RE);
  return direct ? direct[0] : null;
}

export function extractConversationId({ stdout = '', stderr = '', eventsDir = null, sinceMs = 0 } = {}) {
  const fromStdout = extractUuidFromText(stdout);
  if (fromStdout) return fromStdout;
  const fromStderr = extractUuidFromText(stderr);
  if (fromStderr) return fromStderr;

  if (eventsDir && fs.existsSync(eventsDir)) {
    try {
      const candidates = fs
        .readdirSync(eventsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => {
          const fullPath = path.join(eventsDir, entry.name);
          const stat = fs.statSync(fullPath);
          return { fullPath, mtimeMs: stat.mtimeMs };
        })
        .filter((item) => item.mtimeMs >= sinceMs - 1000)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const item of candidates) {
        try {
          const raw = fs.readFileSync(item.fullPath, 'utf8');
          const found = extractUuidFromText(raw);
          if (found) return found;
        } catch {}
      }
    } catch {}
  }

  return null;
}

export function formatCompactStateSnapshot(stateSnapshot) {
  if (!stateSnapshot || typeof stateSnapshot !== 'object') return '';
  const {
    health,
    food,
    position,
    task,
    isDay,
    timeOfDay,
    equipmentSlots,
    equipped,
    inventory,
    threat,
    scratchpad,
  } = stateSnapshot;

  const hasLiveFields =
    health != null ||
    food != null ||
    position != null ||
    task != null ||
    isDay != null ||
    timeOfDay != null ||
    equipmentSlots != null ||
    equipped != null ||
    Array.isArray(inventory) ||
    threat != null ||
    scratchpad?.recovery != null ||
    scratchpad?.manualNote != null;

  if (!hasLiveFields) return '';

  const parts = [];
  if (typeof health === 'number') parts.push(`máu ${Math.round(health)}/20`);
  if (typeof food === 'number') parts.push(`đói ${Math.round(food)}/20`);

  if (typeof isDay === 'boolean') {
    parts.push(isDay ? 'ngày' : 'đêm');
  } else if (typeof timeOfDay === 'number') {
    parts.push(timeOfDay < 12000 || timeOfDay >= 23500 ? 'ngày' : 'đêm');
  }

  if (position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)) {
    parts.push(`tọa độ (${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)})`);
  }

  if (task) parts.push(`việc: ${task}`);

  const handName = equipmentSlots?.hand?.name ?? equipped?.hand ?? null;
  if (handName) {
    parts.push(`tay cầm: ${handName}`);
  } else if (equipmentSlots != null || equipped != null) {
    parts.push('tay cầm: tay không');
  }

  if (Array.isArray(inventory) && inventory.length > 0) {
    const counts = new Map();
    for (const item of inventory) {
      if (!item?.name) continue;
      counts.set(item.name, (counts.get(item.name) ?? 0) + Number(item.count ?? 1));
    }
    const topItems = [...counts.entries()].slice(0, 6).map(([name, count]) => `${name}x${count}`);
    if (topItems.length > 0) {
      parts.push(`túi đồ: ${topItems.join(', ')}`);
    }
  }

  if (threat?.mobCount > 0) {
    parts.push(`cảnh báo quái gần: ${threat.mobCount} quái (${threat.posture || 'gần'})`);
  }

  const rec = scratchpad?.recovery;
  if (rec) {
    const recSteps = Array.isArray(rec.remainingSteps) && rec.remainingSteps.length > 0
      ? ` (cần làm lại: ${rec.remainingSteps.join(' -> ')})`
      : '';
    parts.push(`bộ nhớ tạm việc dở lần trước: "${rec.goal}"${recSteps}`);
  } else if (scratchpad?.manualNote) {
    parts.push(`ghi chú tạm: "${scratchpad.manualNote}"`);
  }

  const ownerStyle = stateSnapshot?.ownerStyle;
  if (ownerStyle?.self && ownerStyle?.you) {
    parts.push(`xưng hô đã quen: ${ownerStyle.self}/${ownerStyle.you}`);
  }

  return parts.join(', ');
}

export function buildWakePrompt(messages, stateSnapshot = null, { isNewConversation = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const lan = stateSnapshot?.lan ?? {};
  const worldParts = [];
  if (lan.worldName) worldParts.push(`thế giới '${lan.worldName}'`);
  if (lan.version) worldParts.push(`bản ${lan.version}`);
  if (lan.port) worldParts.push(`cổng ${lan.port}`);
  const worldInfo = worldParts.length > 0 ? ` (${worldParts.join(', ')})` : '';
  const owner = lan.owner || list.find((m) => m.username)?.username || 'chủ nhân';

  const itemsSummary = list
    .map((m) => {
      if (m.kind === 'alert') {
        return `[Cảnh báo ${m.alertType || 'system'}] ${m.message || ''}`.trim();
      }
      const prefix = m.viaWhisper ? '[whisper]' : '[chat]';
      return `${prefix} ${m.username || owner}: ${m.message || ''}`.trim();
    })
    .join(' ; ');

  const compactState = formatCompactStateSnapshot(stateSnapshot);
  const stateBlock = compactState ? ` [Trạng thái hiện tại: ${compactState}]` : '';

  const header = isNewConversation
    ? `[Minecraft Bot Bridge] Bắt đầu phiên điều khiển bot${worldInfo}.`
    : `[Minecraft Bot Bridge] Tin nhắn/cảnh báo mới từ game${worldInfo}:`;

  const toolHints = isNewConversation
    ? ' Tham số call_mcp_tool(ServerName="minecraft-bot"): mc_say({message, instant?, whisperTo?}), mc_command({command}), mc_get_nearby({radius?}), mc_run_macro({macro:"prepare_caving_kit"|"deposit_mining_loot", wait?}), mc_plan_execute({goal?, onDanger?, steps:[{type:"command"|"macro"|"smelt"|"say", ...}], wait?}), mc_smelt({action:"start"|"collect"|"status", target?, count?, force?}).'
    : '';

  const instructions = [
    'Hãy dùng MCP minecraft-bot để xử lý ngay:',
    compactState
      ? `1) TỐC ĐỘ NHANH NHẤT (1 LƯỢT): Đã có trạng thái trực tiếp ở trên nên KHÔNG cần gọi lại mc_get_state (chỉ gọi mc_get_nearby khi thật sự cần nhìn block/entity xung quanh); gọi ngay mc_say(message, instant=true) ở lượt đầu tiên, kết hợp song song mc_command / mc_run_macro / mc_plan_execute / mc_smelt nếu chủ nhân nhờ làm việc.${toolHints}`
      : `1) TỐC ĐỘ NHANH NHẤT (1 LƯỢT): Gọi ngay mc_say(message, instant=true) (và song song mc_get_state / mc_command / mc_plan_execute nếu cần thực hiện yêu cầu trong game).${toolHints}`,
    '2) GIAO TIẾP NHƯ NGƯỜI THẬT: Nói chuyện tự nhiên như bạn thân đang chơi Minecraft co-op cùng chủ nhân, ngắn gọn 1–2 câu đời thường, bắt chước cách xưng hô của người chơi (tui/ông, tui/bà, tui/bro hoặc mình/bạn), tuyệt đối KHÔNG xưng là AI/bot trợ lý, KHÔNG mở ngoặc báo cáo thông số kỹ thuật kiểu (máu 20/20, việc: rảnh), KHÔNG gạch đầu dòng. Nếu chủ nhân hỏi hoặc tán gẫu chuyện đời thường ngoài Minecraft, cứ trò chuyện đúng chủ đề đó như bạn thật ngoài đời, đừng ép lái sang chặt gỗ/đào mỏ.',
    '3) Không sửa code trong workspace trừ khi chủ nhân yêu cầu rõ.',
  ].join(' ');

  return `${header} ${itemsSummary}.${stateBlock} ${instructions}`.replace(/\s+/g, ' ').trim();
}

export async function defaultRunAgentApi({
  conversationId = null,
  model = DEFAULT_BOT_AGENT_MODEL,
  title = 'Minecraft Bot',
  prompt,
  dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
} = {}) {
  const sinceMs = Date.now();
  const eventsDir = dataDir ? path.resolve(dataDir, '..', 'events') : null;
  const safePrompt = String(prompt ?? '').replace(/[\r\n]+/g, ' ').trim();
  const safeTitle = String(title || 'Minecraft Bot').replace(/[\r\n"]+/g, ' ').trim();
  const safeModel = String(model || DEFAULT_BOT_AGENT_MODEL).replace(/[^a-zA-Z0-9._:-]/g, '').trim() || DEFAULT_BOT_AGENT_MODEL;
  const subArgs = conversationId
    ? ['send-message', String(conversationId), safePrompt]
    : ['new-conversation', `--model=${safeModel}`, `--title=${safeTitle}`, safePrompt];

  let stdout = '';
  let stderr = '';
  const agentApiExe = String(process.env.ANTIGRAVITY_AGENTAPI_EXE || '').trim();

  if (agentApiExe) {
    const res = await execFileAsync(agentApiExe, ['agentapi', ...subArgs], {
      timeout: 30000,
      windowsHide: true,
      encoding: 'utf8',
    });
    stdout = res.stdout ?? '';
    stderr = res.stderr ?? '';
  } else if (process.platform === 'win32') {
    // Fallback when ANTIGRAVITY_AGENTAPI_EXE is unset: agentapi.bat needs single-line Base64 via PowerShell.
    const batSafePrompt = safePrompt.replace(/"/g, "'");
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      '$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGY_PROMPT_B64))',
      'if ($env:AGY_CONV_ID) {',
      '  & agentapi send-message $env:AGY_CONV_ID $p',
      '} else {',
      '  & agentapi new-conversation "--model=$($env:AGY_MODEL)" "--title=$($env:AGY_TITLE)" $p',
      '}',
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    ].join('\n');

    const res = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        timeout: 30000,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGY_PROMPT_B64: Buffer.from(batSafePrompt, 'utf8').toString('base64'),
          AGY_CONV_ID: conversationId ? String(conversationId) : '',
          AGY_MODEL: safeModel,
          AGY_TITLE: safeTitle,
        },
      }
    );
    stdout = res.stdout ?? '';
    stderr = res.stderr ?? '';
  } else {
    const res = await execFileAsync('agentapi', subArgs, {
      timeout: 30000,
      encoding: 'utf8',
    });
    stdout = res.stdout ?? '';
    stderr = res.stderr ?? '';
  }

  const nextId = extractConversationId({ stdout, stderr, eventsDir, sinceMs }) || conversationId || null;
  console.log(`[bridge] agentapi (${safeModel}) -> conv=${nextId || 'unknown'}`);
  if (String(stderr).trim()) {
    console.error(`[bridge] agentapi stderr: ${String(stderr).trim()}`);
  }
  return { conversationId: nextId, model: safeModel, stdout, stderr };
}

export class AntigravityBridge {
  constructor({
    apiUrl = 'http://127.0.0.1:3000',
    authToken = null,
    model = process.env.BOT_AGENT_MODEL || DEFAULT_BOT_AGENT_MODEL,
    pollMs = 450,
    offlinePollMs = 3000,
    debounceMs = 180,
    recentStartupWindowMs = 60000,
    maxTurnsPerConversation = 45,
    fetchFn = globalThis.fetch,
    runAgentApi = defaultRunAgentApi,
    log = console.log,
    warn = console.warn,
    nowFn = () => Date.now(),
  } = {}) {
    this.apiUrl = String(apiUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.authToken = authToken ? String(authToken).trim() || null : null;
    this.model = String(model || DEFAULT_BOT_AGENT_MODEL).trim() || DEFAULT_BOT_AGENT_MODEL;
    this.pollMs = Math.max(100, Number(pollMs) || 450);
    this.offlinePollMs = Math.max(250, Number(offlinePollMs) || 3000);
    this.debounceMs = Math.max(0, Number(debounceMs) ?? 180);
    this.recentStartupWindowMs = Math.max(0, Number(recentStartupWindowMs) ?? 60000);
    this.maxTurnsPerConversation = Math.max(1, Number(maxTurnsPerConversation) || 45);
    this.fetchFn = fetchFn;
    this.runAgentApi = runAgentApi;
    this.log = log;
    this.warn = warn;
    this.nowFn = nowFn;

    this.initialized = false;
    this.lastSeenId = 0;
    this.gameSessionId = null;
    this.turnCount = 0;
    this.conversationId = null;
    this.stopped = false;
    this._pollTimer = null;
    this._debounceTimer = null;
    this._pendingMessages = [];
    this._flushing = false;
    this._online = false;
  }

  _headers() {
    if (!this.authToken) return {};
    return { Authorization: `Bearer ${this.authToken}` };
  }

  async _fetchJson(pathname) {
    const res = await this.fetchFn(`${this.apiUrl}${pathname}`, {
      method: 'GET',
      headers: this._headers(),
    });
    if (!res?.ok) {
      throw new Error(`HTTP ${res?.status ?? 'error'} ${pathname}`);
    }
    return await res.json();
  }

  _ingestMessages(inbox, { isInitial = false } = {}) {
    const latestId = Number(inbox?.latestId ?? 0);
    const messages = Array.isArray(inbox?.messages) ? inbox.messages : [];
    const now = this.nowFn();

    for (const msg of messages) {
      if (!shouldWakeAntigravity(msg)) continue;
      if (isInitial) {
        const msgTime = Number(msg.time ?? 0);
        if (!Number.isFinite(msgTime) || now - msgTime >= this.recentStartupWindowMs) {
          continue;
        }
      }
      this._pendingMessages.push(msg);
    }

    if (latestId > this.lastSeenId) {
      this.lastSeenId = latestId;
    }

    if (this._pendingMessages.length > 0) {
      this._scheduleFlush();
    }
  }

  _scheduleFlush() {
    if (this.stopped || this._flushing || this._pendingMessages.length === 0) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      void this._flush();
    }, this.debounceMs);
    this._debounceTimer.unref?.();
  }

  async _flush() {
    if (this.stopped || this._flushing || this._pendingMessages.length === 0) return;
    this._flushing = true;
    const batch = this._pendingMessages.splice(0, this._pendingMessages.length);

    try {
      const stateSnapshot = await this._fetchJson('/api/state').catch(() => null);
      if (stateSnapshot?.sessionId && this.gameSessionId && stateSnapshot.sessionId !== this.gameSessionId) {
        this.log(`[bridge] Phát hiện phiên mở game mới (${stateSnapshot.sessionId}), tạo phiên AI mới tinh.`);
        this.conversationId = null;
        this.turnCount = 0;
      }
      if (stateSnapshot?.sessionId) {
        this.gameSessionId = stateSnapshot.sessionId;
      }
      if (this.conversationId && this.turnCount >= this.maxTurnsPerConversation) {
        this.log(`[bridge] Đã đạt ${this.turnCount} lượt, tự làm mới phiên AI để giữ tốc độ tối ưu.`);
        this.conversationId = null;
        this.turnCount = 0;
      }
      const isNew = !this.conversationId;
      const prompt = buildWakePrompt(batch, stateSnapshot, { isNewConversation: isNew });

      try {
        const result = await this.runAgentApi({
          conversationId: this.conversationId,
          model: this.model,
          title: 'Minecraft Bot',
          prompt,
        });
        if (result?.conversationId) {
          this.conversationId = result.conversationId;
        }
        this.turnCount += 1;
      } catch (err) {
        if (this.conversationId) {
          this.warn(`[bridge] send-message lỗi (${err.message}), tạo cuộc trò chuyện mới...`);
          this.conversationId = null;
          this.turnCount = 0;
          const retryPrompt = buildWakePrompt(batch, stateSnapshot, { isNewConversation: true });
          const retryRes = await this.runAgentApi({
            conversationId: null,
            model: this.model,
            title: 'Minecraft Bot',
            prompt: retryPrompt,
          });
          if (retryRes?.conversationId) {
            this.conversationId = retryRes.conversationId;
          }
          this.turnCount = 1;
        } else {
          throw err;
        }
      }
    } catch (err) {
      this.warn(`[bridge] Không đánh thức được Antigravity: ${err.message}`);
    } finally {
      this._flushing = false;
      if (!this.stopped && this._pendingMessages.length > 0) {
        this._scheduleFlush();
      }
    }
  }

  async pollOnce() {
    let inbox;
    try {
      inbox = await this._fetchJson(`/api/inbox?sinceId=${this.lastSeenId}&limit=30&source=sidecar`);
    } catch {
      if (this._online) {
        this._online = false;
        this.log('[bridge] Bot tạm tắt, chuyển sang chế độ ngủ chờ...');
      }
      return false;
    }

    if (!this._online) {
      this._online = true;
      this.log(`[bridge] Đã kết nối API bot tại ${this.apiUrl}`);
    }

    if (inbox?.sessionId && this.gameSessionId && inbox.sessionId !== this.gameSessionId) {
      this.log(`[bridge] Phát hiện phiên mở game mới (${inbox.sessionId}), tạo phiên AI mới tinh.`);
      this.conversationId = null;
      this.turnCount = 0;
    }
    if (inbox?.sessionId) {
      this.gameSessionId = inbox.sessionId;
    }

    const latestId = Number(inbox?.latestId ?? 0);
    if (!this.initialized) {
      this.initialized = true;
      this._ingestMessages(inbox, { isInitial: true });
      return true;
    }

    if (latestId < this.lastSeenId) {
      this.log('[bridge] Phát hiện bot khởi động lại, reset mốc inbox và phiên chat.');
      this.lastSeenId = 0;
      this.conversationId = null;
      this.turnCount = 0;
      this._pendingMessages = [];
      try {
        const freshInbox = await this._fetchJson('/api/inbox?sinceId=0&limit=30&source=sidecar');
        this._ingestMessages(freshInbox, { isInitial: false });
      } catch {}
      return true;
    }

    this._ingestMessages(inbox, { isInitial: false });
    return true;
  }

  start() {
    if (this._pollTimer) return;
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      const online = await this.pollOnce();
      if (this.stopped) return;
      const delayMs = online ? this.pollMs : this.offlinePollMs;
      this._pollTimer = setTimeout(tick, delayMs);
      this._pollTimer.unref?.();
    };
    void tick();
  }

  status() {
    return {
      online: this._online,
      apiUrl: this.apiUrl,
      model: this.model,
      gameSessionId: this.gameSessionId,
      turnCount: this.turnCount,
      initialized: this.initialized,
      lastSeenId: this.lastSeenId,
      conversationId: this.conversationId,
      pendingCount: this._pendingMessages.length,
    };
  }

  stop() {
    this.stopped = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }
}

export default AntigravityBridge;
