export function normalizeText(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[đ]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export function textSimilarity(a, b) {
  const s1 = String(a ?? '');
  const s2 = String(b ?? '');
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(s1, s2) / maxLen;
}

const FUZZY_COMMAND_TABLE = [
  ['theo toi', { type: 'follow' }],
  ['dung day', { type: 'stay' }],
  ['lai day', { type: 'come' }],
  ['ve nha', { type: 'go_home' }],
  ['cat do', { type: 'store' }],
  ['xem ruong', { type: 'list_chests' }],
  ['lam ruong', { type: 'farm' }],
  ['trang bi', { type: 'gear' }],
  ['trang thai', { type: 'status' }],
  ['ngu', { type: 'sleep' }],
  ['an', { type: 'eat' }],
  ['don tui', { type: 'drop_junk' }],
  ['bat danh', { type: 'combat_on' }],
  ['tat danh', { type: 'combat_off' }],
  ['nhat do chet', { type: 'recover_death' }],
  ['danh sach diem', { type: 'list_waypoints' }],
  ['xac nhan', { type: 'confirm' }],
  ['huy', { type: 'cancel' }],
  ['giup', { type: 'help' }],
];

function parseCoords(rest) {
  const labeled = rest.match(/x\s*=?\s*(-?\d+)\s*[, ]+y\s*=?\s*(-?\d+)\s*[, ]+z\s*=?\s*(-?\d+)/i);
  if (labeled) {
    return { x: Number(labeled[1]), y: Number(labeled[2]), z: Number(labeled[3]) };
  }
  const plain = rest.match(/^(-?\d+)\s+(-?\d+)\s+(-?\d+)$/);
  if (plain) {
    return { x: Number(plain[1]), y: Number(plain[2]), z: Number(plain[3]) };
  }
  return null;
}

function parseCountAndTarget(rest, defaultCount = 16, { allowAll = false } = {}) {
  if (allowAll) {
    const allMatch = rest.match(/^(?:het|tat ca|toan bo|all)\s+(.+)$/);
    if (allMatch) {
      return { count: 'all', target: allMatch[1].trim() };
    }
  }
  const m = rest.match(/^(\d+)\s+(.+)$/);
  if (m) {
    return { count: Math.max(1, Math.min(256, Number(m[1]))), target: m[2].trim() };
  }
  return { count: defaultCount, target: rest.trim() };
}

function hasDeliverToOwnerPhrase(raw) {
  return /\b(?:cho toi|cho minh|cho tao|dem ve cho toi|mang cho toi|dua toi)\b/.test(normalizeText(raw));
}

const SYSTEM_NOTICE_RE = /^(?:đã chỉnh|đã đặt|đã dịch chuyển|đã cho|đã xóa|đã giết|đã triệu hồi|set the time|set own game mode|teleported|gave |changed the|changing to|weather |gamerule |killed |summoned |located )/i;

function isServerSystemNotice(raw) {
  const s = String(raw ?? '').trim();
  return !s || SYSTEM_NOTICE_RE.test(s) || /^\[.*\]$/.test(s) || /^[^[\]]+\]$/.test(s);
}

function cleanConversationalNorm(norm) {
  let out = String(norm ?? '').trim().replace(/[?!.,~]+$/g, '').trim();
  out = out
    .replace(/\bdc\b/g, 'duoc')
    .replace(/\b(?:j|ji)\b/g, 'gi')
    .replace(/\b(?:ko|k|kh)\b/g, 'khong')
    .replace(/\b(?:mik|mk)\b/g, 'minh')
    .replace(/\bvs\b/g, 'voi')
    .replace(/\bcx\b/g, 'cung')
    .replace(/\b(?:tks|thank|thanks)\b/g, 'cam on');
  const prefixRe = /^(?:e|alo|nay|bot oi|bot|ban oi|oi|hay|lam on|giup toi|giup minh|giup tao|ban(?=\s+(?:hay|giup|chat|lay|dao|hai|tim|che|lam|nung|nuong|dua|di|chay|ve|cat|ngu|theo|dung|lai|xay|don|an|bat|tat|xem)))\s+(?=.+)/;
  const suffixRe = /\s+(?:nhe|voi|nao|dum|gium|ho|cho toi|cho minh|cho tao|bot)$/;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(prefixRe, '').replace(suffixRe, '').replace(/[?!.,~]+$/g, '').trim();
    if (next === out) break;
    out = next;
  }
  out = out.replace(/(?<=\b(?:lay|che tao|lam|nung|nuong|dua|tim|dao|xay)\s+)(?:cho toi|cho minh|cho tao|dum|gium|ho)\s+/g, '');
  return out.trim();
}

function isBareDeliverPart(rawPart) {
  const norm = cleanConversationalNorm(normalizeText(rawPart));
  return ['dua', 'dua toi', 'dua het', 'dua toi het', 'dua cho toi', 'mang lai', 'mang ve', 'give'].includes(norm);
}

const PREFIX_EMERGENCY_COMMANDS = Object.freeze({
  '!stop': { type: 'stay' },
  '!stay': { type: 'stay' },
  '!dung': { type: 'stay' },
  '!come': { type: 'come' },
  '!lai': { type: 'come' },
  '!home': { type: 'go_home' },
  '!ve': { type: 'go_home' },
  '!follow': { type: 'follow' },
  '!theo': { type: 'follow' },
  '!cancel': { type: 'cancel' },
  '!huy': { type: 'cancel' },
  '!confirm': { type: 'confirm' },
  '!xacnhan': { type: 'confirm' },
  '!eat': { type: 'eat' },
  '!an': { type: 'eat' },
  '!status': { type: 'status' },
  '!help': { type: 'help' },
});

const NEGATION_ACTION_VERBS = '(?:co|can|muon|phai|duoc|dao|chat|lay|di|theo|danh|xay|lam|nung|nuong|che|cat|dua|vut|an|ngu|nua|ve|chay|hoi)';

export function hasNegationPhrase(rawMessage) {
  const rawLower = String(rawMessage ?? '').trim().toLowerCase();
  if (!rawLower) return false;
  if (/(?:^|\s)đừng(?=\s|$)/i.test(rawLower)) return true;

  const norm = normalizeText(rawLower)
    .replace(/\b(?:ko|k|kh)\b/g, 'khong')
    .replace(/\bdc\b/g, 'duoc');

  if (/\b(?:don't|dont|do not|never|stop\s+(?:mining|digging|chopping|building|following|attacking))\b/.test(norm)) {
    return true;
  }
  if (/\b(?:dung|thoi|bo|ngung|nghi|chua|cam)\s+/.test(norm)) {
    const dungVerb = new RegExp(`\\bdung\\s+${NEGATION_ACTION_VERBS}\\b`);
    if (dungVerb.test(norm) || /\b(?:thoi|ngung|nghi)\s+(?:khong|dung|dao|chat|lay|di|theo|danh|xay|lam|nung|nuong|che|nua)\b/.test(norm)) {
      return true;
    }
    if (/\b(?:bo|chua)\s+(?:di|lam|dao|chat|xay|can)\b/.test(norm)) {
      return true;
    }
  }
  const khongVerb = new RegExp(`\\bkhong\\s+${NEGATION_ACTION_VERBS}\\b`);
  if (khongVerb.test(norm)) return true;
  return false;
}

export class CommandRouter {
  parse(rawMessage) {
    const raw = String(rawMessage ?? '').trim();
    if (!raw || isServerSystemNotice(raw)) return null;
    if (raw.startsWith('!')) {
      const prefixNorm = normalizeText(raw);
      const emergency = PREFIX_EMERGENCY_COMMANDS[prefixNorm];
      if (emergency) return { ...emergency };
      return { type: 'unknown', raw };
    }
    const norm = cleanConversationalNorm(normalizeText(raw));
    if (!norm) return null;
    const negated = hasNegationPhrase(raw);

    if (!negated && ['chao', 'xin chao', 'hello', 'hi', 'alo', 'ban khoe khong', 'bot khoe khong', 'on khong'].includes(norm)) {
      return { type: 'greet' };
    }
    if (!negated && ['cam on', 'ok cam on', 'oke cam on', 'okay cam on', 'ok', 'oke', 'okay', 'tot lam', 'gioi lam', 'hay lam', 'ngon', 'duoc roi'].includes(norm)) {
      return { type: 'ack' };
    }
    if (!negated && ['tui do', 'xem tui', 'xem do', 'trong tui co gi', 'trong nguoi co gi', 'co do gi', 'inv', 'inventory'].includes(norm)) {
      return { type: 'inventory' };
    }
    if (!negated && /\b(?:lam duoc gi|biet lam gi|lam gi duoc|co the lam gi|chuc nang|co lenh gi|lenh gi|huong dan)\b/.test(norm)) {
      return { type: 'help' };
    }
    if (!negated && /\b(?:dang lam gi|o dau|dang o dau|toa do|vi tri|bao nhieu mau|con mau khong|doi khong)\b/.test(norm)) {
      return { type: 'status' };
    }

    if (norm === 'theo toi' || norm === 'follow me' || norm === 'follow' || norm === 'tt') {
      return { type: 'follow' };
    }
    if (norm === 'dung day' || norm === 'dung yen' || norm === 'dung' || norm === 'stay' || norm === 'stop') {
      return { type: 'stay' };
    }
    if (norm === 'lai day' || norm === 'come' || norm === 'here') {
      return { type: 'come' };
    }
    if (norm === 'day la nha' || norm === 'set home' || norm === 'sethome') {
      return { type: 'set_home' };
    }
    if (norm === 'day la ruong' || norm === 'set chest' || norm === 'ruong nha') {
      return { type: 'set_chest' };
    }
    if (norm === 've nha' || norm === 'go home' || norm === 'home') {
      return { type: 'go_home' };
    }
    if (norm === 'cat do' || norm === 'store') {
      return { type: 'store' };
    }
    if (norm === 'xem ruong' || norm === 'trong ruong co gi' || norm === 'chests') {
      return { type: 'list_chests' };
    }
    if (norm === 'ngu' || norm === 'sleep') {
      return { type: 'sleep' };
    }
    if (norm === 'nhat do chet' || norm === 'nhat do' || norm === 'recover') {
      return { type: 'recover_death' };
    }
    if (norm === 'lam ruong' || norm === 'thu hoach' || norm === 'farm') {
      return { type: 'farm' };
    }
    if (norm === 'bat web' || norm === 'dashboard' || norm === 'dashboard on') {
      return { type: 'dashboard_on' };
    }
    if (norm === 'tat web' || norm === 'dashboard off') {
      return { type: 'dashboard_off' };
    }
    if (norm === 'trang bi' || norm === 'gear') {
      return { type: 'gear' };
    }
    if (['tat danh', 'ngung danh', 'hoa binh', 'peaceful', 'combat off'].includes(norm)) {
      return { type: 'combat_off' };
    }
    if (['bat danh', 'chien dau', 'tu ve', 'combat on'].includes(norm)) {
      return { type: 'combat_on' };
    }
    if (['an', 'an di', 'eat'].includes(norm)) {
      return { type: 'eat' };
    }
    if (['don tui', 'vut do dom', 'vut rac', 'drop junk'].includes(norm)) {
      return { type: 'drop_junk' };
    }
    if (norm === 'trang thai' || norm === 'status') {
      return { type: 'status' };
    }
    if (norm === 'giup' || norm === 'help' || norm === '?') {
      return { type: 'help' };
    }
    if (norm === 'danh sach diem' || norm === 'waypoints') {
      return { type: 'list_waypoints' };
    }
    if (norm === 'xac nhan' || norm === 'confirm') {
      return { type: 'confirm' };
    }
    if (norm === 'huy' || norm === 'cancel') {
      return { type: 'cancel' };
    }
    if (norm === 'chay toi do' || norm === 'go there') {
      return { type: 'goto_missing' };
    }

    if (norm === 'dao ham' || norm === 'tunnel') {
      return { type: 'tunnel', length: 16 };
    }
    const tunnelMatch = norm.match(/^(?:dao ham|tunnel)\s+(\d+)(?:\s*(?:block|o))?$/);
    if (tunnelMatch) {
      return { type: 'tunnel', length: Math.max(1, Math.min(128, Number(tunnelMatch[1]))) };
    }

    for (const prefix of ['luu diem ', 'save ']) {
      if (norm.startsWith(prefix)) {
        const name = norm.slice(prefix.length).trim();
        if (name) return { type: 'save_waypoint', name };
      }
    }

    for (const prefix of ['di toi ', 'chay toi ', 'goto ']) {
      if (norm.startsWith(prefix)) {
        const rest = norm.slice(prefix.length).trim();
        const coords = parseCoords(rest);
        if (coords) return { type: 'goto', ...coords };
        if (rest) return { type: 'goto_waypoint', name: rest };
      }
    }

    // Check chest retrieval BEFORE generic "lay "
    for (const prefix of ['lay tu ruong ', 'rut ruong ', 'take ']) {
      if (norm.startsWith(prefix)) {
        const rest = norm.slice(prefix.length).trim();
        if (!rest) break;
        const { count, target } = parseCountAndTarget(rest, 1);
        if (target) return { type: 'take_from_chest', count, target };
      }
    }

    for (const prefix of ['che tao ', 'lam ', 'craft ']) {
      if (norm.startsWith(prefix)) {
        const rest = norm.slice(prefix.length).trim();
        if (!rest) break;
        const { count, target } = parseCountAndTarget(rest, 1);
        if (target) return { type: 'craft', count, target };
      }
    }

    for (const prefix of ['nung ', 'nuong ', 'smelt ']) {
      if (norm.startsWith(prefix)) {
        const rest = norm.slice(prefix.length).trim();
        if (!rest) break;
        const { count, target } = parseCountAndTarget(rest, 1);
        if (target) return { type: 'smelt', count, target };
      }
    }

    for (const prefix of ['lay ', 'tim kiem ', 'tim ', 'chat ', 'dao ', 'hai ', 'gather ', 'mine ']) {
      if (norm.startsWith(prefix)) {
        const rest = norm.slice(prefix.length).trim();
        if (!rest) break;
        const { count, target } = parseCountAndTarget(rest, 16);
        if (target) return { type: 'gather', count, target };
      }
    }

    for (const prefix of ['dua toi ', 'dua ', 'give ']) {
      if (norm.startsWith(prefix)) {
        const rest = norm.slice(prefix.length).trim();
        if (!rest) break;
        const { count, target } = parseCountAndTarget(rest, 1, { allowAll: true });
        if (target) return { type: 'give', count, target };
      }
    }

    const downloadMatch = raw.match(/^(?:tải mẫu|tai mau|download)\s+(\S+)(?:\s+(\S+))?$/i);
    if (downloadMatch) {
      return {
        type: 'download_schematic',
        url: downloadMatch[1],
        filename: downloadMatch[2] ?? null,
      };
    }

    const prepareMatch = raw.match(/^(?:dọn mặt bằng|don mat bang|prepare)\s+(\S+)(?:\s+(0|90|180|270))?$/i);
    if (prepareMatch) {
      return {
        type: 'prepare',
        file: prepareMatch[1],
        rotation: prepareMatch[2] ? Number(prepareMatch[2]) : 0,
      };
    }

    const buildMatch = raw.match(/^(?:xây|xay|build)\s+(\S+)(?:\s+(0|90|180|270))?$/i);
    if (buildMatch) {
      return {
        type: 'build',
        file: buildMatch[1],
        rotation: buildMatch[2] ? Number(buildMatch[2]) : 0,
      };
    }

    return { type: 'unknown', raw };
  }

  parseChain(rawMessage) {
    const raw = String(rawMessage ?? '').trim();
    if (!raw || isServerSystemNotice(raw)) return null;
    const hasExplicitSep = raw.includes(';') || raw.includes('->');
    const parts = raw
      .split(/\s*(?:;|->|(?<=^|\s)(?:xong rồi|xong roi|sau đó|sau do|rồi|roi)(?=\s|$))\s*/i)
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length <= 1) {
      const single = this.parse(raw);
      if (single?.type === 'gather' && hasDeliverToOwnerPhrase(raw)) {
        return {
          type: 'chain',
          steps: [single, { type: 'give', count: 'all', target: single.target }],
        };
      }
      return single;
    }

    const steps = [];
    for (const p of parts.slice(0, 5)) {
      if (isBareDeliverPart(p) && steps.length > 0) {
        const prev = steps[steps.length - 1];
        if (prev?.target && ['gather', 'craft', 'smelt', 'take_from_chest'].includes(prev.type)) {
          steps.push({
            type: 'give',
            count: prev.type === 'gather' ? 'all' : (prev.count ?? 'all'),
            target: prev.target,
          });
          continue;
        }
      }
      const parsed = this.parse(p);
      if (parsed) steps.push(parsed);
    }

    if (steps.length <= 1) return steps[0] ?? null;
    if (!hasExplicitSep && !steps.every(s => s.type !== 'unknown')) {
      return this.parse(raw);
    }
    return { type: 'chain', steps };
  }

  route(rawMessage, { minConfidence = 0.75 } = {}) {
    const start = performance.now();
    const parsed = this.parseChain(rawMessage);
    if (!parsed) return null;

    if (parsed.type !== 'unknown') {
      return {
        command: parsed,
        confidence: 1.0,
        tier: 'exact',
        latencyMs: Number((performance.now() - start).toFixed(3)),
      };
    }

    const raw = String(rawMessage ?? '').trim();
    const norm = cleanConversationalNorm(normalizeText(raw));
    const words = norm ? norm.split(' ') : [];
    const hasClauseOrQuestion =
      /[?;]/.test(raw) ||
      raw.includes('->') ||
      hasNegationPhrase(raw) ||
      /\b(?:neu|khi nao|nen|de xuat|tai sao|vi sao)\b/.test(norm);

    if (norm && words.length <= 4 && !hasClauseOrQuestion) {
      let bestScore = 0;
      let bestCmd = null;
      for (const [phrase, cmd] of FUZZY_COMMAND_TABLE) {
        const score = textSimilarity(norm, phrase);
        if (score > bestScore) {
          bestScore = score;
          bestCmd = cmd;
        }
      }
      if (bestCmd && bestScore >= minConfidence) {
        return {
          command: { ...bestCmd },
          confidence: Number(bestScore.toFixed(3)),
          tier: 'fuzzy',
          latencyMs: Number((performance.now() - start).toFixed(3)),
        };
      }
    }

    return {
      command: parsed,
      confidence: 0,
      tier: 'llm_needed',
      latencyMs: Number((performance.now() - start).toFixed(3)),
    };
  }

  helpText() {
    return 'Lệnh: theo tôi, đứng đây, lại đây, đi tới <x y z|điểm>, lưu điểm <tên>, đây là nhà, đây là rương, về nhà, cất đồ, xem rương, lấy từ rương <sl> <đồ>, ngủ, ăn, nhặt đồ chết, lấy <sl> <đồ>, chế tạo <sl> <đồ>, nung <sl> <đồ>, đào hầm [sl], làm ruộng, đưa tôi <sl> <đồ>, bật/tắt đánh, dọn túi, bật web, dọn mặt bằng <file>, xây <file>, trang bị, trạng thái.';
  }
}

export default CommandRouter;
