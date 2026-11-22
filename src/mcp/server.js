import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

export const TOOLS = [
  {
    name: 'mc_get_state',
    description:
      'Lấy trạng thái hiện tại của bot Minecraft: kết nối, tọa độ, máu, thức ăn, trang bị, túi đồ, rương đã lập chỉ mục, các điểm POI, task đang chạy và log gần nhất.',
    inputSchema: {
      type: 'object',
      properties: {
        includeLogs: {
          type: 'boolean',
          description: 'Có kèm log gần đây không (mặc định true).',
        },
        logLimit: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Số dòng log cuối cùng trả về (mặc định 20).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mc_get_nearby',
    description:
      'Quét người chơi (gồm tọa độ chủ nhân), mob, vật phẩm rơi và các block đáng chú ý xung quanh bot (quặng, bàn chế tạo, lò nung, rương, giường, gỗ).',
    inputSchema: {
      type: 'object',
      properties: {
        radius: {
          type: 'number',
          minimum: 1,
          maximum: 64,
          description: 'Bán kính quét theo block (mặc định 24, tối đa 64).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mc_get_inbox',
    description:
      'Đọc tin nhắn chat/whisper từ người chơi trong Minecraft và các sự kiện quan trọng (spawn, death, kicked) mà bot ghi nhận.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceId: {
          type: 'integer',
          minimum: 0,
          description: 'Chỉ lấy các mục có id lớn hơn sinceId (mặc định 0).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Số mục tối đa trả về (mặc định 30).',
        },
        ownerOnly: {
          type: 'boolean',
          description: 'Chỉ lấy chat/whisper từ chủ nhân và sự kiện hệ thống (mặc định false).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mc_command',
    description: [
      'Gửi lệnh điều khiển trực tiếp cho bot Minecraft thực thi (hỗ trợ ghép nhiều bước bằng dấu `;`).',
      'Các lệnh chuẩn:',
      '- Khẩn cấp: `!stop` / `đứng đây`, `!come` / `lại đây`, `!home` / `về nhà`, `!follow` / `theo tôi`, `!cancel` / `hủy`, `!confirm` / `xác nhận`',
      '- Di chuyển: `theo tôi`, `đứng đây`, `lại đây`, `đi tới <x y z|tên_điểm>`, `lưu điểm <tên>`, `danh sách điểm`',
      '- Nhà & rương: `đây là nhà`, `đây là rương`, `về nhà`, `cất đồ`, `xem rương`, `lấy từ rương <sl> <đồ>`, `ngủ`, `nhặt đồ chết`',
      '- Tài nguyên & chế tạo: `lấy <sl> <đồ>` (vd: `lấy 16 gỗ`, `lấy 8 sắt`), `chế tạo <sl> <đồ>` (vd: `chế tạo 1 cuốc sắt`), `nung <sl> <đồ>`, `đào hầm [sl]`, `làm ruộng`, `đưa tôi <sl> <đồ>`',
      '- Sinh tồn & trang bị: `ăn`, `trang bị`, `trạng thái`, `dọn túi`, `bật đánh`, `tắt đánh`',
      '- Xây dựng & xác nhận: `tải mẫu <https-url> [tên]`, `dọn mặt bằng <file> [0|90|180|270]`, `xây <file> [0|90|180|270]`, `xác nhận`, `hủy`',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'Chuỗi lệnh gửi cho bot (tiếng Việt hoặc tiếng Anh).',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'mc_say',
    description: 'Cho bot nói chuyện trong khung chat Minecraft hoặc nhắn riêng (whisper) cho một người chơi.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'Nội dung tin nhắn cần gửi vào game.',
        },
        whisperTo: {
          type: 'string',
          minLength: 1,
          maxLength: 16,
          description: 'Tên người chơi nhận whisper (bỏ trống để chat công khai).',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'mc_control',
    description: 'Điều khiển khẩn cấp hoặc trạng thái AI của bot: tạm dừng/tiếp tục phản xạ AI, gọi về nhà khẩn, hoặc ngắt kết nối an toàn.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pause_ai', 'resume_ai', 'toggle_ai', 'recall_home', 'safe_disconnect'],
          description: 'Hành động điều khiển cần thực hiện.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'mc_inventory',
    description: 'Trang bị (equip) hoặc vứt bỏ (drop) một vật phẩm cụ thể trong túi đồ của bot.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['equip', 'drop'],
          description: 'Thao tác với vật phẩm.',
        },
        itemName: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Tên định danh vật phẩm Minecraft (vd: iron_sword, cobblestone).',
        },
        slot: {
          type: 'integer',
          description: 'Tùy chọn: số slot chính xác trong túi đồ.',
        },
      },
      required: ['action', 'itemName'],
      additionalProperties: false,
    },
  },
  {
    name: 'mc_connect',
    description: 'Kết nối hoặc chuyển bot sang cổng LAN / server Minecraft mới.',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'integer',
          minimum: 1,
          maximum: 65535,
          description: 'Cổng LAN hoặc server Minecraft (1-65535).',
        },
        host: {
          type: 'string',
          description: 'Địa chỉ host (mặc định localhost).',
        },
        owner: {
          type: 'string',
          maxLength: 16,
          description: 'Tên nhân vật chủ nhân nếu muốn đổi.',
        },
      },
      required: ['port'],
      additionalProperties: false,
    },
  },
  {
    name: 'mc_wait_event',
    description:
      'Chờ một sự kiện từ bot (nhiệm vụ hiện tại hoàn thành, có tin nhắn inbox mới, hoặc máu bot xuống thấp) rồi trả về tóm tắt trạng thái.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutSec: {
          type: 'number',
          minimum: 1,
          maximum: 45,
          description: 'Thời gian chờ tối đa bằng giây (mặc định 15, tối đa 45).',
        },
        waitFor: {
          type: 'string',
          enum: ['task_done', 'inbox', 'any'],
          description: 'Loại sự kiện muốn đợi (mặc định any).',
        },
        sinceInboxId: {
          type: 'integer',
          minimum: 0,
          description: 'Mốc ID inbox đã đọc trước đó; nếu có tin mới hơn sẽ trả về ngay.',
        },
        ownerOnly: {
          type: 'boolean',
          description: 'Chỉ đánh thức khi có chat/whisper từ chủ nhân hoặc sự kiện hệ thống (spawn/death/kicked), bỏ qua chat người lạ (mặc định true).',
        },
        unhandledOnly: {
          type: 'boolean',
          description: 'Tùy chọn: bỏ qua tin chat/whisper mà bot đã tự thực thi cục bộ (`handledByBot === true`, mặc định false).',
        },
      },
      additionalProperties: false,
    },
  },
];

function filterInboxMessages(messages = [], { ownerOnly = false, unhandledOnly = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  return list.filter((m) => {
    const isChat = m?.kind === 'chat' || m?.kind === 'whisper';
    if (!isChat) return true;
    if (ownerOnly && m.isOwner === false) return false;
    if (unhandledOnly && m.handledByBot === true) return false;
    return true;
  });
}

function compactState(state = {}) {
  return {
    connected: Boolean(state.connected),
    health: state.health ?? null,
    food: state.food ?? null,
    position: state.position ?? null,
    task: state.task ?? 'rảnh',
    aiPaused: Boolean(state.aiPaused),
    recentLogs: Array.isArray(state.logs) ? state.logs.slice(-5) : [],
  };
}

function isBotIdle(state = {}) {
  return !state.taskQueue?.active && (state.task == null || state.task === 'rảnh');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatHttpFailureMessage(err, baseUrl) {
  const raw = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code || '';
  const detail = causeCode && !raw.includes(causeCode) ? `${raw}: ${causeCode}` : raw;
  if (
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ENOTFOUND' ||
    /ECONNREFUSED|fetch failed|network/i.test(raw)
  ) {
    return `Không kết nối được tới API của bot tại ${baseUrl} (${detail}). Hãy khởi động bot trước (chạy run.bat hoặc \`node src/index.js --no-prompt\` trong thư mục bot/ với dashboard.enabled=true).`;
  }
  return detail;
}

export function createMcpHandler({
  baseUrl = process.env.BOT_API_URL || 'http://127.0.0.1:3000',
  token = process.env.BOT_API_TOKEN || process.env.DASHBOARD_TOKEN || '',
  fetchImpl = globalThis.fetch,
  pollIntervalMs = 1000,
} = {}) {
  const cleanBaseUrl = String(baseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const authToken = String(token || '').trim();
  const pollMs = Math.max(10, Number(pollIntervalMs) || 1000);

  async function requestJson(endpoint, { method = 'GET', body = undefined } = {}) {
    const headers = {};
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetchImpl(`${cleanBaseUrl}${endpoint}`, init);
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const detail = data?.error || data?.message || text || `HTTP ${res.status}`;
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return data ?? {};
  }

  async function callTool(name, args = {}) {
    const input = args && typeof args === 'object' ? args : {};

    switch (name) {
      case 'mc_get_state': {
        const state = await requestJson('/api/state');
        const includeLogs = input.includeLogs !== false;
        const result = { ...state };
        if (!includeLogs) {
          delete result.logs;
        } else if (Array.isArray(result.logs)) {
          const limit = input.logLimit == null
            ? 20
            : Math.max(0, Math.min(100, Math.floor(Number(input.logLimit) || 0)));
          result.logs = limit === 0 ? [] : result.logs.slice(-limit);
        }
        return result;
      }

      case 'mc_get_nearby': {
        const radius = input.radius == null
          ? 24
          : Math.max(1, Math.min(64, Number(input.radius) || 24));
        return await requestJson(`/api/nearby?radius=${encodeURIComponent(radius)}`);
      }

      case 'mc_get_inbox': {
        const sinceId = input.sinceId == null
          ? 0
          : Math.max(0, Math.floor(Number(input.sinceId) || 0));
        const limit = input.limit == null
          ? 30
          : Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 30)));
        const ownerOnly = Boolean(input.ownerOnly);
        const data = await requestJson(`/api/inbox?sinceId=${sinceId}&limit=${limit}`);
        if (!ownerOnly) return data;
        return {
          ...data,
          messages: filterInboxMessages(data.messages, { ownerOnly: true }),
        };
      }

      case 'mc_command': {
        const command = String(input.command ?? '').trim();
        if (!command) throw new Error('Thiếu tham số command');
        return await requestJson('/api/command', {
          method: 'POST',
          body: { command },
        });
      }

      case 'mc_say': {
        const message = String(input.message ?? '').trim();
        if (!message) throw new Error('Thiếu tham số message');
        const body = { message };
        if (input.whisperTo != null && String(input.whisperTo).trim()) {
          body.whisperTo = String(input.whisperTo).trim();
        }
        return await requestJson('/api/say', { method: 'POST', body });
      }

      case 'mc_control': {
        const action = String(input.action ?? '').trim();
        if (!action) throw new Error('Thiếu tham số action');
        return await requestJson('/api/control', {
          method: 'POST',
          body: { action },
        });
      }

      case 'mc_inventory': {
        const action = String(input.action ?? '').trim();
        const itemName = String(input.itemName ?? '').trim();
        if (!action || !itemName) throw new Error('Thiếu action hoặc itemName');
        const body = { action, itemName };
        if (input.slot != null) body.slot = Number(input.slot);
        return await requestJson('/api/inventory/action', { method: 'POST', body });
      }

      case 'mc_connect': {
        const port = Number(input.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error('Cổng port không hợp lệ (1-65535)');
        }
        const body = { port };
        if (input.host != null && String(input.host).trim()) {
          body.host = String(input.host).trim();
        }
        if (input.owner != null && String(input.owner).trim()) {
          body.owner = String(input.owner).trim();
        }
        return await requestJson('/api/connect', { method: 'POST', body });
      }

      case 'mc_wait_event': {
        const timeoutSec = input.timeoutSec == null
          ? 15
          : Math.max(1, Math.min(45, Number(input.timeoutSec) || 15));
        const waitFor = ['task_done', 'inbox', 'any'].includes(input.waitFor)
          ? input.waitFor
          : 'any';
        const ownerOnly = input.ownerOnly !== false;
        const unhandledOnly = Boolean(input.unhandledOnly);
        const hasExplicitSince = input.sinceInboxId != null && Number.isInteger(Number(input.sinceInboxId)) && Number(input.sinceInboxId) >= 0;

        const initialSince = hasExplicitSince ? Number(input.sinceInboxId) : 0;
        const [initState, initInbox] = await Promise.all([
          requestJson('/api/state'),
          requestJson(`/api/inbox?sinceId=${initialSince}&limit=30`),
        ]);

        let baselineInboxId = hasExplicitSince
          ? Number(input.sinceInboxId)
          : (initInbox.latestId ?? 0);

        if ((waitFor === 'inbox' || waitFor === 'any') && (initInbox.latestId ?? 0) > baselineInboxId) {
          const relevantInit = filterInboxMessages(initInbox.messages, { ownerOnly, unhandledOnly });
          if (relevantInit.length > 0) {
            return {
              reason: 'new_inbox',
              latestInboxId: initInbox.latestId ?? baselineInboxId,
              newMessages: relevantInit,
              state: compactState(initState),
            };
          }
          baselineInboxId = initInbox.latestId ?? baselineInboxId;
        }

        let seenActive = !isBotIdle(initState);
        if (waitFor === 'task_done' && !seenActive) {
          return {
            reason: 'task_done',
            latestInboxId: initInbox.latestId ?? baselineInboxId,
            newMessages: [],
            state: compactState(initState),
          };
        }

        const deadline = Date.now() + timeoutSec * 1000;
        let latestState = initState;
        let latestInbox = initInbox;

        while (Date.now() < deadline) {
          const waitMs = Math.min(pollMs, Math.max(1, deadline - Date.now()));
          await delay(waitMs);

          const [st, inb] = await Promise.all([
            requestJson('/api/state'),
            requestJson(`/api/inbox?sinceId=${baselineInboxId}&limit=30`),
          ]);
          latestState = st;
          latestInbox = inb;

          if ((waitFor === 'inbox' || waitFor === 'any') && (inb.latestId ?? 0) > baselineInboxId) {
            const relevant = filterInboxMessages(inb.messages, { ownerOnly, unhandledOnly });
            if (relevant.length > 0) {
              return {
                reason: 'new_inbox',
                latestInboxId: inb.latestId ?? baselineInboxId,
                newMessages: relevant,
                state: compactState(st),
              };
            }
            baselineInboxId = inb.latestId ?? baselineInboxId;
          }

          if (waitFor === 'any' && st.connected && typeof st.health === 'number' && st.health <= 8) {
            return {
              reason: 'low_health',
              latestInboxId: inb.latestId ?? baselineInboxId,
              newMessages: filterInboxMessages(inb.messages, { ownerOnly, unhandledOnly }),
              state: compactState(st),
            };
          }

          const idle = isBotIdle(st);
          if (!idle) seenActive = true;

          if (waitFor === 'task_done' && idle) {
            return {
              reason: 'task_done',
              latestInboxId: inb.latestId ?? baselineInboxId,
              newMessages: filterInboxMessages(inb.messages, { ownerOnly, unhandledOnly }),
              state: compactState(st),
            };
          }

          if (waitFor === 'any' && seenActive && idle) {
            return {
              reason: 'task_done',
              latestInboxId: inb.latestId ?? baselineInboxId,
              newMessages: filterInboxMessages(inb.messages, { ownerOnly, unhandledOnly }),
              state: compactState(st),
            };
          }
        }

        return {
          reason: 'timeout',
          latestInboxId: latestInbox.latestId ?? baselineInboxId,
          newMessages: filterInboxMessages(latestInbox.messages, { ownerOnly, unhandledOnly }),
          state: compactState(latestState),
        };
      }

      default:
        throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'UNKNOWN_TOOL' });
    }
  }

  return async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }

    const method = msg.method;
    const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined;

    if (!hasId || (typeof method === 'string' && method.startsWith('notifications/'))) {
      return null;
    }

    const id = msg.id;

    switch (method) {
      case 'initialize': {
        const clientVersion = msg.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(clientVersion)
          ? clientVersion
          : DEFAULT_PROTOCOL_VERSION;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: 'minecraft-bot',
              version: '1.0.0',
            },
          },
        };
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };

      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };

      case 'tools/call': {
        const toolName = msg.params?.name;
        const toolArgs = msg.params?.arguments ?? {};
        try {
          const data = await callTool(toolName, toolArgs);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(data, null, 2),
                },
              ],
            },
          };
        } catch (err) {
          if (err?.code === 'UNKNOWN_TOOL') {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: err.message },
            };
          }
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: formatHttpFailureMessage(err, cleanBaseUrl),
                },
              ],
              isError: true,
            },
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  };
}

export function startStdioServer(options = {}) {
  const handleMessage = createMcpHandler(options);
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const writeResponse = (payload) => {
    if (payload) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
  };

  const pending = new Set();

  rl.on('line', (line) => {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const task = Promise.resolve()
      .then(() => handleMessage(msg))
      .then(writeResponse)
      .catch((err) => {
        process.stderr.write(`[minecraft-bot-mcp] ${err?.stack || err}\n`);
        if (Object.hasOwn(msg ?? {}, 'id') && msg.id !== undefined) {
          writeResponse({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: err?.message || 'Internal error' },
          });
        }
      })
      .finally(() => pending.delete(task));

    pending.add(task);
  });

  rl.on('close', () => {
    Promise.allSettled([...pending]).then(() => {
      process.exit(0);
    });
  });

  return rl;
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  startStdioServer();
}
