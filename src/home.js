import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { resolveCandidateNames } from './survival.js';
import { rank, getEnchantmentBonus, getDurabilityRatio } from './equipment.js';

const KEEP_SLOTS_TOOLS = ['_sword', '_axe', '_pickaxe', '_shovel', '_hoe', 'bow', 'crossbow', 'shield', 'water_bucket', 'bucket', 'totem_of_undying'];
const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet'];
const ARMOR_SLOT_INDEX = { head: 5, torso: 6, legs: 7, feet: 8 };
const ARMOR_SUFFIX_TO_SLOT = { _helmet: 'head', _chestplate: 'torso', _leggings: 'legs', _boots: 'feet' };
const CHEST_BLOCK_NAMES = new Set(['chest', 'trapped_chest', 'barrel']);
const BASE_UTILITY_NAMES = [
  'white_bed', 'red_bed', 'blue_bed', 'black_bed', 'brown_bed', 'cyan_bed',
  'gray_bed', 'green_bed', 'light_blue_bed', 'light_gray_bed', 'lime_bed',
  'magenta_bed', 'orange_bed', 'pink_bed', 'purple_bed', 'yellow_bed',
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker', 'crafting_table',
];

function gearScore(item) {
  if (!item) return 0;
  const dur = getDurabilityRatio(item);
  const penalty = dur < 0.15 ? -1.5 : 0;
  return rank(item) + penalty + dur * 0.25 + getEnchantmentBonus(item);
}

function armorSlotOf(name) {
  const n = String(name ?? '').toLowerCase();
  for (const [suffix, slot] of Object.entries(ARMOR_SUFFIX_TO_SLOT)) {
    if (n.endsWith(suffix)) return slot;
  }
  return null;
}

function toolBucketOf(name) {
  const n = String(name ?? '').toLowerCase();
  if (n === 'water_bucket' || n === 'bucket') return 'water_or_bucket';
  if (n === 'shield' || n === 'bow' || n === 'crossbow' || n === 'totem_of_undying') return n;
  for (const suffix of ['_sword', '_axe', '_pickaxe', '_shovel', '_hoe']) {
    if (n.endsWith(suffix)) return suffix;
  }
  return null;
}
const FOOD_NAMES = new Set([
  'apple', 'golden_apple', 'enchanted_golden_apple', 'bread', 'carrot', 'golden_carrot',
  'baked_potato', 'potato', 'cooked_beef', 'beef', 'cooked_porkchop', 'porkchop',
  'cooked_chicken', 'chicken', 'cooked_mutton', 'mutton', 'cooked_rabbit', 'rabbit',
  'cooked_cod', 'cod', 'cooked_salmon', 'salmon', 'mushroom_stew', 'rabbit_stew',
  'beetroot_soup', 'cookie', 'melon_slice', 'sweet_berries', 'glow_berries', 'pumpkin_pie',
]);
const BUILDING_BLOCK_NAMES = new Set([
  'dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'netherrack',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
]);

export const STORAGE_CATEGORIES = Object.freeze(['minerals', 'wood_build', 'gear', 'food', 'misc']);

export function classifyItemCategory(itemName) {
  const n = String(itemName ?? '').toLowerCase();
  if (!n) return 'misc';
  if (FOOD_NAMES.has(n)) return 'food';
  if (
    /(?:_ore|_ingot|_nugget|raw_iron|raw_gold|raw_copper|diamond|emerald|coal|charcoal|redstone|lapis|quartz|netherite_scrap|amethyst_shard)/.test(n)
  ) {
    return 'minerals';
  }
  if (
    /(?:_sword|_axe|_pickaxe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|bow|crossbow|arrow|shield|totem_of_undying|shears|flint_and_steel)/.test(n)
  ) {
    return 'gear';
  }
  if (
    BUILDING_BLOCK_NAMES.has(n) ||
    /(?:_log|_wood|_stem|_planks|stone|deepslate|sand|gravel|glass|brick|concrete|terracotta|_stairs|_slab|_wall|_fence|_wool|netherrack|obsidian|clay)/.test(n)
  ) {
    return 'wood_build';
  }
  return 'misc';
}

function isProtectedItem(item) {
  const name = item?.name?.toLowerCase() ?? '';
  if (!name) return true;
  if (name.endsWith('_helmet') || name.endsWith('_chestplate') || name.endsWith('_leggings') || name.endsWith('_boots')) {
    return true;
  }
  return KEEP_SLOTS_TOOLS.some(suffix => name === suffix || name.endsWith(suffix));
}

function isFood(item) {
  return FOOD_NAMES.has(item?.name?.toLowerCase() ?? '');
}

function isBuildingBlock(item) {
  return BUILDING_BLOCK_NAMES.has(item?.name?.toLowerCase() ?? '');
}

function chestKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function readChestItems(chestWindow) {
  if (typeof chestWindow?.containerItems === 'function') {
    return chestWindow.containerItems() ?? [];
  }
  const end = chestWindow?.inventoryStart ?? (chestWindow?.slots?.length ?? 0);
  return (chestWindow?.slots ?? []).slice(0, end).filter(Boolean);
}

export class HomeManager {
  constructor(bot, config = {}, { memory, log = () => {} } = {}) {
    this.bot = bot;
    this.config = config.home ?? {};
    this.inventoryConfig = config.inventory ?? {};
    this.memory = memory;
    this.log = log;
  }

  set(origin) {
    if (!origin?.position) return false;
    const home = {
      x: Math.round(origin.position.x),
      y: Math.round(origin.position.y),
      z: Math.round(origin.position.z),
      dimension: origin.dimension ?? 'overworld',
      setAt: Date.now(),
    };
    this.memory?.set('home', home);
    this.memory?.delete?.('homeAuto');
    this.memory?.upsertPoi?.({
      category: 'waypoint',
      label: 'home',
      dimension: home.dimension,
      x: home.x,
      y: home.y,
      z: home.z,
      metadata: { isHome: true },
    });
    this.log(`🏠 Nhà đã được đặt tại ${home.x}, ${home.y}, ${home.z}`);
    return home;
  }

  get() {
    return this.memory?.get('home');
  }

  clear() {
    this.memory?.delete('home');
    this.memory?.delete?.('homeAuto');
  }

  setStorageChest(position) {
    if (!position) return null;
    const chest = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    };
    this.memory?.set('storageChest', chest);
    this.memory?.delete?.('chestAuto');
    this.log(`📦 Đã lưu rương nhà tại ${chest.x}, ${chest.y}, ${chest.z}`);
    return chest;
  }

  autoSetFromBed(position, dimension = 'overworld') {
    if (!position || this.config.setOnCommand === false) return null;
    if (this.get() && !this.memory?.get('homeAuto')) return null;
    const home = {
      x: Math.round(position.x),
      y: Math.round(position.y),
      z: Math.round(position.z),
      dimension: String(dimension ?? 'overworld'),
      setAt: Date.now(),
    };
    this.memory?.set('home', home);
    this.memory?.set('homeAuto', true);
    this.memory?.upsertPoi?.({
      category: 'waypoint',
      label: 'home',
      dimension: home.dimension,
      x: home.x,
      y: home.y,
      z: home.z,
      metadata: { isHome: true, autoDetected: true },
    });
    this.log(`🏠 Tự nhận diện giường làm điểm nhà (${home.x}, ${home.y}, ${home.z}).`);
    return home;
  }

  detectNearbyBase({ radius = 12 } = {}) {
    if (
      this.config.setOnCommand === false ||
      typeof this.bot?.findBlocks !== 'function' ||
      !this.bot?.registry?.blocksByName
    ) {
      return null;
    }

    const blocksByName = this.bot.registry.blocksByName;
    const idToKind = new Map();
    for (const [name, info] of Object.entries(blocksByName)) {
      if (!info?.id) continue;
      if (name.endsWith('_bed')) idToKind.set(info.id, 'bed');
      else if (CHEST_BLOCK_NAMES.has(name)) idToKind.set(info.id, 'chest');
      else if (BASE_UTILITY_NAMES.includes(name)) idToKind.set(info.id, 'utility');
    }
    if (idToKind.size === 0) return null;

    const positions = this.bot.findBlocks({
      matching: [...idToKind.keys()],
      maxDistance: radius,
      count: 24,
    }) ?? [];
    if (positions.length < 3) return null;

    let bedPos = null;
    let chestPos = null;
    for (const p of positions) {
      const b = this.bot.blockAt?.(p);
      const bName = b?.name?.toLowerCase?.() ?? '';
      if (!bedPos && bName.endsWith('_bed')) bedPos = p;
      if (!chestPos && CHEST_BLOCK_NAMES.has(bName)) chestPos = p;
    }
    if (!bedPos && !chestPos) return null;

    if (!this.get()) {
      const anchor = bedPos ?? chestPos;
      const dim = String(this.bot.game?.dimension ?? 'overworld');
      const home = {
        x: Math.round(anchor.x),
        y: Math.round(anchor.y),
        z: Math.round(anchor.z),
        dimension: dim,
        setAt: Date.now(),
      };
      this.memory?.set('home', home);
      this.memory?.set('homeAuto', true);
      this.memory?.upsertPoi?.({
        category: 'waypoint',
        label: 'home',
        dimension: dim,
        x: home.x,
        y: home.y,
        z: home.z,
        metadata: { isHome: true, autoDetected: true },
      });
      this.log(`🏠 Tự nhận diện căn cứ gần đây làm nhà tại ${home.x}, ${home.y}, ${home.z}.`);
    }

    if (!this.getStorageChest() && chestPos) {
      const chest = {
        x: Math.floor(chestPos.x),
        y: Math.floor(chestPos.y),
        z: Math.floor(chestPos.z),
      };
      this.memory?.set('storageChest', chest);
      this.memory?.set('chestAuto', true);
      this.log(`📦 Tự nhận diện rương căn cứ tại ${chest.x}, ${chest.y}, ${chest.z}.`);
    }

    return { home: this.get() ?? null, storageChest: this.getStorageChest() ?? null };
  }

  getStorageChest() {
    const saved = this.memory?.get('storageChest');
    if (saved) return saved;
    const cfg = this.config.storageChest;
    if (cfg && Number.isFinite(cfg.x) && Number.isFinite(cfg.y) && Number.isFinite(cfg.z)) {
      return { x: Math.floor(cfg.x), y: Math.floor(cfg.y), z: Math.floor(cfg.z) };
    }
    return null;
  }

  assignCategoryChest(category, position) {
    if (!position) return null;
    const cat = STORAGE_CATEGORIES.includes(category) ? category : 'misc';
    const chest = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    };
    const map = { ...(this.memory?.get('categoryChests', {}) ?? {}) };
    map[cat] = chest;
    this.memory?.set('categoryChests', map);
    this.memory?.upsertPoi?.({
      category: 'chest',
      label: chestKey(chest),
      dimension: String(this.bot?.game?.dimension ?? 'overworld'),
      x: chest.x,
      y: chest.y,
      z: chest.z,
      metadata: { storageCategory: cat },
    });
    return chest;
  }

  getCategoryChest(category) {
    const map = this.memory?.get('categoryChests', {}) ?? {};
    return map[category] ?? null;
  }

  listCategoryChests() {
    return { ...(this.memory?.get('categoryChests', {}) ?? {}) };
  }

  isInventoryNearFull(threshold = 0.80) {
    if (typeof this.bot.inventory?.emptySlotCount === 'function') {
      const empty = this.bot.inventory.emptySlotCount();
      return (36 - empty) / 36 >= threshold;
    }
    const items = this.bot.inventory?.items?.() ?? [];
    return items.length / 36 >= threshold;
  }

  _indexChestWindow(position, chestWindow) {
    if (!position || !chestWindow || !this.memory) return null;
    const key = chestKey(position);
    const contents = {};
    for (const item of readChestItems(chestWindow)) {
      if (!item?.name) continue;
      contents[item.name] = (contents[item.name] ?? 0) + (item.count ?? 1);
    }
    const index = { ...(this.memory.get('chestIndex', {}) ?? {}) };
    index[key] = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
      items: contents,
      updatedAt: Date.now(),
    };
    this.memory.set('chestIndex', index);
    this.memory.replaceChestIndex?.(key, contents);
    this.memory.upsertPoi?.({
      category: 'chest',
      label: key,
      dimension: String(this.bot?.game?.dimension ?? 'overworld'),
      x: index[key].x,
      y: index[key].y,
      z: index[key].z,
      metadata: { itemKinds: Object.keys(contents).length },
    });
    return index[key];
  }

  findInChests(targetText) {
    const candidates = resolveCandidateNames(targetText);
    const index = this.memory?.get('chestIndex', {}) ?? {};
    const hits = [];
    for (const entry of Object.values(index)) {
      for (const [itemName, count] of Object.entries(entry.items ?? {})) {
        const lower = itemName.toLowerCase();
        if (count > 0 && candidates.some(c => lower === c || lower.includes(c))) {
          hits.push({ x: entry.x, y: entry.y, z: entry.z, name: itemName, count });
        }
      }
    }
    return hits.sort((a, b) => b.count - a.count);
  }

  listChestInventory() {
    const index = this.memory?.get('chestIndex', {}) ?? {};
    const totals = {};
    for (const entry of Object.values(index)) {
      for (const [name, count] of Object.entries(entry.items ?? {})) {
        totals[name] = (totals[name] ?? 0) + count;
      }
    }
    return totals;
  }

  async returnHome() {
    const home = this.get();
    if (!home) {
      this.log('Chưa có nhà nào được đặt.');
      return false;
    }
    if (this.bot.pathfinder) {
      try {
        this.bot.pathfinder.setGoal(new goals.GoalNear(home.x, home.y, home.z, 2));
        this.log('🏠 Đang về nhà...');
        return true;
      } catch (err) {
        this.log(`Không thể về nhà: ${err.message}`);
      }
    }
    return false;
  }

  async takeFromChest(chestBlock, targetText, count = 1) {
    if (!chestBlock || typeof this.bot.openChest !== 'function') {
      throw new Error('Không thể mở rương.');
    }
    if (
      this.bot.pathfinder?.goto &&
      this.bot.entity?.position &&
      chestBlock.position &&
      this.bot.entity.position.distanceTo(chestBlock.position) > 4
    ) {
      await this.bot.pathfinder.goto(
        new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z)
      );
    }

    const candidates = resolveCandidateNames(targetText);
    const chestWindow = await this.bot.openChest(chestBlock);
    try {
      const containerItems = readChestItems(chestWindow);
      const exactMatched = containerItems.filter(i => candidates.includes(i?.name?.toLowerCase() ?? ''));
      const matched = exactMatched.length > 0
        ? exactMatched
        : containerItems.filter(i => candidates.some(c => (i?.name?.toLowerCase() ?? '').includes(c)));
      if (matched.length === 0) {
        this._indexChestWindow(chestBlock.position, chestWindow);
        return { name: targetText, count: 0 };
      }

      let remaining = Math.max(1, count);
      let withdrawn = 0;
      const itemName = matched[0].name;
      for (const stack of matched) {
        if (remaining <= 0) break;
        const amt = Math.min(remaining, stack.count);
        if (amt <= 0) continue;
        await chestWindow.withdraw(stack.type, stack.metadata ?? null, amt);
        remaining -= amt;
        withdrawn += amt;
      }
      this._indexChestWindow(chestBlock.position, chestWindow);
      this.log(`📤 Đã lấy ${withdrawn} ${itemName} từ rương.`);
      return { name: itemName, count: withdrawn };
    } finally {
      try { chestWindow.close?.(); } catch {}
    }
  }

  _collectSurplusItems() {
    const items = this.bot.inventory?.items?.() ?? [];
    let foodKept = 0;
    let blockStacksKept = 0;
    const keepFoodLimit = Math.max(0, Number(this.inventoryConfig.keepFood ?? 16));
    const keepBlockStacks = Math.max(0, Number(this.inventoryConfig.blockStacks ?? 1));
    const plan = [];

    // Decide which single primary piece per armor slot and per tool bucket stays in inventory,
    // allowing at most 1 golden_helmet (Nether safety) and 1 unenchanted diamond+ blank when
    // an enchanted lower-tier item is primary; duplicate/spare gear gets deposited to chest.
    const keepGearItems = new Set();
    const slots = this.bot.inventory?.slots ?? [];
    const held = this.bot.heldItem ?? null;

    for (const slot of ARMOR_SLOTS) {
      const equipped = slots[ARMOR_SLOT_INDEX[slot]] ?? null;
      const matches = items.filter((i) => armorSlotOf(i?.name) === slot);
      const bestInv = [...matches].sort((a, b) => gearScore(b) - gearScore(a))[0];
      const eqScore = equipped ? gearScore(equipped) : -Infinity;
      const primary = bestInv && gearScore(bestInv) > eqScore + 0.01 ? bestInv : equipped;
      if (bestInv && primary === bestInv) {
        keepGearItems.add(bestInv);
      }
      if (primary && rank(primary) < 5) {
        const blank = matches.find((i) => rank(i) >= 5 && getEnchantmentBonus(i) === 0);
        if (blank) keepGearItems.add(blank);
      }
    }

    const eqHead = slots[ARMOR_SLOT_INDEX.head] ?? null;
    if (!eqHead || String(eqHead.name ?? '').toLowerCase() !== 'golden_helmet') {
      const goldHelm = items
        .filter((i) => String(i?.name ?? '').toLowerCase() === 'golden_helmet' && getDurabilityRatio(i) >= 0.2)
        .sort((a, b) => gearScore(b) - gearScore(a))[0];
      if (goldHelm) keepGearItems.add(goldHelm);
    }

    const toolGroups = new Map();
    for (const item of items) {
      const bucket = toolBucketOf(item?.name);
      if (!bucket) continue;
      if (!toolGroups.has(bucket)) toolGroups.set(bucket, []);
      toolGroups.get(bucket).push(item);
    }
    for (const [bucket, matches] of toolGroups.entries()) {
      const sorted = [...matches].sort((a, b) => {
        if (bucket === 'water_or_bucket') {
          const aw = String(a?.name ?? '').toLowerCase() === 'water_bucket' ? 1 : 0;
          const bw = String(b?.name ?? '').toLowerCase() === 'water_bucket' ? 1 : 0;
          if (bw !== aw) return bw - aw;
        }
        return gearScore(b) - gearScore(a);
      });
      const heldSameBucket = held && toolBucketOf(held.name) === bucket ? held : null;
      const bestInv = sorted[0];
      const primary = heldSameBucket && gearScore(heldSameBucket) >= gearScore(bestInv)
        ? heldSameBucket
        : bestInv;
      if (bestInv && primary === bestInv) {
        keepGearItems.add(bestInv);
      }
      if (primary && rank(primary) < 5 && ['_sword', '_axe', '_pickaxe', '_shovel'].includes(bucket)) {
        const blank = matches.find((i) => rank(i) >= 5 && getEnchantmentBonus(i) === 0);
        if (blank) keepGearItems.add(blank);
      }
    }

    for (const item of items) {
      if (!item) continue;
      const name = String(item.name ?? '').toLowerCase();
      if (!name) continue;
      if (isProtectedItem(item)) {
        if (keepGearItems.has(item)) {
          const cnt = item.count ?? 1;
          if (cnt > 1) plan.push({ item, countToDeposit: cnt - 1 });
          continue;
        }
        plan.push({ item, countToDeposit: item.count ?? 1 });
        continue;
      }
      let countToDeposit = item.count ?? 0;
      if (isFood(item) && foodKept < keepFoodLimit) {
        const keep = Math.min(countToDeposit, keepFoodLimit - foodKept);
        foodKept += keep;
        countToDeposit -= keep;
      } else if (isBuildingBlock(item) && blockStacksKept < keepBlockStacks) {
        blockStacksKept++;
        continue;
      }
      if (countToDeposit > 0) plan.push({ item, countToDeposit });
    }
    return plan;
  }

  countSurplusStacks() {
    return this._collectSurplusItems().length;
  }

  async storeSurplus(chestTarget) {
    if (!chestTarget) {
      this.log('Chưa có rương chứa đồ được chỉ định.');
      return false;
    }

    let chestWindow = null;
    let openedHere = false;
    let stored = 0;
    const leftover = [];

    try {
      if (typeof chestTarget.deposit === 'function') {
        chestWindow = chestTarget;
      } else {
        if (
          this.bot.pathfinder?.goto &&
          this.bot.entity?.position &&
          chestTarget.position &&
          this.bot.entity.position.distanceTo(chestTarget.position) > 4
        ) {
          await this.bot.pathfinder.goto(
            new goals.GoalGetToBlock(chestTarget.position.x, chestTarget.position.y, chestTarget.position.z)
          );
        }
        if (typeof this.bot.openChest !== 'function') {
          this.log('Bot không hỗ trợ mở rương.');
          return false;
        }
        chestWindow = await this.bot.openChest(chestTarget);
        openedHere = true;
      }

      for (const entry of this._collectSurplusItems()) {
        const { item, countToDeposit } = entry;
        try {
          await chestWindow.deposit(item.type, item.metadata ?? null, countToDeposit);
          stored += countToDeposit;
        } catch (err) {
          this.log(`Không thể cất ${item.name}: ${err.message}`);
          leftover.push(entry);
        }
      }

      if (chestTarget.position) {
        this._indexChestWindow(chestTarget.position, chestWindow);
      }
    } finally {
      if (openedHere && typeof chestWindow?.close === 'function') {
        try { chestWindow.close(); } catch {}
      }
    }

    if (
      leftover.length > 0 &&
      openedHere &&
      chestTarget.position &&
      typeof this.bot.findBlock === 'function' &&
      typeof this.bot.openChest === 'function'
    ) {
      const origin = chestTarget.position;
      const altChest = this.bot.findBlock({
        matching: (b) => {
          if (!b?.position || !CHEST_BLOCK_NAMES.has(b.name)) return false;
          return (
            Math.floor(b.position.x) !== Math.floor(origin.x) ||
            Math.floor(b.position.y) !== Math.floor(origin.y) ||
            Math.floor(b.position.z) !== Math.floor(origin.z)
          );
        },
        maxDistance: 6,
      });
      if (altChest) {
        let altWin = null;
        try {
          if (this.bot.pathfinder?.goto && this.bot.entity?.position && altChest.position && this.bot.entity.position.distanceTo(altChest.position) > 4) {
            await this.bot.pathfinder.goto(new goals.GoalGetToBlock(altChest.position.x, altChest.position.y, altChest.position.z));
          }
          altWin = await this.bot.openChest(altChest);
          for (const { item, countToDeposit } of leftover) {
            try {
              await altWin.deposit(item.type, item.metadata ?? null, countToDeposit);
              stored += countToDeposit;
            } catch (err) {
              this.log(`Rương phụ cũng không cất được ${item.name}: ${err.message}`);
            }
          }
          if (altChest.position) this._indexChestWindow(altChest.position, altWin);
        } catch (err) {
          this.log(`Không mở được rương phụ: ${err.message}`);
        } finally {
          if (typeof altWin?.close === 'function') {
            try { altWin.close(); } catch {}
          }
        }
      }
    }

    this.log(`📦 Đã cất ${stored} vật phẩm vào rương nhà.`);
    return stored > 0;
  }

  async restockEssentialsFromNearbyChest({ maxDistance = 16 } = {}) {
    if (typeof this.bot?.openChest !== 'function') return { withdrawn: [] };

    const items = this.bot.inventory?.items?.() ?? [];
    const slots = this.bot.inventory?.slots ?? [];
    const held = this.bot.heldItem ?? null;

    const allOwned = [...items, ...(held ? [held] : [])];
    const hasWeapon = allOwned.some((i) => {
      const n = String(i?.name ?? '').toLowerCase();
      return n.endsWith('_sword') || n.endsWith('_axe');
    });
    const hasPick = allOwned.some((i) => String(i?.name ?? '').toLowerCase().endsWith('_pickaxe'));
    const missingArmorSlots = ARMOR_SLOTS.filter((slot) => {
      const eq = slots[ARMOR_SLOT_INDEX[slot]];
      if (eq) return false;
      return !items.some((i) => armorSlotOf(i?.name) === slot);
    });
    const foodCount = items.reduce((sum, i) => sum + (isFood(i) ? (i.count ?? 1) : 0), 0);
    const needsWeapon = !hasWeapon;
    const needsPick = !hasPick;
    const needsFood = foodCount < 8;

    if (!needsWeapon && !needsPick && missingArmorSlots.length === 0 && !needsFood) {
      return { withdrawn: [] };
    }

    let chestBlock = null;
    const saved = this.getStorageChest();
    if (saved && this.bot.entity?.position) {
      const dist = Math.hypot(
        this.bot.entity.position.x - saved.x,
        this.bot.entity.position.y - saved.y,
        this.bot.entity.position.z - saved.z
      );
      if (dist <= maxDistance) {
        chestBlock = this.bot.blockAt?.(new Vec3(saved.x, saved.y, saved.z)) ?? null;
        if (chestBlock && !CHEST_BLOCK_NAMES.has(chestBlock.name)) chestBlock = null;
      }
    }
    if (!chestBlock && typeof this.bot.findBlock === 'function') {
      chestBlock = this.bot.findBlock({
        matching: (b) => b && CHEST_BLOCK_NAMES.has(b.name),
        maxDistance: Math.min(8, maxDistance),
      });
    }
    if (!chestBlock) return { withdrawn: [] };

    if (
      this.bot.pathfinder?.goto &&
      this.bot.entity?.position &&
      chestBlock.position &&
      this.bot.entity.position.distanceTo(chestBlock.position) > 4
    ) {
      await this.bot.pathfinder.goto(new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z));
    }

    const chestWindow = await this.bot.openChest(chestBlock);
    const withdrawn = [];
    let gotWeapon = hasWeapon;
    let gotPick = hasPick;
    const coveredArmor = new Set(ARMOR_SLOTS.filter((s) => !missingArmorSlots.includes(s)));
    let remainingFood = needsFood ? Math.max(0, 16 - foodCount) : 0;

    try {
      const containerItems = readChestItems(chestWindow);
      const tryTake = async (stack, qty) => {
        const amt = Math.min(qty, stack.count ?? 1);
        if (amt <= 0) return 0;
        try {
          await chestWindow.withdraw(stack.type, stack.metadata ?? null, amt);
          withdrawn.push(`${amt} ${stack.name}`);
          return amt;
        } catch {
          return 0;
        }
      };

      if (needsWeapon) {
        const bestWpn = containerItems
          .filter((i) => {
            const n = String(i?.name ?? '').toLowerCase();
            return n.endsWith('_sword') || n.endsWith('_axe');
          })
          .sort((a, b) => gearScore(b) - gearScore(a))[0];
        if (bestWpn && await tryTake(bestWpn, 1)) gotWeapon = true;
      }

      if (needsPick) {
        const bestPick = containerItems
          .filter((i) => String(i?.name ?? '').toLowerCase().endsWith('_pickaxe'))
          .sort((a, b) => gearScore(b) - gearScore(a))[0];
        if (bestPick && await tryTake(bestPick, 1)) gotPick = true;
      }

      for (const slot of missingArmorSlots) {
        const piece = containerItems
          .filter((i) => armorSlotOf(i?.name) === slot)
          .sort((a, b) => gearScore(b) - gearScore(a))[0];
        if (piece && await tryTake(piece, 1)) coveredArmor.add(slot);
      }

      if (remainingFood > 0) {
        const foodOrder = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'golden_carrot', 'bread', 'baked_potato', 'cooked_chicken', 'apple', 'carrot'];
        const foods = containerItems
          .filter((i) => isFood(i))
          .sort((a, b) => {
            const ia = foodOrder.indexOf(String(a.name).toLowerCase());
            const ib = foodOrder.indexOf(String(b.name).toLowerCase());
            return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
          });
        for (const f of foods) {
          if (remainingFood <= 0) break;
          const took = await tryTake(f, remainingFood);
          remainingFood -= took;
        }
      }

      // If still missing weapon, pickaxe, or any armor slot, grab crafting materials so tickAutoUpgrade can forge replacements.
      if (!gotWeapon || !gotPick || coveredArmor.size < ARMOR_SLOTS.length) {
        const craftTargets = [
          { match: (n) => n === 'diamond', max: 8 },
          { match: (n) => n === 'iron_ingot', max: 16 },
          { match: (n) => n === 'coal' || n === 'charcoal', max: 8 },
          { match: (n) => n === 'stick' || n.endsWith('_planks'), max: 8 },
        ];
        for (const { match, max } of craftTargets) {
          let need = max;
          for (const stack of containerItems.filter((i) => match(String(i?.name ?? '').toLowerCase()))) {
            if (need <= 0) break;
            need -= await tryTake(stack, need);
          }
        }
      }

      if (chestBlock.position) this._indexChestWindow(chestBlock.position, chestWindow);
    } finally {
      if (typeof chestWindow?.close === 'function') {
        try { chestWindow.close(); } catch {}
      }
    }

    if (withdrawn.length > 0) {
      this.log(`🎒 Đã tự lấy đồ dự phòng từ rương: ${withdrawn.join(', ')}`);
    }
    return { withdrawn };
  }

  async storeSurplusSorted({ openChestForPos = null } = {}) {
    const surplus = this._collectSurplusItems();
    const groups = new Map();
    for (const entry of surplus) {
      const cat = classifyItemCategory(entry.item.name);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(entry);
    }

    const byCategory = {};
    let totalStored = 0;

    for (const [category, entries] of groups.entries()) {
      const pos = this.getCategoryChest(category) ?? this.getStorageChest();
      if (!pos) continue;

      let chestWindow = null;
      let openedHere = false;
      try {
        if (openChestForPos) {
          chestWindow = await openChestForPos(pos, category);
          openedHere = true;
        } else {
          if (
            this.bot.pathfinder?.goto &&
            this.bot.entity?.position &&
            this.bot.entity.position.distanceTo(pos) > 4
          ) {
            await this.bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
          }
          const block = this.bot.blockAt?.(new Vec3(pos.x, pos.y, pos.z));
          if (!block || typeof this.bot.openChest !== 'function') continue;
          chestWindow = await this.bot.openChest(block);
          openedHere = true;
        }
        if (!chestWindow) continue;

        let catStored = 0;
        for (const { item, countToDeposit } of entries) {
          try {
            await chestWindow.deposit(item.type, item.metadata ?? null, countToDeposit);
            catStored += countToDeposit;
            totalStored += countToDeposit;
          } catch (err) {
            this.log(`Không thể cất ${item.name}: ${err.message}`);
          }
        }
        if (catStored > 0) byCategory[category] = (byCategory[category] ?? 0) + catStored;
        this._indexChestWindow(pos, chestWindow);
      } finally {
        if (openedHere && typeof chestWindow?.close === 'function') {
          try { chestWindow.close(); } catch {}
        }
      }
    }

    return { stored: totalStored, byCategory };
  }

  async stashAllForSwitch({ maxDistance = 8 } = {}) {
    if (typeof this.bot?.openChest !== 'function' || !this.bot?.entity?.position) {
      return { stored: 0 };
    }
    const items = [...(this.bot.inventory?.items?.() ?? [])];
    const held = this.bot.heldItem ?? null;
    if (held && !items.includes(held)) {
      items.push(held);
    }
    if (items.length === 0) return { stored: 0 };

    let chestBlock = null;
    const saved = this.getStorageChest();
    if (saved) {
      const d = Math.hypot(
        this.bot.entity.position.x - saved.x,
        this.bot.entity.position.y - saved.y,
        this.bot.entity.position.z - saved.z
      );
      if (d <= maxDistance) {
        const cand = this.bot.blockAt?.(new Vec3(saved.x, saved.y, saved.z)) ?? null;
        if (cand && CHEST_BLOCK_NAMES.has(cand.name)) chestBlock = cand;
      }
    }
    if (!chestBlock && typeof this.bot.findBlock === 'function') {
      chestBlock = this.bot.findBlock({
        matching: (b) => b && CHEST_BLOCK_NAMES.has(b.name),
        maxDistance: Math.min(6, maxDistance),
      });
    }
    if (!chestBlock) return { stored: 0 };

    if (
      this.bot.pathfinder?.goto &&
      chestBlock.position &&
      this.bot.entity.position.distanceTo(chestBlock.position) > 4
    ) {
      await this.bot.pathfinder.goto(
        new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z)
      );
    }

    let chestWindow = null;
    let stored = 0;
    try {
      chestWindow = await this.bot.openChest(chestBlock);
      for (const item of items) {
        const cnt = Math.max(1, Number(item?.count ?? 1));
        if (!item?.type) continue;
        try {
          await chestWindow.deposit(item.type, item.metadata ?? null, cnt);
          stored += cnt;
        } catch {}
      }
      if (chestBlock.position) {
        this._indexChestWindow(chestBlock.position, chestWindow);
      }
    } finally {
      if (typeof chestWindow?.close === 'function') {
        try { chestWindow.close(); } catch {}
      }
    }

    if (stored > 0) {
      this.log(`📦 Đã cất tạm ${stored} vật phẩm vào rương trước khi chuyển kết nối/chế độ.`);
    }
    return { stored };
  }
}

export default HomeManager;
