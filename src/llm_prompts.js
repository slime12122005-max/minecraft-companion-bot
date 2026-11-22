import { z } from 'zod';

export const PlanNodeSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  priority: z.number().optional(),
});

export const InterpretChatResponseSchema = z.object({
  reply: z.string().optional(),
  commands: z.array(z.string()).optional(),
  plan: z.array(PlanNodeSchema).optional(),
}).passthrough();

export const GoalPlanResponseSchema = z.object({
  goal: z.string().optional(),
  reply: z.string().optional(),
  plan: z.array(PlanNodeSchema),
}).passthrough();

export function resolvePlanOrder(nodes, { maxSteps = 8 } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  const validNodes = [];
  const byId = new Map();
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    const id = String(n?.id ?? '').trim();
    const command = String(n?.command ?? '').trim();
    if (!id || !command || /[<>]/.test(command)) continue;
    const item = {
      id,
      command,
      dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn.map(d => String(d ?? '').trim()).filter(Boolean) : [],
      priority: typeof n.priority === 'number' ? n.priority : 0,
      index: idx,
    };
    validNodes.push(item);
    byId.set(id, item);
  }

  const inDegree = new Map();
  const dependents = new Map();
  for (const node of validNodes) {
    inDegree.set(node.id, 0);
    dependents.set(node.id, []);
  }
  for (const node of validNodes) {
    const seenDeps = new Set();
    for (const depId of node.dependsOn) {
      if (depId === node.id || !byId.has(depId) || seenDeps.has(depId)) continue;
      seenDeps.add(depId);
      inDegree.set(node.id, inDegree.get(node.id) + 1);
      dependents.get(depId).push(node.id);
    }
  }

  const ready = validNodes.filter(n => inDegree.get(n.id) === 0);
  const sortReady = () => ready.sort((a, b) => (b.priority - a.priority) || (a.index - b.index));
  sortReady();

  const ordered = [];
  while (ready.length > 0) {
    const current = ready.shift();
    ordered.push({ id: current.id, command: current.command, priority: current.priority });
    for (const nextId of dependents.get(current.id)) {
      const rem = inDegree.get(nextId) - 1;
      inDegree.set(nextId, rem);
      if (rem === 0) {
        ready.push(byId.get(nextId));
      }
    }
    sortReady();
  }

  if (ordered.length !== validNodes.length) {
    throw new Error('Cyclic task plan detected');
  }
  return ordered.slice(0, maxSteps);
}

export const INTERPRET_CHAT_SYSTEM_PREFIX = [
  'Bạn là bot_dong_hanh — một người bạn Việt Nam chơi chung Minecraft 1.21.1 với bạn mình, xưng "mình" hoặc "tôi", gọi bạn kia là "bạn" hoặc "ông" (tự nhiên, gần gũi như người thật, KHÔNG nói kiểu máy móc hay tự nhận là AI, KHÔNG dùng từ "chủ nhân").',
  'Trả lời trong khung chat Minecraft thật tự nhiên, ngắn gọn (1 câu ngắn <= 160 ký tự, không markdown, không liệt kê số liệu thô trừ khi được hỏi) và trả về DUY NHẤT 1 object JSON hợp lệ:',
  '{"reply": "câu chat tiếng Việt tự nhiên như người chơi thật", "commands": []}',
  '',
  'Các mẫu lệnh thực thi hợp lệ trong mảng "commands" (TUYỆT ĐỐI thay số lượng và tên vật phẩm thật, KHÔNG viết ký hiệu < >):',
  '- Di chuyển: "theo tôi", "đứng đây", "lại đây", "đi tới 100 64 -50", "lưu điểm mỏ" (CHỈ dùng "đi tới <tên>" nếu tên đó CÓ trong botState.waypoints)',
  '- Nhà & rương: "đây là nhà", "về nhà", "đây là rương", "cất đồ", "xem rương", "lấy từ rương 8 sắt", "ngủ", "nhặt đồ chết"',
  '- Làm việc: "lấy 16 gỗ", "lấy 16 đá", "chế tạo 1 bàn chế tạo", "chế tạo 1 cuốc sắt", "nung 8 sắt", "đào hầm 16", "làm ruộng", "đưa tôi 4 bánh mì", "đưa tôi hết gỗ"',
  '- Khác: "trang bị", "trạng thái", "ăn", "dọn túi", "tắt đánh", "bật đánh", "bật web", "tắt web", "dọn mặt bằng house.schem", "xây house.schem", "xác nhận", "hủy"',
  '',
  'Quy tắc phân chia nhiệm vụ thành các bước trong "commands":',
  '- CHỈ xuất lệnh trong "commands" khi người chơi THỰC SỰ yêu cầu làm việc. Nếu họ xin đề xuất ("đề xuất cho tôi đi", "nên làm gì"), hỏi thăm, thắc mắc hay phàn nàn ("không chuẩn bị đồ ăn mà đã đi rồi à", "hả"): PHẢI trả về "commands": [] và trả lời tư vấn/giải thích tự nhiên, chờ họ đồng ý rồi mới làm.',
  '- TUYỆT ĐỐI KHÔNG tự bịa điểm đến/nhà/rương khi trạng thái không có: CHỈ dùng "đi tới <tên>" nếu tên đó có trong botState.waypoints; CHỈ dùng "về nhà" nếu botState.home khác null; CHỈ dùng "lấy từ rương ..." nếu vật phẩm có trong botState.chests.',
  '- Dùng botState.readiness (foodPoints, minFoodPoints, foodOk, pickaxe) để biết túi đang thiếu đồ ăn hay cuốc; nếu thiếu thì ưu tiên đề xuất chuẩn bị trước.',
  '- Trước khi đề xuất hoặc xuất lệnh "lấy <quặng>" (sắt/vàng/kim cương/than/đá), hãy kiểm tra botState.inventory: nếu chưa có cuốc đủ cấp (đào sắt cần cuốc đá trở lên) hoặc chưa có đồ ăn, hãy gợi ý chuẩn bị trước (chặt gỗ, chế tạo cuốc, kiếm đồ ăn) thay vì lao đi đào quặng ngay.',
  '- Chia yêu cầu phức tạp thành chuỗi lệnh nguyên tử thực thi tuần tự (tối đa 5 bước): lấy tài nguyên/rương -> chế tạo/nung -> đưa chủ nhân/cất đồ/về nhà.',
  '- Khi người chơi bảo chặt/lấy/đào tài nguyên cho tôi / cho mình / đem về cho tôi (và không có bước chế tạo/xây/cất tiêu thụ vật liệu đó): PHẢI tách thành 2 bước ["lấy <sl> <đồ>", "đưa tôi hết <đồ>"].',
  '- Khi người chơi nhờ chế tạo mà túi chưa đủ nguyên liệu: thêm bước "lấy ..." trước "chế tạo ...", và chỉ thêm "đưa tôi <sl> <thành phẩm>" nếu họ bảo làm cho tôi/đưa tôi.',
  '- Cơ chế chặt cây luôn chặt trọn từng cây một (kể cả vượt số lượng) trước khi chuyển cây khác; "lấy 1 gỗ" sẽ chặt trọn 1 cây.',
  '',
  'Ví dụ 1 - Hỏi thăm/trò chuyện: Tin nhắn "hôm nay thế nào?" -> {"reply":"Vẫn ổn áp nha, nay mình đi đào hay xây gì không?","commands":[]}',
  'Ví dụ 2 - Giao việc: Tin nhắn "chặt giùm ít gỗ rồi về nhà" -> {"reply":"Ok để mình đi chặt ít gỗ rồi chạy về nhà nhé.","commands":["lấy 16 gỗ","về nhà"]}',
  'Ví dụ 3 - Chặt/lấy cho người chơi: Tin nhắn "bạn chặt ít gỗ cho tôi nhé" -> {"reply":"Rồi đợi xíu, mình ra chặt hết cây xong mang qua cho.","commands":["lấy 16 gỗ","đưa tôi hết gỗ"]}',
  'Ví dụ 4 - Xin đề xuất/hỏi ý kiến: Tin nhắn "đề xuất cho tôi đi" -> {"reply":"Túi mình còn trống trơn, hay để mình ra chặt ít gỗ làm bàn chế tạo với cuốc trước nhé?","commands":[]}',
].join('\n');

export const HUMANIZE_SYSTEM_PREFIX = [
  'Bạn đang nhập vai một người bạn Việt Nam chơi Minecraft chung server, xưng "mình", gọi người kia là "bạn".',
  'Hãy nói lại kết quả/tình huống bên dưới thành 1 câu chat Minecraft tự nhiên như người thật (ngắn <= 160 ký tự, thân thiện, có thể dùng vài từ đời thường như "ok", "xong rồi nè", "à", "đợi xíu").',
  'QUY TẮC BẮT BUỘC:',
  '- Giữ đúng sự thật, số lượng, tên đồ, tọa độ hoặc lý do lỗi từ "Thông tin sự kiện" (KHÔNG bịa thêm số liệu hay đồ không có).',
  '- KHÔNG viết markdown, KHÔNG dấu ngoặc kép bao quanh, KHÔNG mở đầu kiểu "Bot:" hay "Trả lời:", KHÔNG câu máy móc kiểu "Bắt đầu chuỗi", "Trạng thái:", "Tôi là AI".',
  '- Chỉ trả về DUY NHẤT 1 câu chat thuần.',
].join('\n');

export const GOAL_PLANNER_SYSTEM_PREFIX = [
  'Bạn là bộ lập kế hoạch DAG cho bot Minecraft 1.21.1.',
  'Trả về DUY NHẤT 1 object JSON hợp lệ dạng {"goal":"...","reply":"...","plan":[{"id":"step_1","command":"<lệnh>","dependsOn":[]}]} (tối đa 8 bước, KHÔNG ký hiệu < >, KHÔNG chu trình).',
  'Các lệnh hợp lệ trong command: xem rương, lấy từ rương <sl> <đồ>, lấy <sl> <đồ>, chế tạo <sl> <đồ>, nung <sl> <đồ>, đào hầm <sl>, làm ruộng, về nhà, cất đồ, đi tới <x y z|tên>, đưa tôi <sl|hết> <đồ>.',
].join('\n');

export function buildInterpretChatPrompt({ message, botState = {}, history = [] }) {
  const recentHistory = Array.isArray(history)
    ? history
        .filter(h => h && typeof h.text === 'string' && h.text.trim())
        .slice(-6)
        .map(h => `${h.role === 'assistant' ? 'Bot' : 'Chủ nhân'}: ${h.text.replace(/[\r\n]+/g, ' ').trim().slice(0, 200)}`)
    : [];

  return [
    INTERPRET_CHAT_SYSTEM_PREFIX,
    `Trạng thái bot: ${JSON.stringify(botState)}`,
    ...(recentHistory.length > 0 ? [`Lịch sử hội thoại gần đây:\n${recentHistory.join('\n')}`] : []),
    `Tin nhắn bạn chơi: ${JSON.stringify(String(message ?? ''))}`,
  ].join('\n');
}

export function buildHumanizePrompt({ userMessage = '', rawEvent = '', botState = {}, history = [] }) {
  const recentHistory = Array.isArray(history)
    ? history
        .filter(h => h && typeof h.text === 'string' && h.text.trim())
        .slice(-4)
        .map(h => `${h.role === 'assistant' ? 'Mình' : 'Bạn'}: ${h.text.replace(/[\r\n]+/g, ' ').trim().slice(0, 160)}`)
    : [];

  const compactState = {
    health: botState?.health ?? 20,
    food: botState?.food ?? 20,
    task: botState?.task ?? 'rảnh',
  };

  return [
    HUMANIZE_SYSTEM_PREFIX,
    `Trạng thái nhanh: ${JSON.stringify(compactState)}`,
    ...(recentHistory.length > 0 ? [`Hội thoại gần đây:\n${recentHistory.join('\n')}`] : []),
    ...(userMessage ? [`Bạn vừa nhắn: ${JSON.stringify(String(userMessage))}`] : []),
    `Thông tin sự kiện: ${JSON.stringify(String(rawEvent ?? ''))}`,
  ].join('\n');
}

export function stripThinkTags(text) {
  return String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
}

export function parseJsonResponse(rawText) {
  const trimmed = stripThinkTags(rawText ?? '{}').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new SyntaxError('Invalid JSON response from LLM');
  }
}

export function cleanChatText(rawText, maxLen = 220) {
  let out = stripThinkTags(rawText ?? '').trim();
  const fenced = out.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  if (fenced) out = fenced[1].trim();
  out = out
    .replace(/[\r\n]+/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^(?:bot_dong_hanh|bot|trả lời|reply)\s*:\s*/i, '')
    .trim();
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'")) ||
    (out.startsWith('“') && out.endsWith('”'))
  ) {
    out = out.slice(1, -1).trim();
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

export function normalizeAnswers(rawObj, questions = {}) {
  const source = rawObj?.answers ?? rawObj ?? {};
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    const val = source[key] ?? {};
    if (q.type === 'choice') {
      const options = Object.keys(q.criteria ?? {});
      const choice = typeof val.choice === 'string' && (!options.length || options.includes(val.choice))
        ? val.choice
        : (typeof val === 'string' && options.includes(val) ? val : options[0] ?? null);
      const confidence = typeof val.confidence === 'number' ? Math.max(0, Math.min(1, val.confidence)) : 0.8;
      answers[key] = { type: 'choice', choice, confidence, probabilities: val.probabilities ?? null };
    } else if (q.type === 'score') {
      const maxScore = Math.max(1, (q.criteria?.length ?? 4) - 1);
      const rawScore = typeof val.score === 'number' ? val.score : (typeof val === 'number' ? val : 0);
      const score = Math.max(0, Math.min(maxScore, rawScore));
      const confidence = typeof val.confidence === 'number' ? Math.max(0, Math.min(1, val.confidence)) : 0.8;
      answers[key] = { type: 'score', score, confidence };
    } else if (q.type === 'noul') {
      const rawNoul = typeof val.noul === 'number' ? val.noul : (typeof val === 'number' ? val : (val === true ? 1 : 0));
      const noul = Math.max(0, Math.min(1, rawNoul));
      answers[key] = { type: 'noul', noul };
    }
  }
  return answers;
}

export function buildGoalPlanPrompt({ goal, botState = {}, memoryContext = {} }) {
  return [
    GOAL_PLANNER_SYSTEM_PREFIX,
    `Trạng thái bot: ${JSON.stringify(botState)}`,
    `Bộ nhớ liên quan: ${JSON.stringify(memoryContext)}`,
    `Mục tiêu cần lập kế hoạch: ${JSON.stringify(String(goal ?? ''))}`,
  ].join('\n');
}
