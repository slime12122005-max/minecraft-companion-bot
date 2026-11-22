import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { resolveCandidateNames } from './survival.js';

const KEEP_SLOTS_TOOLS = ['_sword', '_axe', '_pickaxe', '_shovel', '_hoe', 'bow', 'crossbow', 'shield', 'water_bucket', 'totem_of_undying'];
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
  }

  setStorageChest(position) {
    if (!position) return null;
    const chest = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    };
    this.memory?.set('storageChest', chest);
    this.log(`📦 Đã lưu rương nhà tại ${chest.x}, ${chest.y}, ${chest.z}`);
    return chest;
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

    for (const item of items) {
      if (!item || isProtectedItem(item)) continue;
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

  async storeSurplus(chestTarget) {
    if (!chestTarget) {
      this.log('Chưa có rương chứa đồ được chỉ định.');
      return false;
    }

    let chestWindow = null;
    let openedHere = false;

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

      let stored = 0;
      for (const { item, countToDeposit } of this._collectSurplusItems()) {
        try {
          await chestWindow.deposit(item.type, item.metadata ?? null, countToDeposit);
          stored += countToDeposit;
        } catch (err) {
          this.log(`Không thể cất ${item.name}: ${err.message}`);
        }
      }

      if (chestTarget.position) {
        this._indexChestWindow(chestTarget.position, chestWindow);
      }
      this.log(`📦 Đã cất ${stored} vật phẩm vào rương nhà.`);
      return stored > 0;
    } finally {
      if (openedHere && typeof chestWindow?.close === 'function') {
        try { chestWindow.close(); } catch {}
      }
    }
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
}

export default HomeManager;
