import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { normalizeText } from './commands.js';
import { summarizeReadiness, foodSupply, bestPickTier } from './readiness.js';
import { HAZARD_BLOCKS } from './combat/threat_assessment.js';
import { TASK_TIERS } from './tasks.js';

const PASSIVE_ANIMALS = new Set([
  'pig', 'cow', 'sheep', 'chicken', 'wolf', 'cat', 'horse', 'rabbit', 'fox', 'villager', 'mooshroom', 'llama',
]);

const IDLE_BLOCKED_SURFACES = new Set([
  ...HAZARD_BLOCKS,
  'water',
  'flowing_water',
  'bubble_column',
  'powder_snow',
]);

const JEV_CHAT_INTENT_QUESTIONS = Object.freeze({
  intent: {
    type: 'choice',
    instructions: 'Phân loại câu chat tự nhiên của người chơi Minecraft xem có yêu cầu hành động cụ thể không, hay chỉ là trò chuyện bình thường.',
    criteria: {
      chat_casual: 'Chỉ trò chuyện, hỏi thăm, trêu đùa hoặc bình luận bình thường.',
      follow: 'Muốn bot đi theo hoặc hộ tống bảo vệ.',
      come: 'Gọi bot chạy lại gần người chơi.',
      stay: 'Bảo bot đứng yên tại chỗ chờ.',
      gather_wood: 'Muốn bot đi chặt cây hoặc lấy gỗ.',
      gather_stone: 'Muốn bot đi đào đá hoặc cuội.',
      gather_iron: 'Muốn bot đi đào quặng sắt.',
      farm: 'Muốn bot thu hoạch hoặc trồng trọt ruộng.',
      farm_enderman: 'Muốn bot dựng mái che và nhìn mắt dụ đánh Enderman kiếm ngọc Ender.',
      go_home: 'Muốn bot quay về nhà.',
      status: 'Hỏi cụ thể chỉ số trang bị / túi đồ / trạng thái kỹ thuật.',
    },
  },
});

const ACTION_INTENT_SPECS = Object.freeze({
  follow: { buildReply: ({ self, you }) => `Ok ${self} đi sát theo canh chừng cho ${you} liền!`, command: { type: 'follow' } },
  come: { buildReply: ({ you }) => `Đang chạy qua chỗ ${you} liền đây!`, command: { type: 'come' } },
  stay: { buildReply: ({ self }) => `Ok ${self} đứng chờ ngay đây nha!`, command: { type: 'stay' } },
  gather_wood: { buildReply: ({ self }) => `Ok để ${self} chạy đi chặt ít gỗ quanh đây cho!`, command: { type: 'gather', count: 16, target: 'gỗ' } },
  gather_stone: { buildReply: ({ self }) => `Để ${self} đi đập ít đá về cho nha!`, command: { type: 'gather', count: 16, target: 'đá' } },
  gather_coal: { buildReply: ({ self }) => `Để ${self} đảo quanh kiếm ít than nha!`, command: { type: 'gather', count: 16, target: 'than' } },
  gather_iron: { buildReply: ({ self }) => `Ok ${self} đi kiếm quặng sắt liền đây!`, command: { type: 'gather', count: 8, target: 'sắt' } },
  farm: { buildReply: ({ self }) => `Để ${self} qua coi với làm lại ruộng cho nha!`, command: { type: 'farm' } },
  farm_enderman: { buildReply: ({ self }) => `Ok để ${self} kiếm gốc cây núp hoặc đặt mái 3x3 trên đầu rồi nhìn mắt dụ Enderman tới nha!`, command: { type: 'farm_enderman', count: 8, countMode: 'kills' } },
  go_home: { buildReply: ({ self }) => `Ok ${self} quay về nhà đây!`, command: { type: 'go_home' } },
  status: { buildReply: ({ self, you }) => `Để ${self} ngó lại đồ đạc rồi báo ${you} nha.`, command: { type: 'status' } },
});

function capFirst(text) {
  const s = String(text ?? '');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function normalizeSlang(message) {
  return normalizeText(message)
    .replace(/\b(?:ko|k|kh|hong|hok)\b/g, 'khong')
    .replace(/\bdc\b/g, 'duoc')
    .replace(/\b(?:j|ji)\b/g, 'gi')
    .replace(/\b(?:mik|mk)\b/g, 'minh')
    .replace(/\bvs\b/g, 'voi')
    .replace(/\btrc\b/g, 'truoc')
    .replace(/\bbh\b/g, 'bay gio')
    .replace(/\bcx\b/g, 'cung')
    .replace(/\bbt\b/g, 'biet')
    .replace(/\bwa\b/g, 'qua')
    .replace(/\b(?:oke|okie|uk|uhm|uh)\b/g, 'ok');
}

function detectPronounsFromText(rawMessage) {
  const rawLower = String(rawMessage ?? '').toLowerCase();
  const norm = normalizeText(rawMessage);
  if (/(?:^|\s)bà(?:\s|[?!.,]|$)/i.test(rawLower)) {
    return { self: 'tui', you: 'bà' };
  }
  if (/\bbro\b/.test(norm)) {
    return { self: 'tui', you: 'bro' };
  }
  if (/\bfen\b/.test(norm)) {
    return { self: 'tui', you: 'fen' };
  }
  if (/\b(?:tui|ong|may|tao)\b/.test(norm)) {
    return { self: 'tui', you: 'ông' };
  }
  if (/\b(?:minh|ban|cau|to)\b/.test(norm)) {
    return { self: 'mình', you: 'bạn' };
  }
  return null;
}

function formatTaskActivity(activeTask, { self, you }) {
  const Self = capFirst(self);
  const map = {
    theo_chu: `${Self} đang đi sát theo canh chừng cho ${you} nè`,
    lay_tai_nguyen: `${Self} đang chạy đi gom ít tài nguyên về`,
    dao_ham: `${Self} đang lụi cụi đào hầm kiếm quặng nè`,
    lam_ruong: `${Self} đang thu hoạch với trồng lại ruộng`,
    farm_enderman: `${Self} đang đứng dưới mái che nhìn mắt dụ Enderman tới chém nè`,
    che_tao: `${Self} đang đứng chế đồ xíu`,
    nung_do: `${Self} đang trông lò nung đồ nè`,
    ve_nha: `${Self} đang cuốc bộ về nhà`,
    xay_dung: `${Self} đang cặm cụi xây tiếp công trình`,
    don_mat_bang: `${Self} đang dọn cho phẳng mặt bằng nè`,
    nhat_do_chet: `${Self} đang chạy đi hốt lại đồ bị rơi`,
    chuoi_nhiem_vu: `${Self} đang làm nốt mấy việc ${you} mới dặn`,
    tu_farm_go: `${Self} đang tranh thủ lúc rảnh chạy ra chặt ít gỗ tích trữ nè`,
    tu_farm_da: `${Self} đang tranh thủ đào ít đá cuội dự phòng nè`,
    tu_farm_than: `${Self} đang tranh thủ đào ít than lộ thiên quanh đây nè`,
    tu_farm_sat: `${Self} đang tranh thủ đào quặng sắt quanh đây nè`,
    tu_farm_quang_quy: `${Self} đang tranh thủ đào quặng quý vừa thấy quanh đây nè`,
    cat_do_tu_dong: `${Self} đang chạy về cất bớt đồ dư vô rương nhà cho rộng túi nè`,
  };
  if (activeTask === 'rảnh') {
    return null;
  }
  return map[activeTask] ?? `${Self} đang làm dở việc ${activeTask} nè`;
}

const STRUCTURE_EXACT_NAMES = new Set([
  'crafting_table', 'furnace', 'blast_furnace', 'smoker',
  'chest', 'trapped_chest', 'barrel', 'ender_chest',
  'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil',
  'bricks', 'cobblestone_wall', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks',
  'glass', 'glass_pane', 'farmland', 'dirt_path',
]);

const STRUCTURE_SUFFIXES = [
  '_planks', '_stairs', '_slab', '_door', '_trapdoor', '_fence', '_fence_gate',
  '_bed', '_glass', '_glass_pane', '_wool', '_carpet', '_concrete',
];

const NATURAL_LOG_NAMES = [
  'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log',
  'jungle_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
  'crimson_stem', 'warped_stem',
];

function isPlayerStructureBlockName(name) {
  const lower = String(name ?? '').toLowerCase();
  if (!lower) return false;
  if (STRUCTURE_EXACT_NAMES.has(lower)) return true;
  return STRUCTURE_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

function isNearProtectedPoint(pos, refPos, radius) {
  if (!pos || !refPos) return false;
  return Math.hypot(pos.x - refPos.x, pos.y - refPos.y, pos.z - refPos.z) <= radius;
}

/**
 * Finds a nearby natural tree trunk to harvest when idle without touching player structures or bases.
 */
export function findSafeIdleTreeTarget(bot, { maxDistance = 28, homePos = null, chestPos = null } = {}) {
  if (!bot || typeof bot.findBlocks !== 'function' || typeof bot.blockAt !== 'function') return null;
  const blocksByName = bot.registry?.blocksByName ?? {};
  const logIds = NATURAL_LOG_NAMES.map(n => blocksByName[n]?.id).filter(Boolean);
  if (logIds.length === 0) return null;

  const positions = bot.findBlocks({ matching: logIds, maxDistance, count: 24 }) ?? [];
  for (const p of positions) {
    if (homePos && isNearProtectedPoint(p, homePos, 7)) continue;
    if (chestPos && isNearProtectedPoint(p, chestPos, 7)) continue;

    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    const pz = Math.floor(p.z);

    let nearStructure = false;
    for (let dx = -1; dx <= 1 && !nearStructure; dx++) {
      for (let dy = -1; dy <= 1 && !nearStructure; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const nb = bot.blockAt(new Vec3(px + dx, py + dy, pz + dz));
          const nName = String(nb?.name ?? '').toLowerCase();
          if (isPlayerStructureBlockName(nName) || nName === 'cobblestone') {
            nearStructure = true;
            break;
          }
        }
      }
    }
    if (nearStructure) continue;

    let canopyCount = 0;
    for (let dy = 1; dy <= 8 && canopyCount < 2; dy++) {
      for (let dx = -2; dx <= 2 && canopyCount < 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const cb = bot.blockAt(new Vec3(px + dx, py + dy, pz + dz));
          const cName = String(cb?.name ?? '').toLowerCase();
          if (cName.endsWith('_leaves') || cName.endsWith('_wart_block')) {
            canopyCount++;
            if (canopyCount >= 2) break;
          }
        }
      }
    }
    if (canopyCount < 2) continue;

    const blk = bot.blockAt(p);
    if (blk && blk.type !== 0) return blk;
  }
  return null;
}

/**
 * Finds an exposed mineral or stone block away from water, lava, and optional player structures.
 */
export function findSafeIdleMineralTarget(
  bot,
  candidateNames,
  {
    maxDistance = 24,
    homePos = null,
    chestPos = null,
    protectHomeRadius = 0,
    checkStructureNeighbors = false,
    requireExposed = true,
    maxDepthBelowBot = null,
  } = {}
) {
  if (!bot || typeof bot.findBlocks !== 'function' || typeof bot.blockAt !== 'function') return null;
  const blocksByName = bot.registry?.blocksByName ?? {};
  const ids = (candidateNames ?? []).map(n => blocksByName[n]?.id).filter(Boolean);
  if (ids.length === 0) return null;

  const botY = bot.entity?.position?.y;
  const positions = bot.findBlocks({ matching: ids, maxDistance, count: 24 }) ?? [];
  for (const p of positions) {
    if (protectHomeRadius > 0) {
      if (homePos && isNearProtectedPoint(p, homePos, protectHomeRadius)) continue;
      if (chestPos && isNearProtectedPoint(p, chestPos, protectHomeRadius)) continue;
    }

    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    const pz = Math.floor(p.z);
    if (maxDepthBelowBot != null && typeof botY === 'number' && (botY - py) > maxDepthBelowBot) {
      continue;
    }

    let unsafe = false;
    let hasExposedFace = false;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nb = bot.blockAt(new Vec3(px + dx, py + dy, pz + dz));
      const nName = String(nb?.name ?? '').toLowerCase();
      if (
        !nb ||
        nb.type === 0 ||
        nName === 'air' ||
        nName === 'cave_air' ||
        nName === 'void_air' ||
        nb.boundingBox === 'empty' ||
        (Array.isArray(nb.shapes) && nb.shapes.length === 0)
      ) {
        hasExposedFace = true;
      }
      if (!nName) continue;
      if (nName.includes('lava') || nName.includes('water')) {
        unsafe = true;
        break;
      }
      if (checkStructureNeighbors && (isPlayerStructureBlockName(nName) || nName === 'cobblestone')) {
        unsafe = true;
        break;
      }
    }
    if (unsafe || (requireExposed && !hasExposedFace)) continue;

    const blk = bot.blockAt(p);
    if (blk && blk.type !== 0) return blk;
  }
  return null;
}

export function isSafeIdleSpot(bot, point) {
  if (typeof bot?.blockAt !== 'function' || !point) return false;
  const bx = Math.floor(point.x);
  const by = Math.floor(point.y);
  const bz = Math.floor(point.z);
  const below = bot.blockAt(new Vec3(bx, by - 1, bz));
  const feet = bot.blockAt(new Vec3(bx, by, bz));
  const head = bot.blockAt(new Vec3(bx, by + 1, bz));
  if (!below || !feet || !head) return false;

  const belowName = String(below.name ?? '').toLowerCase();
  const feetName = String(feet.name ?? '').toLowerCase();
  const headName = String(head.name ?? '').toLowerCase();

  if (below.boundingBox !== 'block' || IDLE_BLOCKED_SURFACES.has(belowName)) return false;
  if (feet.boundingBox === 'block' || IDLE_BLOCKED_SURFACES.has(feetName)) return false;
  if (head.boundingBox === 'block' || IDLE_BLOCKED_SURFACES.has(headName)) return false;
  return true;
}

function findSafeOffsetSpot(bot, origin, targetDist, angles) {
  if (!origin) return null;
  for (const angle of angles) {
    for (const dy of [0, 1, -1]) {
      const cand = new Vec3(
        Math.floor(origin.x + Math.cos(angle) * targetDist) + 0.5,
        Math.floor(origin.y) + dy,
        Math.floor(origin.z + Math.sin(angle) * targetDist) + 0.5
      );
      if (isSafeIdleSpot(bot, cand)) return cand;
    }
  }
  return null;
}

export class CompanionManager {
  constructor(ctx, { enabledChat = true, enabledIdle = false } = {}) {
    this.ctx = ctx;
    this.enabledChat = enabledChat;
    this.enabledIdle = enabledIdle;
    this.disposed = false;

    this._lastVariantIdx = new Map();
    this._pronounStyle = null;
    this._chatTimer = null;
    this._lastAmbientChatAt = 0;
    this._lastAutoFarmChatAt = 0;
    this._lastDuskDay = -1;
    this._lastSelfCareAt = 0;
    this._lastAutoUpgradeAt = 0;
    this._upgradeFailCooldown = new Map();
    this._lastAutonomyAt = 0;
    this._lastBaseCheckAt = 0;
    this._autonomyFailCooldown = new Map();
    this._recentOpenDoors = new Map();
    this._doorCloseCooldown = new Map();
    this._lastStepBackAt = 0;
    this._lastPickupAt = 0;
    this._nextWanderAt = 0;
    this._escortingOwner = false;
  }

  getOwnerPronounStyle(ownerName = this.ctx?.config?.owner) {
    if (this._pronounStyle) return this._pronounStyle;
    const name = ownerName ? String(ownerName) : null;
    const mem = this.ctx?.memory;
    if (name && mem?.getPlayerProfile) {
      try {
        const profile = mem.getPlayerProfile(name);
        const match = profile?.interactionSummary?.match(/xưng hô:\s*([^/\s,;]+)\s*\/\s*([^\s,;]+)/i);
        if (match) {
          this._pronounStyle = { self: match[1], you: match[2] };
          return this._pronounStyle;
        }
      } catch {}
    }
    return null;
  }

  _persistPronounStyle(style) {
    if (!style?.self || !style?.you) return;
    const ownerName = this.ctx?.config?.owner;
    const mem = this.ctx?.memory;
    if (!ownerName || !mem?.upsertPlayerProfile) return;
    try {
      const existing = mem.getPlayerProfile?.(ownerName);
      const tag = `xưng hô: ${style.self}/${style.you}`;
      const prevSummary = existing?.interactionSummary ? String(existing.interactionSummary) : '';
      const cleaned = prevSummary
        .replace(/xưng hô:\s*[^/\s,;]+\s*\/\s*[^\s,;]+/i, '')
        .replace(/^[;\s]+|[;\s]+$/g, '');
      const nextSummary = cleaned ? `${tag}; ${cleaned}` : tag;
      mem.upsertPlayerProfile(ownerName, {
        role: existing?.role ?? 'owner',
        interactionSummary: nextSummary,
        lastSeenAt: Date.now(),
      });
    } catch {}
  }

  _pick(key, variants) {
    if (!Array.isArray(variants) || variants.length === 0) return '';
    if (variants.length === 1) return variants[0];
    const prev = this._lastVariantIdx.get(key) ?? -1;
    let idx = Math.floor(Math.random() * variants.length);
    if (idx === prev) idx = (idx + 1) % variants.length;
    this._lastVariantIdx.set(key, idx);
    return variants[idx];
  }

  _resolvePronouns(rawMessage) {
    const direct = detectPronounsFromText(rawMessage);
    if (direct) {
      this._pronounStyle = direct;
      this._persistPronounStyle(direct);
      return direct;
    }
    const saved = this.getOwnerPronounStyle();
    if (saved) return saved;

    const history = Array.isArray(this.ctx?.chatHistory) ? this.ctx.chatHistory : [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role !== 'user') continue;
      const detected = detectPronounsFromText(history[i].text);
      if (detected) {
        this._pronounStyle = detected;
        this._persistPronounStyle(detected);
        return detected;
      }
    }
    return { self: 'mình', you: 'bạn' };
  }

  _formatActionIntent(intentKey, pronouns) {
    const spec = ACTION_INTENT_SPECS[intentKey];
    if (!spec) return null;
    return { reply: spec.buildReply(pronouns), command: spec.command };
  }

  _lastAssistantSuggestionTarget() {
    const history = Array.isArray(this.ctx?.chatHistory) ? this.ctx.chatHistory : [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role !== 'assistant') continue;
      const normPrev = normalizeText(history[i].text);
      if (/\bgo\b/.test(normPrev) && /\b(?:chat|lay|kiem)\b/.test(normPrev)) return 'gather_wood';
      if (/\bsat\b/.test(normPrev) && /\b(?:dao|kiem)\b/.test(normPrev)) return 'gather_iron';
      if (/\bda\b/.test(normPrev) && /\b(?:dao|kiem)\b/.test(normPrev)) return 'gather_stone';
      if (/\bruong\b/.test(normPrev)) return 'farm';
      break;
    }
    return null;
  }

  buildNonOwnerReply(username, message, parsedType = 'unknown') {
    const owner = this.ctx.config?.owner ?? 'chủ nhân';
    if (!this.enabledChat) {
      return `Xin chào ${username}, tôi chỉ nghe lệnh của ${owner}.`;
    }
    const norm = normalizeSlang(message);
    const isGreeting =
      parsedType === 'greet' ||
      /\b(?:hi+|hello+|hey+|helo+|chao|alo|khoe khong|dang lam gi)\b/.test(norm);
    if (isGreeting) {
      return this._pick('non_owner_greet', [
        `Hế lô ${username} nha! Đang đi sinh tồn chung với ${owner} nè.`,
        `Hi ${username}! Vô chơi chung cho vui, mình đang phụ ${owner} quanh đây.`,
        `Chào ${username} nha! Hôm nay săn quái hay đi đào mỏ gì chưa?`,
      ]);
    }
    return `Chuyện giao việc phải hỏi ${owner} rồi ${username} ơi, tui đi theo phụ thôi à!`;
  }

  _summarizeSurroundings(username, { self }) {
    const { bot } = this.ctx;
    const pos = bot.entity?.position;
    if (!pos) return `Chờ xíu mới vào map chưa kịp nhìn quanh luôn ${username} ơi.`;

    let nearestMob = null;
    const otherMobs = new Set();
    const animals = new Set();
    for (const e of Object.values(bot.entities ?? {})) {
      if (!e?.position || e === bot.entity) continue;
      const dist = pos.distanceTo(e.position);
      if (dist > 20) continue;
      const name = String(e.name ?? '').toLowerCase();
      if (!name) continue;
      if (PASSIVE_ANIMALS.has(name)) {
        animals.add(name);
      } else if (e.kind === 'Hostile mobs' || e.type === 'hostile' || e.type === 'mob') {
        const rounded = Math.round(dist);
        if (!nearestMob || rounded < nearestMob.dist) {
          nearestMob = { name, dist: rounded };
        }
        otherMobs.add(name);
      }
    }

    const notableBlocks = new Set();
    if (typeof bot.findBlocks === 'function') {
      try {
        const hits = bot.findBlocks({
          matching: (b) => {
            const n = String(b?.name ?? '').toLowerCase();
            return n.endsWith('_ore') || n.endsWith('_log') || n === 'chest' || n === 'crafting_table' || n === 'furnace';
          },
          maxDistance: 16,
          count: 12,
        });
        for (const p of hits ?? []) {
          const blk = bot.blockAt?.(p);
          if (blk?.name) notableBlocks.add(blk.name);
        }
      } catch {}
    }

    const Self = capFirst(self);
    const clauses = [];
    if (nearestMob) {
      const extras = [...otherMobs].filter((n) => n !== nearestMob.name).slice(0, 2);
      const extraStr = extras.length > 0 ? ` với cả ${extras.join(', ')}` : '';
      clauses.push(`có con ${nearestMob.name} cách tầm ${nearestMob.dist} block${extraStr}`);
    } else {
      clauses.push('quanh đây êm ru không thấy quái nào');
    }
    if (animals.size > 0) {
      clauses.push(`có mấy con ${[...animals].slice(0, 3).join(', ')} lảng vảng gần đây`);
    }
    if (notableBlocks.size > 0) {
      clauses.push(`gần chỗ đứng còn thấy ${[...notableBlocks].slice(0, 3).join(', ')}`);
    }
    return `${Self} ngó quanh thấy ${clauses.join(', ')} nha ${username}.`;
  }

  _buildSuggestion(items, isDay, { self, you }) {
    const { config, equipment } = this.ctx;
    const readiness = summarizeReadiness(items, { minFoodPoints: config.survival?.minFoodPoints ?? 20 });
    const hasWood = items.some((i) => i?.name?.endsWith('_log') || i?.name?.endsWith('_planks'));
    const hasPick = items.some((i) => i?.name?.endsWith('_pickaxe'));
    const hasWeapon = items.some((i) => i?.name?.endsWith('_sword') || i?.name?.endsWith('_axe'));

    if (!hasWood && !hasPick) {
      return `Hay để ${self} đi chặt ít gỗ trước rồi làm bàn chế tạo với cuốc nha, ${you} gật cái là ${self} chạy liền!`;
    }
    if (hasWood && !hasPick) {
      return `Trong túi có gỗ rồi nè, ghép cái cuốc với kiếm xong tụi mình chui hang luôn cho nóng!`;
    }
    if (!readiness.hasEnoughFood) {
      return `Đồ ăn hơi hẻo rồi đó ${you}, hay kiếm thêm đồ ăn hoặc làm cái ruộng nhỏ trước cho đỡ đói.`;
    }
    if (!isDay) {
      return `Trời tối thui rồi kìa, kiếm giường ngủ qua đêm hay ${self} đi sát canh quái cho ${you}?`;
    }
    if (!hasWeapon || (equipment?.armorMitigation?.() ?? 0) < 0.2) {
      return `Hay xuống hang đào ít than với sắt về đúc bộ giáp chứ mặc vầy mỏng quá!`;
    }
    return `Đồ đạc cũng hòm hòm rồi đó, ${you} muốn đi đào sắt, làm ruộng hay dựng cái nhà không?`;
  }

  async buildChatReply({ username, message, parsedType = 'unknown', isOwner = true } = {}) {
    if (!isOwner) {
      return { reply: this.buildNonOwnerReply(username, message, parsedType) };
    }

    const { bot, config, tasks, combat, equipment, llm, state } = this.ctx;
    const pronouns = this._resolvePronouns(message);
    const { self, you } = pronouns;
    const Self = capFirst(self);
    const norm = normalizeSlang(message);
    const hp = Math.round(bot.health ?? 20);
    const food = Math.round(bot.food ?? 20);
    const timeOfDay = bot.time?.timeOfDay ?? 6000;
    const isDay = timeOfDay < 12000 || timeOfDay >= 23500;
    const ownerEntity = bot.players?.[username]?.entity ?? null;
    const ownerHp = ownerEntity?.health;
    const activeTask = tasks.status().active?.name ?? 'rảnh';
    const items = bot.inventory?.items?.() ?? [];

    // 1. Health / Hunger / Status check (checked before greet since router maps "khoe khong" -> greet)
    if (/\b(?:khoe khong|on khong|doi khong|doi chua|mau bao nhieu|tinh hinh sao|sao roi)\b/.test(norm)) {
      const held = bot.heldItem?.name;
      const armor = Math.round((equipment?.armorMitigation?.() ?? 0) * 100);
      const gearTail = [
        held ? `tay đang cầm ${held}` : null,
        armor > 0 ? `giáp cũng tầm ${armor}%` : null,
      ].filter(Boolean).join(', ');
      if (hp < 12) {
        return {
          reply: `${Self} mới bị cào nhẹ còn ${hp}/20 máu à ${username}${gearTail ? `, ${gearTail}` : ''}, ăn miếng là hồi liền!`,
        };
      }
      if (food < 12) {
        return {
          reply: `Máu vẫn ${hp}/20 máu mà bụng hơi réo rồi (${food}/20 đói) nha ${username}, có đồ ăn quăng cho ${self} miếng!`,
        };
      }
      return {
        reply: `${Self} khỏe re ${hp}/20 máu nè ${username}, bụng no căng luôn${gearTail ? `, ${gearTail}` : ''}!`,
      };
    }

    // 2. Urgent rescue / combat cry
    if (/\b(?:cuu|cuu tui|cuu minh|cuu voi|quai danh|bi danh|chet mat|toang roi|chay ngay)\b/.test(norm)) {
      return {
        reply: `Đợi xíu ${self} chạy qua hốt nó phụ ${you} liền!`,
        command: { type: 'come' },
      };
    }

    // 2.5 Casual scratchpad resume or discard when unfinished work exists
    if (this.ctx.scratchpad?.hasRecovery?.()) {
      if (/^(?:thoi bo|thoi bo di|bo di|bo qua|bo qua di|khoi lam|thoi khoi|quen di|xoa di)[?!.,~]*$/.test(norm)) {
        return {
          reply: `Ok ${self} bỏ qua việc dở lần trước rồi nha, nay chơi kèo mới!`,
          command: { type: 'scratchpad_clear' },
        };
      }
      if (/^(?:ok lam tiep|lam tiep di|uh lam tiep|ok lam lai|lam lai di|trien not|lam not di)[?!.,~]*$/.test(norm)) {
        return {
          reply: `Ok để ${self} bắt tay làm nốt việc dở lần trước liền nha!`,
          command: { type: 'scratchpad_resume' },
        };
      }
    }

    // 3. Greetings
    if (
      parsedType === 'greet' ||
      /^(?:hi+|hello+|hey+|helo+|alo+|chao|xin chao|oi|bot oi|ban oi|e bot|e ong|e bro|e fen|e)(?:\s+(?:bot|ban|ong|ba|bro|fen|[a-z0-9_]{2,16}))?[?!.,~]*$/.test(norm)
    ) {
      if (typeof ownerHp === 'number' && ownerHp <= 10) {
        return { reply: `Ơ kìa ${username}, máu ${you} tuột còn có ${Math.round(ownerHp)}/20 kìa! Ăn hồi đi để ${self} canh cho!` };
      }
      if (combat.busy) {
        return { reply: `Ơi ${username}, chờ ${self} chém nốt con quái này cái nha!` };
      }
      if (!isDay) {
        return { reply: `Hế lô ${username}! Trời tối dễ spawn quái lắm á, cần ${self} đi sát bảo vệ hay tìm chỗ ngủ không?` };
      }
      return {
        reply: this._pick('owner_greet', [
          `Ơi ${username}, có ${self} đây! Hôm nay đi chặt gỗ, chui hang hay quẩy gì đây?`,
          `Hế lô ${username}! Đang đứng ngó quanh chờ ${you} rủ đi chơi nè.`,
          `Chào ${username} nha! Muốn đi đâu đào bới hay săn quái cứ hú ${self} tiếng nha.`,
          `Alo ${username}, nghe rõ nè! Nay tụi mình làm kèo gì trước đây?`,
        ]),
      };
    }

    // 4. Context follow-up confirmation (e.g. "ok triển luôn", "ừ làm đi", or bare "ok" right after a suggestion)
    if (/^(?:ok|trien|trien luon|ok trien|ok trien luon|lam di|di di|chot|duoc do|vay di|ok lam di|lam luon|ok di)[?!.,~]*$/.test(norm)) {
      const followTarget = this._lastAssistantSuggestionTarget();
      if (followTarget === 'gather_wood') {
        return { reply: `Ok triển luôn, để ${self} chạy đi chặt ít gỗ liền nha!`, command: { type: 'gather', count: 16, target: 'gỗ' } };
      }
      if (followTarget) {
        return this._formatActionIntent(followTarget, pronouns);
      }
    }

    // 5. Laughter / banter
    if (/^(?:ha+ha+|hi+hi+|he+he+|kkk+|lol+|lmao+|huhu+|o kia|vai|chet cuoi)/.test(norm)) {
      return {
        reply: this._pick('owner_laugh', [
          `Haha công nhận vui thiệt, lâu lâu làm pha tấu hài đỡ căng thẳng!`,
          `Kkk ${you} nói làm ${self} suýt bấm nhầm nút luôn á!`,
          `Hehe chill mà ${you}, miễn đừng rớt xuống lava là ổn hết!`,
        ]),
      };
    }

    // 5. Praise / Thanks
    if (parsedType === 'ack' || /\b(?:gioi|tot lam|hay qua|ngon|tuyet|pro|cam on|thanks|thank|tks|okela)\b/.test(norm)) {
      return {
        reply: this._pick('owner_ack', [
          `Có gì đâu, đồng đội mà! Cần gì ${you} cứ hú tiếp nha.`,
          `Hehe chuyện nhỏ! ${Self} gánh được mấy pha này ngon ơ.`,
          `Ok luôn ${you}! Đi với ${self} là cứ yên tâm nha.`,
        ]),
      };
    }

    // 6. Feelings & co-op small talk
    if (/\b(?:chan qua|buon qua|met qua|luoi qua)\b/.test(norm)) {
      return {
        reply: this._pick('owner_bored', [
          `Chán hả, hay rủ ${self} xuống hang kiếm kim cương hoặc xây cái nhà mới cho vui đi!`,
          `Thấy hơi oải thì đứng nghỉ xíu hay đi dạo kiếm làng dân làng đổi đồ nè ${you}.`,
        ]),
      };
    }
    if (/\b(?:so qua|run qua|ghe qua|toi thui|toi qua|am anh)\b/.test(norm)) {
      return {
        reply: `Đừng sợ, có ${self} cầm đồ đứng ngay bên bảo vệ ${you} rồi nè!`,
      };
    }
    if (/\b(?:doi qua|doi bung|het do an|an gi)\b/.test(norm)) {
      const foodItems = items.filter((i) => /bread|beef|porkchop|chicken|mutton|apple|carrot|potato|melon|stew/.test(i?.name ?? ''));
      if (foodItems.length > 0) {
        return { reply: `Trong túi ${self} đang có ít ${foodItems[0].name} nè, cần không qua gần ${self} quăng cho!` };
      }
      return { reply: `Túi ${self} cũng đang cạn đồ ăn rồi, hay tụi mình đi săn ít bò heo nướng thịt ăn nè!` };
    }

    // 7. Current activity
    if (/\b(?:dang lam gi|lam gi do|ban ranh khong|ranh khong|xong chua)\b/.test(norm)) {
      const desc = formatTaskActivity(activeTask, pronouns);
      if (desc) return { reply: desc };
      return {
        reply: this._pick('idle_status', [
          `${Self} đang rảnh đi dạo quanh ${you} nè, cần sai gì cứ hú nha!`,
          `${Self} đang đứng hóng gió chứ chưa làm gì hết á ${you}, rủ đi làm gì đi!`,
        ]),
      };
    }

    // 8. Surroundings scan
    if (/\b(?:quanh day|xung quanh|thay gi khong|co quai khong|co nguy hiem khong|co gi quanh)\b/.test(norm)) {
      return { reply: this._summarizeSurroundings(username, pronouns) };
    }

    // 9. Progression / Suggestions
    if (/\b(?:de xuat|nen lam gi|gio lam gi|lam gi tiep|goi y|lam gi bay gio)\b/.test(norm)) {
      return { reply: this._buildSuggestion(items, isDay, pronouns) };
    }

    // 10. Identity / Capabilities
    if (/\b(?:ban la ai|ong la ai|ten gi|biet lam gi|lam duoc gi)\b/.test(norm)) {
      return {
        reply: `${Self} là ${bot.username}, bạn chơi chung map với ${config.owner} nè! Chặt gỗ, đào mỏ, nung đồ, làm ruộng, xây nhà với đập quái ${self} cân hết.`,
      };
    }

    // 12. Location
    if (/\b(?:ban o dau|ong o dau|dang o dau|toa do|dau roi)\b/.test(norm)) {
      const pos = bot.entity?.position;
      if (!pos) return { reply: `Từ từ ${self} mới load chưa kịp nhìn tọa độ nữa.` };
      const dist = ownerEntity?.position ? Math.round(pos.distanceTo(ownerEntity.position)) : null;
      const distStr = dist != null
        ? (dist <= 4 ? ', đứng ngay cạnh luôn nè' : ` (cách ${you} tầm ${dist} block)`)
        : '';
      return { reply: `${Self} đang ở chỗ ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}${distStr} nha.` };
    }

    // 13. Resume autonomy
    if (/\b(?:tu do di|di dao di|tu choi di|tu lam viec di|dung dung im nua)\b/.test(norm)) {
      state.stayPut = false;
      return {
        reply: `Ok để ${self} tự đi dạo quanh lượm đồ với canh quái giúp ${you} nha!`,
        triggerIdle: true,
      };
    }

    // 14. Natural-language action extraction
    const isProhibition = /\b(?:dung|cam|thoi)\b/.test(norm);
    const hasExplicitOneLittle = /\b(?:1 it|mot it|1 chut|mot chut|1 ti|mot ti)\b/.test(norm);
    if (!isProhibition && /\b(?:kiem|chat|don|lay)\b.*\b(?:go|cay|cui)\b/.test(norm)) {
      if (hasExplicitOneLittle) {
        return { reply: null, command: { type: 'gather', count: 16, target: 'gỗ', needsCount: true, autoDeliver: true } };
      }
      return this._formatActionIntent('gather_wood', pronouns);
    }
    if (!isProhibition && /\b(?:dao|kiem|dap)\b.*\b(?:da|stone|cobble)\b/.test(norm)) {
      if (hasExplicitOneLittle) {
        return { reply: null, command: { type: 'gather', count: 16, target: 'đá', needsCount: true, autoDeliver: true } };
      }
      return this._formatActionIntent('gather_stone', pronouns);
    }
    if (!isProhibition && /\b(?:dao|kiem)\b.*\b(?:than|coal)\b/.test(norm)) {
      if (hasExplicitOneLittle) {
        return { reply: null, command: { type: 'gather', count: 16, target: 'than', needsCount: true, autoDeliver: true } };
      }
      return this._formatActionIntent('gather_coal', pronouns);
    }
    if (!isProhibition && /\b(?:dao|kiem)\b.*\b(?:sat|iron)\b/.test(norm)) {
      if (hasExplicitOneLittle) {
        return { reply: null, command: { type: 'gather', count: 8, target: 'sắt', needsCount: true, autoDeliver: true } };
      }
      return this._formatActionIntent('gather_iron', pronouns);
    }
    if (!isProhibition && /\b(?:di cung|bao ve|ho tong|di sat|theo sat)\b/.test(norm)) {
      return this._formatActionIntent('follow', pronouns);
    }
    if (!isProhibition && /\b(?:qua day|chay lai day|toi cho|den cho|lai cho)\b/.test(norm)) {
      return this._formatActionIntent('come', pronouns);
    }
    if (!isProhibition && /\b(?:dung cho|cho ti|doi o day|ngoi yen)\b/.test(norm)) {
      return this._formatActionIntent('stay', pronouns);
    }

    // 15. Optional Jev System-1 intent fallback
    if (llm?.isAvailable?.() && typeof llm.ask === 'function') {
      try {
        const res = await llm.ask({
          state: { message, activeTask, hp, food, isDay },
          questions: JEV_CHAT_INTENT_QUESTIONS,
          timeoutMs: 1800,
        });
        const intentChoice = res?.answers?.intent?.choice;
        const intentConf = res?.answers?.intent?.confidence ?? 0;
        if (intentChoice && intentChoice !== 'chat_casual' && intentConf >= 0.68 && ACTION_INTENT_SPECS[intentChoice]) {
          return this._formatActionIntent(intentChoice, pronouns);
        }
      } catch {}
    }

    // 16. Conversational catch-all
    const isQuestion = message.includes('?') || /\b(?:khong|chua|sao|ha|nhi|nao|gi|a)\b$/.test(norm);
    if (isQuestion) {
      const taskHint = formatTaskActivity(activeTask, pronouns);
      return {
        reply: this._pick('catchall_q', [
          taskHint
            ? `Hở ${you}? ${taskHint}, cần ${self} phụ thêm gì không?`
            : `Hở ${you}? ${Self} đang rảnh nè, hay tụi mình đi chặt gỗ, xuống hang hay xây gì đi?`,
          `Sao thế ${username}? Cứ nói tự nhiên đi ${self} nghe hết nè!`,
        ]),
      };
    }
    return {
      reply: this._pick('catchall_s', [
        `Ừa ${self} nghe nè ${you}, chừng nào muốn đi đào hay xây gì cứ ới tiếng nha!`,
        `Ok luôn ${username}! ${Self} vẫn đứng ngay quanh đây chơi cùng ${you} đó.`,
        `Hehe chuẩn rồi đó ${you}, có gì hay ho rủ ${self} làm chung với nha!`,
      ]),
    };
  }

  scheduleChatFallback({ username, message, parsed, reply, inboxEntry = null, myChatGen, receivedAt }) {
    if (this.disposed || !this.enabledChat) return;
    if (this._chatTimer) {
      clearTimeout(this._chatTimer);
      this._chatTimer = null;
    }
    const { config, state } = this.ctx;
    const lastPollAt = Math.max(state.lastSidecarPollAt ?? 0, state.lastMcpPollAt ?? 0);
    const mcpActive = lastPollAt > 0 && (Date.now() - lastPollAt) < 15000;
    const delayMs = mcpActive
      ? (config.companion?.mcpGraceMs ?? 18000)
      : (config.companion?.chatFallbackDelayMs ?? 550);

    this._chatTimer = setTimeout(async () => {
      this._chatTimer = null;
      if (this.disposed || state.disconnected) return;
      if (myChatGen !== state.chatGen) return;
      if ((state.lastApiActionAt ?? 0) >= receivedAt) return;
      if (inboxEntry?.handledByBot) return;

      try {
        const res = await this.buildChatReply({
          username,
          message,
          parsedType: parsed?.type ?? 'unknown',
          isOwner: true,
        });
        if (this.disposed || myChatGen !== state.chatGen || (state.lastApiActionAt ?? 0) >= receivedAt) return;

        const ownerPos = this.ctx.bot.players?.[username]?.entity?.position;
        if (ownerPos && !this.ctx.combat?.busy && !this.ctx.bot.isSleeping && !this.ctx.bot.targetDigBlock) {
          this.ctx.humanizer?.smoothLookAt?.(
            { x: ownerPos.x, y: ownerPos.y + 1.62, z: ownerPos.z },
            { steps: 3 }
          ).catch(() => {});
        }

        if (res?.reply) {
          reply(res.reply);
          this.ctx.pushChatHistory?.('assistant', res.reply);
        }
        if (res?.command) {
          if (inboxEntry) inboxEntry.handledByBot = true;
          await this.ctx.dispatchParsedCommand?.(res.command, username, reply, null, {
            userMessage: message,
            suppressStart: true,
            alreadyAcked: Boolean(res.reply),
          });
        }
      } catch (err) {
        this.ctx.errorFor?.('companion', err?.message || String(err));
      }
    }, delayMs);
    this._chatTimer.unref?.();
  }

  stopIdleMotion() {
    this._escortingOwner = false;
    const { bot, tasks, combat, state } = this.ctx;
    if (state.idleGoalActive) {
      state.idleGoalActive = false;
      if (!tasks.active && !combat._ownsPathfinder) {
        try { bot.pathfinder?.setGoal?.(null); } catch {}
      }
    }
  }

  async tickAutoUpgrade(now = Date.now(), { force = false } = {}) {
    const { bot, combat, survival, equipment, tasks, crafting, config } = this.ctx;
    if (!force && config?.companion?.autoUpgrade === false) return null;
    if (!bot?.entity?.position || combat?.busy || survival?.busy || tasks?.active || bot.isSleeping || bot.currentWindow || bot.targetDigBlock) {
      return null;
    }
    if (!force && now - this._lastAutoUpgradeAt < 6000) return null;
    if (typeof equipment?.planNextGearUpgrade !== 'function' || !crafting) return null;

    const plan = equipment.planNextGearUpgrade();
    if (!plan) return null;

    const retryAt = this._upgradeFailCooldown.get(plan.item) ?? 0;
    if (!force && now < retryAt) return null;

    this._lastAutoUpgradeAt = now;
    const runUpgrade = async (signal) => {
      try {
        if (plan.action === 'smelt' && typeof crafting.smeltItem === 'function') {
          await crafting.smeltItem(plan.input ?? plan.item, plan.count ?? 1, signal);
        } else if (typeof crafting.craftItem === 'function') {
          await crafting.craftItem(plan.item, plan.count ?? 1, signal);
        } else {
          return false;
        }
        await equipment.maintainArmorAndShield?.();
        await equipment.equipMelee?.();
        if (equipment.discardObsolete) {
          await equipment.discardObsoleteItems?.();
        }
        if (config?.companion?.ambientChatter !== false && typeof bot.chat === 'function') {
          const { self } = this._resolvePronouns('');
          const Self = capFirst(self);
          const msg = `${Self} tự ${plan.reason} rồi nha!`;
          try {
            bot.chat(msg);
            this.ctx.pushChatHistory?.('assistant', msg);
          } catch {}
        }
        return true;
      } catch (err) {
        this._upgradeFailCooldown.set(plan.item, Date.now() + 25000);
        this.ctx.log?.(`Auto-upgrade (${plan.item}) deferred: ${err?.message ?? err}`);
        return false;
      }
    };

    if (typeof tasks?.run === 'function') {
      const run = tasks.run(
        { name: 'tu_nang_cap', reason: plan.reason, target: plan.item },
        runUpgrade,
        {
          onAbort: () => { try { bot.pathfinder?.setGoal?.(null); } catch {} },
          priority: TASK_TIERS.BACKGROUND,
        }
      );
      run?.promise?.catch?.(() => {});
      return { started: true, plan, promise: run?.promise ?? null };
    }

    const ok = await runUpgrade(null);
    return { started: ok, plan, promise: null };
  }

  _tickAutoCloseDoors(now = Date.now()) {
    const { bot, config } = this.ctx;
    if (!bot?.entity?.position || typeof bot.findBlocks !== 'function' || typeof bot.activateBlock !== 'function') {
      return false;
    }
    const doorIds = Object.entries(bot.registry?.blocksByName ?? {})
      .filter(([n, info]) => info?.id && n.endsWith('_door') && n !== 'iron_door')
      .map(([, info]) => info.id);
    if (doorIds.length === 0) return false;

    const isDoorOpen = (blk) => {
      if (!blk) return false;
      if (blk.open === true) return true;
      const props = blk.getProperties?.() ?? blk.properties ?? {};
      return props.open === true || props.open === 'true';
    };

    const normalizeDoorPos = (blk) => {
      const p = blk.position;
      const props = blk.getProperties?.() ?? blk.properties ?? {};
      const y = props.half === 'upper' ? p.y - 1 : p.y;
      return { x: Math.floor(p.x), y: Math.floor(y), z: Math.floor(p.z) };
    };

    const positions = bot.findBlocks({ matching: doorIds, maxDistance: 4.5, count: 8 }) ?? [];
    for (const pos of positions) {
      const blk = bot.blockAt?.(pos);
      if (!isDoorOpen(blk) || !blk?.position) continue;
      const dp = normalizeDoorPos(blk);
      const key = `${dp.x},${dp.y},${dp.z}`;
      const d = Math.hypot(bot.entity.position.x - (dp.x + 0.5), bot.entity.position.y - dp.y, bot.entity.position.z - (dp.z + 0.5));
      if (d <= 1.9 && !this._recentOpenDoors.has(key)) {
        this._recentOpenDoors.set(key, { x: dp.x, y: dp.y, z: dp.z, at: now });
      }
    }

    const ownerPos = bot.players?.[config?.owner]?.entity?.position ?? null;
    let closedAny = false;

    for (const [key, entry] of this._recentOpenDoors.entries()) {
      if (now - entry.at > 8000) {
        this._recentOpenDoors.delete(key);
        continue;
      }
      if (now - entry.at < 1200 || now < (this._doorCloseCooldown.get(key) ?? 0)) continue;
      const d = Math.hypot(bot.entity.position.x - (entry.x + 0.5), bot.entity.position.y - entry.y, bot.entity.position.z - (entry.z + 0.5));
      if (d < 2.0 || d > 4.5) continue;
      if (ownerPos) {
        const od = Math.hypot(ownerPos.x - (entry.x + 0.5), ownerPos.y - entry.y, ownerPos.z - (entry.z + 0.5));
        if (od <= 1.8) continue;
      }
      const blk = bot.blockAt?.(new Vec3(entry.x, entry.y, entry.z));
      if (!isDoorOpen(blk)) {
        this._recentOpenDoors.delete(key);
        continue;
      }
      this._doorCloseCooldown.set(key, now + 15000);
      this._recentOpenDoors.delete(key);
      closedAny = true;
      Promise.resolve(bot.activateBlock(blk)).catch(() => {});
    }

    return closedAny;
  }

  async tickSurvivalAutonomy(now = Date.now(), { force = false } = {}) {
    const { bot, combat, survival, equipment, tasks, crafting, mining, home, config } = this.ctx;
    if (this.ctx.state?.pendingQuantity && now <= (this.ctx.state.pendingQuantity.expiresAt ?? 0)) {
      return null;
    }
    if (!bot?.entity?.position || combat?.busy || survival?.busy || tasks?.active || bot.isSleeping || bot.currentWindow || bot.targetDigBlock) {
      return null;
    }

    if (home?.detectNearbyBase && (force || now - this._lastBaseCheckAt >= 25000)) {
      this._lastBaseCheckAt = now;
      try { home.detectNearbyBase({ radius: 12 }); } catch {}
    }

    if (!force && now - this._lastAutonomyAt < 6000) return null;

    const items = bot.inventory?.items?.() ?? [];
    const held = bot.heldItem ?? null;
    const allOwned = [...items, ...(held ? [held] : [])];
    const countOf = (pred) => items.reduce((s, i) => (pred(String(i?.name ?? '').toLowerCase()) ? s + (i.count ?? 1) : s), 0);
    const pts = foodSupply(items);

    const launch = async (kind, taskName, reason, fn, extraMeta = {}) => {
      if (!force && now < (this._autonomyFailCooldown.get(kind) ?? 0)) return null;
      this._lastAutonomyAt = now;
      const wrapped = async (signal) => {
        try {
          const res = await fn(signal);
          if (res === false) {
            const cdMs = (kind === 'auto_store' || kind === 'restock') ? 60000 : 25000;
            this._autonomyFailCooldown.set(kind, Date.now() + cdMs);
          }
          return res;
        } catch (err) {
          this._autonomyFailCooldown.set(kind, Date.now() + 25000);
          this.ctx.log?.(`Autonomy (${kind}) deferred: ${err?.message ?? err}`);
          return false;
        }
      };
      if (typeof tasks?.run === 'function') {
        const run = tasks.run(
          { name: taskName, reason, ...extraMeta },
          wrapped,
          { onAbort: () => { try { bot.pathfinder?.setGoal?.(null); } catch {} }, priority: TASK_TIERS.BACKGROUND }
        );
        run?.promise?.catch?.(() => {});
        return { started: true, kind, promise: run?.promise ?? null };
      }
      const ok = await wrapped(null);
      return { started: ok !== false, kind, promise: null };
    };

    // 1. Restock from home chest if missing core weapon/pickaxe or low food near home
    const hasWeapon = allOwned.some((i) => {
      const n = String(i?.name ?? '').toLowerCase();
      return n.endsWith('_sword') || n.endsWith('_axe');
    });
    const hasPick = allOwned.some((i) => String(i?.name ?? '').toLowerCase().endsWith('_pickaxe'));
    const chestPos = home?.getStorageChest?.();
    const chestNear = chestPos && Math.hypot(bot.entity.position.x - chestPos.x, bot.entity.position.y - chestPos.y, bot.entity.position.z - chestPos.z) <= 16;
    if (
      home?.restockEssentialsFromNearbyChest &&
      typeof bot.openChest === 'function' &&
      chestNear &&
      (!hasWeapon || !hasPick || pts < 16)
    ) {
      return await launch('restock', 'tiep_te_tu_ruong', 'tự lấy đồ dự phòng từ rương nhà', async () => {
        const res = await home.restockEssentialsFromNearbyChest({ maxDistance: 16 });
        if (res?.withdrawn?.length > 0) {
          await equipment?.maintain?.();
        }
        return (res?.withdrawn?.length ?? 0) > 0;
      });
    }

    // 2. Fill empty bucket -> water_bucket when source water is nearby
    const emptyBucket = items.find((i) => String(i?.name ?? '').toLowerCase() === 'bucket')
      ?? (String(held?.name ?? '').toLowerCase() === 'bucket' ? held : null);
    const hasWaterBucket = allOwned.some((i) => String(i?.name ?? '').toLowerCase() === 'water_bucket');
    if (emptyBucket && !hasWaterBucket && typeof bot.findBlock === 'function' && typeof bot.activateItem === 'function') {
      const waterId = bot.registry?.blocksByName?.water?.id;
      const waterBlock = waterId
        ? bot.findBlock({ matching: (b) => b && b.type === waterId && (b.metadata ?? 0) === 0, maxDistance: 10 })
        : null;
      if (waterBlock?.position) {
        return await launch('fill_water', 'muc_nuoc_xo', 'múc xô nước hộ thân', async () => {
          if (bot.pathfinder?.goto && bot.entity.position.distanceTo(waterBlock.position) > 3.5) {
            await bot.pathfinder.goto(new goals.GoalNear(waterBlock.position.x, waterBlock.position.y, waterBlock.position.z, 2.5));
          }
          await bot.equip?.(emptyBucket, 'hand');
          await bot.lookAt?.(waterBlock.position.offset(0.5, 0.5, 0.5), true);
          bot.activateItem(false);
          return true;
        });
      }
    }

    // 3. Convert hay_block -> wheat -> bread when food reserves are modest
    const hayCount = countOf((n) => n === 'hay_block');
    const wheatCount = countOf((n) => n === 'wheat');
    if (pts < 60 && crafting?.craftItem && (hayCount >= 1 || wheatCount >= 3)) {
      return await launch('craft_bread', 'lam_banh_mi', 'chế biến lúa mì thành bánh mì', async (signal) => {
        if (hayCount >= 1) {
          await crafting.craftItem('wheat', Math.min(hayCount, 3) * 9, signal);
        }
        const nowWheat = (bot.inventory?.items?.() ?? []).reduce(
          (s, i) => (String(i?.name ?? '').toLowerCase() === 'wheat' ? s + (i.count ?? 1) : s),
          0
        );
        if (nowWheat >= 3) {
          await crafting.craftItem('bread', Math.floor(nowWheat / 3), signal);
        }
        return true;
      });
    }

    // 4. Cook raw meat / potatoes when fuel AND a furnace (placed, in inventory, or craftable from >= 8 cobble) are available
    const RAW_COOKABLES = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'salmon', 'cod', 'potato'];
    const rawStack = items
      .filter((i) => RAW_COOKABLES.includes(String(i?.name ?? '').toLowerCase()))
      .sort((a, b) => (b.count ?? 1) - (a.count ?? 1))[0];
    const hasFuel = countOf((n) => n === 'coal' || n === 'charcoal' || n.endsWith('_planks') || n === 'planks' || n.endsWith('_log')) >= 1;
    if (rawStack && (rawStack.count ?? 1) >= 2 && hasFuel && crafting?.smeltItem) {
      const hasFurnaceItem = allOwned.some((i) => ['furnace', 'smoker'].includes(String(i?.name ?? '').toLowerCase()));
      const furnaceStoneCount = countOf((n) => n === 'cobblestone' || n === 'blackstone' || n === 'cobbled_deepslate');
      const furnaceIds = ['furnace', 'smoker'].map((n) => bot.registry?.blocksByName?.[n]?.id).filter(Boolean);
      const nearbyFurnace = (!hasFurnaceItem && furnaceStoneCount < 8 && furnaceIds.length > 0 && typeof bot.findBlock === 'function')
        ? bot.findBlock({ matching: furnaceIds, maxDistance: 16 })
        : null;
      if (hasFurnaceItem || furnaceStoneCount >= 8 || Boolean(nearbyFurnace)) {
        return await launch('cook_food', 'nau_thuc_an', 'nấu chín thịt/khoai mang theo', async (signal) => {
          await crafting.smeltItem(rawStack.name, Math.min(rawStack.count ?? 2, 16), signal);
          return true;
        });
      }
    }

    // 5. Auto-harvest mature crops nearby (without wandering off to break grass unless ordered)
    if (mining?.hasMatureCropsNearby?.(16) && typeof mining.farmCrops === 'function') {
      return await launch('harvest_crops', 'thu_hoach_ruong', 'thu hoạch và gieo lại cây đã chín', async (signal) => {
        await mining.farmCrops(signal, { forageSeeds: false });
        return true;
      });
    }

    // 6. Harvest village hay_block when low on food
    if (pts < 32 && mining?.harvestHayBales && typeof bot.findBlock === 'function') {
      const hayId = bot.registry?.blocksByName?.hay_block?.id;
      const nearHay = hayId ? bot.findBlock({ matching: hayId, maxDistance: 24 }) : null;
      if (nearHay) {
        return await launch('harvest_hay', 'lay_kien_rom', 'lấy kiện rơm làm bánh mì', async (signal) => {
          const res = await mining.harvestHayBales(3, signal);
          if ((res?.dug ?? 0) > 0 && crafting?.craftItem) {
            const newHay = (bot.inventory?.items?.() ?? []).reduce(
              (s, i) => (String(i?.name ?? '').toLowerCase() === 'hay_block' ? s + (i.count ?? 1) : s),
              0
            );
            if (newHay >= 1) await crafting.craftItem('wheat', Math.min(newHay, 3) * 9, signal);
            const nowWheat = (bot.inventory?.items?.() ?? []).reduce(
              (s, i) => (String(i?.name ?? '').toLowerCase() === 'wheat' ? s + (i.count ?? 1) : s),
              0
            );
            if (nowWheat >= 3) await crafting.craftItem('bread', Math.floor(nowWheat / 3), signal);
          }
          return (res?.dug ?? 0) > 0;
        });
      }
    }

    const inNether = String(bot.game?.dimension ?? '').toLowerCase().includes('nether');
    const timeOfDay = bot.time?.timeOfDay;
    const isNight = !inNether && typeof timeOfDay === 'number' && timeOfDay >= 13000 && timeOfDay <= 23000;
    const huntThreshold = isNight ? 16 : 28;

    // 7. Hunt nearby adult livestock when running low/proactively in daytime (only if one is actually nearby)
    if (
      pts < huntThreshold &&
      mining?.huntNearbyFoodAnimal &&
      typeof bot.attack === 'function' &&
      mining?.findNearestFoodAnimal?.(20)
    ) {
      const huntRes = await launch('hunt_food', 'san_thu_lay_thit', 'săn thú kiếm thêm thức ăn', async (signal) => {
        const res = await mining.huntNearbyFoodAnimal(signal);
        return (res?.kills ?? 0) > 0;
      });
      if (huntRes) return huntRes;
    }

    // 8. Proactive idle resource farming (anti-griefing, owner-leashed, toggleable)
    const autoFarmAllowed =
      (this.ctx.state?.autoFarmEnabled ?? (config?.companion?.autoFarm !== false)) !== false &&
      !this.ctx.state?.stayPut;
    if (!autoFarmAllowed) return null;

    const ownerEntity = bot.players?.[config?.owner]?.entity ?? null;
    if (ownerEntity?.position) {
      const distToOwner = bot.entity.position.distanceTo(ownerEntity.position);
      if (distToOwner > 18 && distToOwner <= 64) {
        return null;
      }
    }

    const emptySlots = typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 10;
    const hasIronWeapon = allOwned.some((i) => /^(?:iron|diamond|netherite)_(?:sword|axe)$/.test(String(i?.name ?? '').toLowerCase()));
    const hasIronPick = allOwned.some((i) => /^(?:iron|diamond|netherite)_pickaxe$/.test(String(i?.name ?? '').toLowerCase()));
    const farmDist = isNight && (!hasIronWeapon || !hasIronPick) ? 12 : 28;
    const homePos = home?.get?.() ?? null;

    const announceAutoFarm = (detail) => {
      if (config?.companion?.ambientChatter === false || !this.enabledIdle || typeof bot.chat !== 'function') return;
      if (now - this._lastAutoFarmChatAt < 180000) return;
      this._lastAutoFarmChatAt = now;
      const { self } = this._resolvePronouns('');
      const Self = capFirst(self);
      const msg = `${Self} tranh thủ rảnh tay đi ${detail} quanh đây nha!`;
      try {
        bot.chat(msg);
        this.ctx.pushChatHistory?.('assistant', msg);
      } catch {}
    };

    // 8a. Purge junk first, then deposit genuinely useful surplus into nearby/home chest
    const surplusStacks = typeof home?.countSurplusStacks === 'function' ? home.countSurplusStacks() : 0;
    if ((emptySlots <= 10 || surplusStacks >= 4) && home?.storeSurplus && typeof bot.openChest === 'function') {
      let storeChest = typeof bot.findBlock === 'function'
        ? bot.findBlock({
            matching: (b) => b && (b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel'),
            maxDistance: 20,
          })
        : null;
      if (!storeChest && chestPos && typeof bot.blockAt === 'function') {
        const cd = Math.hypot(bot.entity.position.x - chestPos.x, bot.entity.position.y - chestPos.y, bot.entity.position.z - chestPos.z);
        if (cd <= 28) {
          const cand = bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z));
          if (cand && (cand.name === 'chest' || cand.name === 'trapped_chest' || cand.name === 'barrel')) {
            storeChest = cand;
          }
        }
      }
      if (storeChest?.position) {
        const storeRes = await launch('auto_store', 'cat_do_tu_dong', 'lọc rác và cất đồ dư vào rương nhà', async () => {
          announceAutoFarm('cất bớt đồ vô rương');
          const ownerEnt = bot.players?.[config?.owner]?.entity ?? null;
          if (equipment?.discardObsoleteItems) {
            await equipment.discardObsoleteItems({ ownerEntity: ownerEnt });
          }
          if (equipment?.discardJunkItems) {
            await equipment.discardJunkItems({ blockStacks: config?.inventory?.blockStacks ?? 2, ownerEntity: ownerEnt });
          }
          const nowEmpty = typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 10;
          const nowSurplus = typeof home?.countSurplusStacks === 'function' ? home.countSurplusStacks() : 1;
          if (nowSurplus === 0 && nowEmpty > 10) {
            return false;
          }
          if (bot.pathfinder?.goto && bot.entity.position.distanceTo(storeChest.position) > 3.5) {
            await bot.pathfinder.goto(new goals.GoalNear(storeChest.position.x, storeChest.position.y, storeChest.position.z, 2.5));
          }
          return await home.storeSurplus(storeChest);
        }, { autoFarm: true });
        if (storeRes) return storeRes;
      }
    }

    if (typeof survival?.gather === 'function' && emptySlots > 2) {
      const pickTier = bestPickTier(allOwned);
      const isPausedFn = this.ctx.isWorkPaused ?? (() => Boolean(combat?.busy || tasks?.paused || survival?.busy));
      const runAutoGather = (kind, taskName, reason, chatDetail, targetName, count) =>
        launch(kind, taskName, reason, async (signal) => {
          announceAutoFarm(chatDetail);
          const got = await survival.gather(targetName, count, signal, { isPaused: isPausedFn });
          if (!(got > 0)) {
            this._autonomyFailCooldown.set(kind, Date.now() + 45000);
            return false;
          }
          return true;
        }, { autoFarm: true });

      // 8b. Mine exposed ores nearby
      const oreDist = Math.min(24, farmDist);
      if (pickTier === 'iron' || pickTier === 'diamond') {
        const rareHit = findSafeIdleMineralTarget(
          bot,
          ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'gold_ore', 'deepslate_gold_ore', 'lapis_ore', 'deepslate_lapis_ore', 'redstone_ore', 'deepslate_redstone_ore'],
          { maxDistance: oreDist, homePos, chestPos }
        );
        if (rareHit) {
          const res = await runAutoGather('auto_farm_rare_ore', 'tu_farm_quang_quy', 'đào quặng quý lộ thiên quanh đây', 'đào ít quặng quý', rareHit.name, 6);
          if (res) return res;
        }
      }

      const ironSupply = countOf((n) => n === 'iron_ingot' || n === 'raw_iron' || n === 'iron_ore' || n === 'deepslate_iron_ore');
      if ((pickTier === 'stone' || pickTier === 'iron' || pickTier === 'diamond') && ironSupply < 32) {
        const ironHit = findSafeIdleMineralTarget(
          bot,
          ['iron_ore', 'deepslate_iron_ore'],
          { maxDistance: oreDist, homePos, chestPos }
        );
        if (ironHit) {
          const res = await runAutoGather('auto_farm_iron', 'tu_farm_sat', 'đào quặng sắt quanh đây', 'đào thêm sắt', ironHit.name, 8);
          if (res) return res;
        }
      }

      const coalCount = countOf((n) => n === 'coal' || n === 'charcoal');
      if (pickTier !== 'none' && coalCount < 32) {
        const coalHit = findSafeIdleMineralTarget(
          bot,
          ['coal_ore', 'deepslate_coal_ore'],
          { maxDistance: oreDist, homePos, chestPos }
        );
        if (coalHit) {
          const res = await runAutoGather('auto_farm_coal', 'tu_farm_than', 'đào than lộ thiên quanh đây', 'đào thêm than', coalHit.name, 10);
          if (res) return res;
        }
      }

      // 8c. Chop nearby natural trees when wood reserves are low
      const logCount = countOf((n) => n.endsWith('_log') || n.endsWith('_stem'));
      const woodUnits = countOf((n) => n.endsWith('_planks') || n === 'planks') + logCount * 4;
      if (logCount < 20 && woodUnits < 80) {
        const treeHit = findSafeIdleTreeTarget(bot, { maxDistance: farmDist, homePos, chestPos });
        if (treeHit) {
          const res = await runAutoGather('auto_farm_wood', 'tu_farm_go', 'chặt cây tự nhiên quanh đây', 'chặt ít gỗ', treeHit.name, 8);
          if (res) return res;
        }
      }

      // 8d. Mine natural stone when cobblestone reserve is low (prefer exposed, fallback to shallow underground)
      const cobbleCount = countOf((n) => n === 'cobblestone' || n === 'cobbled_deepslate');
      if (pickTier !== 'none' && cobbleCount < 32) {
        const stoneOpts = {
          maxDistance: Math.min(20, farmDist),
          homePos,
          chestPos,
          protectHomeRadius: 8,
          checkStructureNeighbors: true,
        };
        const stoneHit =
          findSafeIdleMineralTarget(bot, ['stone', 'deepslate'], { ...stoneOpts, requireExposed: true }) ??
          findSafeIdleMineralTarget(bot, ['stone', 'deepslate'], {
            ...stoneOpts,
            maxDistance: Math.min(16, farmDist),
            requireExposed: false,
            maxDepthBelowBot: 8,
          });
        if (stoneHit) {
          const res = await runAutoGather('auto_farm_stone', 'tu_farm_da', 'đào đá tự nhiên dự phòng', 'đào ít đá', stoneHit.name, 12);
          if (res) return res;
        }
      }

      // 8e. Extended progression: shallow underground ores, deeper wood/stone reserves, and short safe ore prospecting
      if ((pickTier === 'stone' || pickTier === 'iron' || pickTier === 'diamond') && ironSupply < 24) {
        const buriedIron = findSafeIdleMineralTarget(
          bot,
          ['iron_ore', 'deepslate_iron_ore'],
          { maxDistance: Math.min(16, oreDist), homePos, chestPos, requireExposed: false, maxDepthBelowBot: 10 }
        );
        if (buriedIron) {
          const res = await runAutoGather('auto_farm_iron_underground', 'tu_farm_sat_ngam', 'đào bậc thang xuống lấy quặng sắt nông', 'đào xuống kiếm sắt', buriedIron.name, 8);
          if (res) return res;
        }
      }

      if (pickTier !== 'none' && coalCount < 24) {
        const buriedCoal = findSafeIdleMineralTarget(
          bot,
          ['coal_ore', 'deepslate_coal_ore'],
          { maxDistance: Math.min(16, oreDist), homePos, chestPos, requireExposed: false, maxDepthBelowBot: 10 }
        );
        if (buriedCoal) {
          const res = await runAutoGather('auto_farm_coal_underground', 'tu_farm_than_ngam', 'đào bậc thang xuống lấy than nông', 'đào xuống kiếm than', buriedCoal.name, 10);
          if (res) return res;
        }
      }

      if (pickTier !== 'none' && cobbleCount < 64) {
        const extraStoneOpts = {
          maxDistance: Math.min(20, farmDist),
          homePos,
          chestPos,
          protectHomeRadius: 8,
          checkStructureNeighbors: true,
        };
        const extraStone =
          findSafeIdleMineralTarget(bot, ['stone', 'deepslate'], { ...extraStoneOpts, requireExposed: true }) ??
          findSafeIdleMineralTarget(bot, ['stone', 'deepslate'], {
            ...extraStoneOpts,
            maxDistance: Math.min(16, farmDist),
            requireExposed: false,
            maxDepthBelowBot: 8,
          });
        if (extraStone) {
          const res = await runAutoGather('auto_farm_stone_stockpile', 'tu_farm_da', 'tích trữ thêm đá cuội', 'đào thêm đá dự trữ', extraStone.name, 16);
          if (res) return res;
        }
      }

      if (logCount < 36 && woodUnits < 144) {
        const extraTree = findSafeIdleTreeTarget(bot, { maxDistance: farmDist, homePos, chestPos });
        if (extraTree) {
          const res = await runAutoGather('auto_farm_wood_stockpile', 'tu_farm_go', 'tích trữ thêm gỗ', 'chặt thêm ít gỗ dự trữ', extraTree.name, 8);
          if (res) return res;
        }
      }

      if (
        typeof mining?.digTunnel === 'function' &&
        (pickTier === 'stone' || pickTier === 'iron' || pickTier === 'diamond') &&
        ironSupply < 16 &&
        (bot.food ?? 20) >= 14 &&
        emptySlots > 4 &&
        (!homePos || Math.hypot(bot.entity.position.x - homePos.x, bot.entity.position.z - homePos.z) > 8)
      ) {
        const tunnelRes = await launch('auto_prospect_tunnel', 'tu_do_quang', 'đào hầm ngắn dò quặng sắt/than', async (signal) => {
          announceAutoFarm('đào hầm ngắn dò quặng');
          const r = await mining.digTunnel(8, signal);
          if (!(r?.steps > 0)) {
            this._autonomyFailCooldown.set('auto_prospect_tunnel', Date.now() + 60000);
            return false;
          }
          return true;
        }, { autoFarm: true });
        if (tunnelRes) return tunnelRes;
      }
    }

    return null;
  }

  async tickIdle(now = Date.now()) {
    const { bot, config, tasks, combat, equipment, survival, humanizer, state } = this.ctx;
    if (this.disposed || !this.enabledIdle || !bot.entity?.position) return false;
    if (
      state.aiPaused ||
      state.disconnected ||
      combat.busy ||
      survival.busy ||
      tasks.active ||
      bot.isSleeping ||
      bot.currentWindow ||
      bot.targetDigBlock
    ) {
      return false;
    }

    // 1. Subtle ambient dusk remark
    const timeOfDay = bot.time?.timeOfDay;
    const age = bot.time?.age;
    const dayIndex = age != null ? Math.floor(age / 24000) : Math.floor(now / 1200000);
    if (
      config.companion?.ambientChatter !== false &&
      typeof timeOfDay === 'number' &&
      timeOfDay >= 11600 &&
      timeOfDay <= 12400 &&
      now - this._lastAmbientChatAt >= 120000 &&
      dayIndex !== this._lastDuskDay
    ) {
      this._lastDuskDay = dayIndex;
      this._lastAmbientChatAt = now;
      const msg = 'Ơ trời xẩm tối rồi kìa, cẩn thận quái sắp ra nha!';
      try {
        bot.chat?.(msg);
        this.ctx.pushChatHistory?.('assistant', msg);
      } catch {}
    }

    // 2. Self-care & weapon readiness (runs even when staying put)
    if (now - this._lastSelfCareAt >= 4000) {
      this._lastSelfCareAt = now;
      if ((bot.food ?? 20) <= 17) {
        survival.autoEat?.().catch(() => {});
      }
      const heldName = String(bot.heldItem?.name ?? '').toLowerCase();
      const isUsefulHeld = heldName.endsWith('_sword') || heldName.endsWith('_axe') || heldName === 'bow';
      if (!isUsefulHeld) {
        const hasWeapon = (bot.inventory?.items?.() ?? []).some(
          (i) => i?.name?.endsWith('_sword') || i?.name?.endsWith('_axe')
        );
        if (hasWeapon) {
          equipment.equipMelee?.().catch(() => {});
        }
      }
    }

    if (state.stayPut) return false;

    const ownerEntity = bot.players?.[config.owner]?.entity ?? null;
    const distToOwner = ownerEntity?.position ? bot.entity.position.distanceTo(ownerEntity.position) : null;
    const idleFollowRange = config.companion?.idleFollowRange ?? 6.5;

    // 3. Natural companion escort when owner walks away (release immediately once stopped inside follow range)
    if (this._escortingOwner && state.idleGoalActive) {
      if (
        distToOwner == null ||
        distToOwner <= 3.8 ||
        distToOwner > 48 ||
        (!bot.pathfinder?.isMoving?.() && distToOwner <= idleFollowRange)
      ) {
        this.stopIdleMotion();
      } else {
        return true;
      }
    }
    if (distToOwner != null && distToOwner > idleFollowRange && distToOwner <= 48) {
      this._escortingOwner = true;
      state.idleGoalActive = true;
      try { bot.pathfinder?.setGoal?.(new goals.GoalFollow(ownerEntity, 3.2), true); } catch {}
      return true;
    }

    // 4. Polite step-back when crowding owner or standing in front of their crosshair (only when both are stationary)
    const ownerMoving = Math.hypot(ownerEntity?.velocity?.x ?? 0, ownerEntity?.velocity?.z ?? 0) > 0.08;
    let inCrosshair = false;
    let sideAngles = null;
    if (
      !ownerMoving &&
      !this._escortingOwner &&
      ownerEntity?.position &&
      typeof ownerEntity.yaw === 'number' &&
      Math.abs(bot.entity.position.y - ownerEntity.position.y) <= 2
    ) {
      const fx = -Math.sin(ownerEntity.yaw);
      const fz = -Math.cos(ownerEntity.yaw);
      const dx = bot.entity.position.x - ownerEntity.position.x;
      const dz = bot.entity.position.z - ownerEntity.position.z;
      const fwdDot = dx * fx + dz * fz;
      const perpDist = Math.abs(dx * (-fz) + dz * fx);
      if (fwdDot > 0.3 && fwdDot <= 3.2 && perpDist <= 0.7) {
        inCrosshair = true;
        const t1 = Math.atan2(fx, -fz);
        const t2 = Math.atan2(-fx, fz);
        sideAngles = [t1, t2, t1 + 0.5, t2 - 0.5, Math.PI, 0];
      }
    }

    if ((inCrosshair || (!this._escortingOwner && distToOwner != null && distToOwner < 1.35)) && now - this._lastStepBackAt >= 6500) {
      this._lastStepBackAt = now;
      this._escortingOwner = false;
      const stepDist = inCrosshair ? Math.max(2.6, Math.min(3.4, (distToOwner ?? 2.6))) : 2.6;
      const angles = sideAngles ?? [0, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI / 4, -Math.PI / 4];
      const spot = findSafeOffsetSpot(bot, ownerEntity.position, stepDist, angles);
      if (spot && bot.pathfinder) {
        state.idleGoalActive = true;
        try { bot.pathfinder.setGoal(new goals.GoalNear(spot.x, spot.y, spot.z, 0.8)); } catch {}
        return true;
      }
    }

    // 5. Pick up nearby loose items (skip while moving, right after giveToOwner/discard, or trash/owner-tossed junk)
    const emptySlots = typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 10;
    const lastGaveAt = survival?.lastGaveItemAt ?? 0;
    const lastDiscardAt = equipment?.lastDiscardAt ?? 0;
    if (
      !bot.pathfinder?.isMoving?.() &&
      now - lastGaveAt >= 8000 &&
      now - lastDiscardAt >= 6000 &&
      now - this._lastPickupAt >= 5000 &&
      emptySlots > 2
    ) {
      const bp = bot.entity.position;
      const hasChestAvailable = Boolean(
        this.ctx.home?.getStorageChest?.() ||
        (typeof bot.findBlock === 'function' && bot.findBlock({
          matching: (b) => b && (b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel'),
          maxDistance: 24,
        }))
      );
      let bestItem = null;
      let bestDist = Infinity;
      for (const e of Object.values(bot.entities ?? {})) {
        if (!e?.position) continue;
        if (e.name !== 'item' && e.objectType !== 'Item') continue;
        const d = bp.distanceTo(e.position);
        if (d > 7 || Math.abs(e.position.y - bp.y) > 2) continue;
        if (ownerEntity?.position && e.position.distanceTo(ownerEntity.position) <= 2.2) continue;
        if (equipment?.shouldPickupDroppedEntity && !equipment.shouldPickupDroppedEntity(e, { ownerEntity, hasChestAvailable, now })) {
          continue;
        }
        if (!isSafeIdleSpot(bot, e.position)) continue;
        if (d < bestDist) {
          bestDist = d;
          bestItem = e;
        }
      }
      if (bestItem && bot.pathfinder) {
        this._lastPickupAt = now;
        state.idleGoalActive = true;
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(bestItem.position.x, bestItem.position.y, bestItem.position.z, 1));
        } catch {}
        return true;
      }
    }

    // 5b. Autonomous self-upgrade & survival autonomy when safe and idle
    this._tickAutoCloseDoors(now);
    const upgradeStarted = await this.tickAutoUpgrade(now);
    if (upgradeStarted?.started) return true;
    const autonomyStarted = await this.tickSurvivalAutonomy(now);
    if (autonomyStarted?.started) return true;

    // 6. Ambient stroll / creature & owner observation (never interrupt active idle movement)
    if (!bot.pathfinder?.isMoving?.() && now >= this._nextWanderAt) {
      const interval = config.companion?.idleWanderIntervalMs ?? 14000;
      this._nextWanderAt = now + interval + Math.floor(Math.random() * 6000);

      const bp = bot.entity.position;
      const nearbyAnimal = Object.values(bot.entities ?? {}).find(
        (e) => e?.position && PASSIVE_ANIMALS.has(String(e.name ?? '').toLowerCase()) && bp.distanceTo(e.position) <= 10
      );

      if (!bot.pathfinder || Math.random() < 0.5) {
        const lookTarget = nearbyAnimal?.position ?? ownerEntity?.position;
        if (lookTarget && humanizer?.smoothLookAt) {
          humanizer.smoothLookAt(
            { x: lookTarget.x, y: lookTarget.y + 1.2, z: lookTarget.z },
            { steps: 4 }
          ).catch(() => {});
          if (ownerEntity && !nearbyAnimal && Math.random() < 0.35) {
            humanizer.expressGesture?.('nod', { unsafe: false }).catch(() => {});
          }
        }
        return true;
      }

      const anchor = ownerEntity?.position ?? bp;
      const angles = Array.from({ length: 4 }, () => Math.random() * Math.PI * 2);
      for (const angle of angles) {
        const dist = 2.5 + Math.random() * 2.0;
        const cand = findSafeOffsetSpot(bot, anchor, dist, [angle]);
        if (!cand) continue;
        if (ownerEntity?.position) {
          const od = cand.distanceTo(ownerEntity.position);
          if (od < 2.2 || od > 6.5) continue;
        }
        state.idleGoalActive = true;
        try { bot.pathfinder.setGoal(new goals.GoalNear(cand.x, cand.y, cand.z, 1)); } catch {}
        return true;
      }
    }

    return false;
  }

  dispose() {
    this.disposed = true;
    if (this._chatTimer) {
      clearTimeout(this._chatTimer);
      this._chatTimer = null;
    }
  }
}

export default CompanionManager;
