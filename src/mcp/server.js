import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseServerAddress } from '../session/lan_discovery.js';

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
      'Đọc tin nhắn chat/whisper từ người chơi trong Minecraft, các sự kiện hệ thống (spawn, death, kicked) và cảnh báo chủ động (alert: combat_danger, stuck, rare_ore, low_durability, low_food, low_health).',
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
        instant: {
          type: 'boolean',
          description: 'Bỏ qua mô phỏng độ trễ gõ phím cho câu cảnh báo khẩn cấp (mặc định false).',
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
    description: 'Kết nối hoặc chuyển bot sang cổng LAN / domain e4mc / server Minecraft mới (hỗ trợ nhập domain *.e4mc.link không cần cổng, mặc định 25565).',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'integer',
          minimum: 1,
          maximum: 65535,
          description: 'Cổng LAN hoặc server Minecraft (1-65535). Có thể bỏ trống nếu đã truyền host (mặc định 25565).',
        },
        host: {
          type: 'string',
          description: 'Địa chỉ host hoặc domain e4mc (vd: localhost, happy-panda.sg.e4mc.link, hoặc host:port).',
        },
        owner: {
          type: 'string',
          maxLength: 16,
          description: 'Tên nhân vật chủ nhân nếu muốn đổi.',
        },
        version: {
          type: 'string',
          maxLength: 32,
          description: 'Phiên bản Minecraft (vd: 1.21.1, 1.20.1, hoặc auto để tự nhận diện).',
        },
        auth: {
          type: 'string',
          enum: ['offline', 'microsoft'],
          description: 'Chế độ đăng nhập: offline (mặc định) hoặc microsoft (cần khi e4mc/server bật Online Mode).',
        },
      },
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
          enum: ['task_done', 'inbox', 'alert', 'any'],
          description: 'Loại sự kiện muốn đợi (mặc định any; dùng alert để bắt cảnh báo từ Jev/Watchdog/hệ thống như combat_danger, stuck, rare_ore, low_durability, low_food, low_health).',
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
  {
    name: 'mc_run_macro',
    description: 'Chạy quy trình kỹ năng gộp (macro) sinh tồn nhiều bước trong 1 lần gọi: chuẩn bị đồ đi hang hoặc về nhà cất quặng/thu lò.',
    inputSchema: {
      type: 'object',
      properties: {
        macro: {
          type: 'string',
          enum: ['prepare_caving_kit', 'deposit_mining_loot'],
          description: 'Tên macro cần thực thi.',
        },
        wait: {
          type: 'boolean',
          description: 'Chờ hoàn thành toàn bộ macro trước khi trả kết quả (mặc định true; đặt false để nhận ACCEPTED ngay).',
        },
      },
      required: ['macro'],
      additionalProperties: false,
    },
  },
  {
    name: 'mc_plan_execute',
    description: 'Antigravity lập kế hoạch và phân chia thành chuỗi bước (command / macro / smelt / say) để bot thực thi tuần tự.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'Mục tiêu tổng thể của kế hoạch (vd: đi đào 20 sắt và cất kho).',
        },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          description: 'Danh sách các bước tuần tự.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['command', 'macro', 'smelt', 'say'] },
              command: { type: 'string' },
              macro: { type: 'string', enum: ['prepare_caving_kit', 'deposit_mining_loot'] },
              action: { type: 'string', enum: ['start', 'collect'] },
              target: { type: 'string' },
              count: { type: 'integer', minimum: 1 },
              force: { type: 'boolean' },
              message: { type: 'string' },
              whisperTo: { type: 'string' },
            },
            required: ['type'],
            additionalProperties: false,
          },
        },
        onDanger: {
          type: 'string',
          enum: ['pause_and_resume', 'abort_and_notify'],
          description: 'Hành xử khi gặp nguy hiểm: tạm dừng để Jev tự vệ rồi làm tiếp, hoặc hủy và báo về Antigravity.',
        },
        wait: {
          type: 'boolean',
          description: 'Chờ thực thi xong toàn bộ kế hoạch (mặc định true; đặt false để nhận ACCEPTED ngay và theo dõi qua mc_wait_event).',
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'mc_smelt',
    description: 'Điều khiển lò nung bất đồng bộ: nạp phôi vào lò (start), thu hoạch thành phẩm (collect), hoặc xem các lò đang nung (status).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'collect', 'status'],
          description: 'Thao tác lò nung.',
        },
        target: {
          type: 'string',
          description: 'Tên nguyên liệu cần nung khi action=start (vd: sắt, vàng, thịt, cát).',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 64,
          description: 'Số lượng cần nạp khi action=start (mặc định 1).',
        },
        force: {
          type: 'boolean',
          description: 'Khi action=collect: ép thu lò ngay cả khi chưa hết thời gian dự kiến.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'mc_scratchpad',
    description: 'Đọc, lưu, chạy tiếp hoặc xóa bộ nhớ tạm các việc đang làm dở (chống mất tiến độ khi tắt máy đột xuất; tự xóa khi làm xong hoặc khi chủ nhân bảo bỏ).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'resume', 'clear'],
          description: 'Thao tác bộ nhớ tạm: get (xem), set (ghi tạm), resume (làm tiếp việc cũ), clear (xóa bỏ).',
        },
        goal: {
          type: 'string',
          description: 'Tên/mục tiêu công việc cần nhớ tạm khi action=set.',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Danh sách các bước cần làm lại khi action=set.',
        },
        note: {
          type: 'string',
          description: 'Ghi chú ngắn thêm khi action=set.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'mc_open_dev_tab',
    description: 'Xếp hàng vào 1 tab Orchestrator duy nhất (Gemini 4 Carbon High, chạy lần lượt từng việc, có cooldown và tự xóa khi xong) để thêm JS local hoặc sửa lỗi bot. Gọi action="complete" khi tab Orchestrator làm xong.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'complete'],
          description: 'Mặc định open để xếp hàng mở/gửi vào tab Orchestrator duy nhất; đặt complete khi tab Orchestrator đã sửa & test xong việc hiện tại.',
        },
        status: {
          type: 'string',
          enum: ['passed', 'failed'],
          description: 'Dùng cùng action="complete" để báo kết quả kiểm tra (passed = tự xóa tab khi hết hàng đợi, failed = giữ tab để xem lỗi).',
        },
        kind: {
          type: 'string',
          enum: ['add_local_js', 'fix_bug'],
          description: 'Loại tác vụ dev: add_local_js (thêm xử lý JS local cho câu hỏi/lệnh đơn giản) hoặc fix_bug (sửa lỗi bot).',
        },
        title: {
          type: 'string',
          minLength: 3,
          maxLength: 140,
          description: 'Tiêu đề ngắn gọn cho tác vụ dev.',
        },
        summary: {
          type: 'string',
          minLength: 5,
          maxLength: 1200,
          description: 'Mô tả rõ hành vi cần thêm vào JS, lỗi đang gặp hoặc kết quả hoàn thành.',
        },
        userPhrase: {
          type: 'string',
          maxLength: 300,
          description: 'Tùy chọn: câu nói gốc của người chơi dẫn tới ý tưởng/lỗi này.',
        },
        errorDetail: {
          type: 'string',
          maxLength: 600,
          description: 'Tùy chọn: chi tiết log lỗi hoặc triệu chứng quan sát được.',
        },
        targetFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tùy chọn: các file nguồn liên quan trong bot/src (vd: ["src/commands.js", "src/companion.js"]).',
        },
      },
      required: [],
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
        if (input.instant != null) {
          body.instant = Boolean(input.instant);
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
        const rawHost = input.host != null ? String(input.host).trim() : '';
        const hasPort = input.port != null && String(input.port).trim() !== '';
        if (!hasPort && !rawHost) {
          throw new Error('Cần truyền port hoặc host (vd: xxxx.e4mc.link)');
        }
        const parsedAddr = rawHost ? parseServerAddress(rawHost, { defaultPort: 25565 }) : null;
        if (rawHost && (!parsedAddr || !parsedAddr.host)) {
          throw new Error('Host không hợp lệ');
        }
        let port;
        if (hasPort) {
          port = Number(input.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('Cổng port không hợp lệ (1-65535)');
          }
          if (parsedAddr?.isE4mc && parsedAddr.explicitPort) {
            port = parsedAddr.port;
          }
        } else {
          port = parsedAddr.port;
        }
        const body = { port };
        if (parsedAddr?.host) {
          body.host = parsedAddr.host;
        }
        if (input.owner != null && String(input.owner).trim()) {
          body.owner = String(input.owner).trim();
        }
        if (input.version != null && String(input.version).trim()) {
          body.version = String(input.version).trim();
        }
        if (input.auth != null) {
          const authMode = String(input.auth).trim().toLowerCase();
          if (authMode === 'offline' || authMode === 'microsoft') {
            body.auth = authMode;
          }
        }
        return await requestJson('/api/connect', { method: 'POST', body });
      }

      case 'mc_wait_event': {
        const timeoutSec = input.timeoutSec == null
          ? 15
          : Math.max(1, Math.min(45, Number(input.timeoutSec) || 15));
        const waitFor = ['task_done', 'inbox', 'alert', 'any'].includes(input.waitFor)
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

        if ((waitFor === 'inbox' || waitFor === 'alert' || waitFor === 'any') && (initInbox.latestId ?? 0) > baselineInboxId) {
          const relevantInit = filterInboxMessages(initInbox.messages, { ownerOnly, unhandledOnly });
          const alertsInit = relevantInit.filter(m => m.kind === 'alert');
          if (alertsInit.length > 0 && (waitFor === 'alert' || waitFor === 'any')) {
            return {
              reason: 'alert',
              latestInboxId: initInbox.latestId ?? baselineInboxId,
              newMessages: alertsInit,
              state: compactState(initState),
            };
          }
          if (waitFor !== 'alert' && relevantInit.length > 0) {
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

          if ((waitFor === 'inbox' || waitFor === 'alert' || waitFor === 'any') && (inb.latestId ?? 0) > baselineInboxId) {
            const relevant = filterInboxMessages(inb.messages, { ownerOnly, unhandledOnly });
            const alerts = relevant.filter(m => m.kind === 'alert');
            if (alerts.length > 0 && (waitFor === 'alert' || waitFor === 'any')) {
              return {
                reason: 'alert',
                latestInboxId: inb.latestId ?? baselineInboxId,
                newMessages: alerts,
                state: compactState(st),
              };
            }
            if (waitFor !== 'alert' && relevant.length > 0) {
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

      case 'mc_run_macro': {
        const macro = String(input.macro ?? '').trim();
        if (!macro) throw new Error('Thiếu tham số macro');
        const wait = input.wait !== false;
        return await requestJson('/api/macro', {
          method: 'POST',
          body: { macro, wait },
        });
      }

      case 'mc_plan_execute': {
        if (!Array.isArray(input.steps) || input.steps.length === 0) {
          throw new Error('Thiếu danh sách steps');
        }
        const body = {
          goal: String(input.goal ?? '').trim(),
          steps: input.steps,
          onDanger: input.onDanger === 'abort_and_notify' ? 'abort_and_notify' : 'pause_and_resume',
          wait: input.wait !== false,
        };
        return await requestJson('/api/plan', { method: 'POST', body });
      }

      case 'mc_smelt': {
        const action = String(input.action ?? 'status').trim();
        const body = { action };
        if (input.target != null) body.target = String(input.target).trim();
        if (input.count != null) body.count = Number(input.count);
        if (input.force != null) body.force = Boolean(input.force);
        return await requestJson('/api/smelt', { method: 'POST', body });
      }

      case 'mc_scratchpad': {
        const action = String(input.action ?? 'get').trim();
        if (action === 'get') {
          return await requestJson('/api/scratchpad');
        }
        const body = { action };
        if (input.goal != null) body.goal = String(input.goal).trim();
        if (Array.isArray(input.steps)) body.steps = input.steps.map(s => String(s ?? '').trim()).filter(Boolean);
        if (input.note != null) body.note = String(input.note).trim();
        return await requestJson('/api/scratchpad', { method: 'POST', body });
      }

      case 'mc_open_dev_tab': {
        const action = input.action === 'complete' ? 'complete' : 'open';
        if (action === 'complete') {
          const body = {
            action: 'complete',
            status: input.status === 'failed' ? 'failed' : 'passed',
            summary: String(input.summary ?? 'completed').trim() || 'completed',
          };
          if (input.title != null) body.title = String(input.title).trim();
          return await requestJson('/api/dev-tab', { method: 'POST', body });
        }
        const title = String(input.title ?? '').trim();
        const summary = String(input.summary ?? '').trim();
        if (!title || !summary) throw new Error('Thiếu title hoặc summary cho mc_open_dev_tab');
        const body = {
          action: 'open',
          kind: input.kind === 'fix_bug' ? 'fix_bug' : 'add_local_js',
          title,
          summary,
        };
        if (input.userPhrase != null) body.userPhrase = String(input.userPhrase).trim();
        if (input.errorDetail != null) body.errorDetail = String(input.errorDetail).trim();
        if (Array.isArray(input.targetFiles)) {
          body.targetFiles = input.targetFiles.map(f => String(f ?? '').trim()).filter(Boolean);
        }
        return await requestJson('/api/dev-tab', { method: 'POST', body });
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
