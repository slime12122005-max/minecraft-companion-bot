const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet'];
const ARMOR_SLOT_INDEX = { head: 5, torso: 6, legs: 7, feet: 8 };
const OFF_HAND_SLOT = 45;
const TOOL_TYPES = ['sword', 'axe', 'pickaxe', 'shovel', 'bow', 'shield'];
const MATERIAL_RANK = {
  wooden: 1,
  leather: 1,
  stone: 2,
  golden: 2,
  gold: 2,
  chainmail: 3,
  iron: 4,
  diamond: 5,
  netherite: 6,
};

function itemName(item) { return item?.name?.toLowerCase() ?? ''; }

function materialOf(name) {
  if (!name) return '';
  const prefix = name.split('_')[0];
  if (Object.hasOwn(MATERIAL_RANK, prefix)) return prefix;
  return Object.keys(MATERIAL_RANK).find((material) => name.includes(material)) ?? '';
}

function typeOf(name) {
  if (name === 'shield' || name === 'bow') return name;
  return TOOL_TYPES.find((type) => name.endsWith(`_${type}`));
}

const ARMOR_MITIGATION_BY_MATERIAL = {
  leather: 0.05,
  golden: 0.08,
  gold: 0.08,
  chainmail: 0.10,
  iron: 0.14,
  diamond: 0.18,
  netherite: 0.20,
};

export function getDurabilityRatio(item) {
  if (!item) return 1;
  const maxDur = Number(item.maxDurability ?? 0);
  const used = item.durabilityUsed ?? item.nbt?.value?.Damage?.value ?? item.components?.damage ?? null;
  if (!(maxDur > 0) || used == null) return 1;
  return Math.max(0, Math.min(1, (maxDur - Number(used)) / maxDur));
}

function hasArrowOrInfinity(items, bow) {
  try {
    const raw = JSON.stringify(bow?.components ?? bow?.nbt ?? '', (_, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase();
    if (raw.includes('infinity')) return true;
  } catch {}
  return items.some(i => {
    const n = itemName(i);
    return n === 'arrow' || n.endsWith('_arrow');
  });
}

export function rank(item) {
  const name = itemName(item);
  return MATERIAL_RANK[materialOf(name)] ?? 0;
}

function slotForArmor(name) {
  if (name.endsWith('_helmet')) return 'head';
  if (name.endsWith('_chestplate')) return 'torso';
  if (name.endsWith('_leggings')) return 'legs';
  if (name.endsWith('_boots')) return 'feet';
  return null;
}

function safeDurabilityRatio(item) {
  const raw = getDurabilityRatio(item);
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
}

const ENCHANT_BONUS_NAMES = new Set([
  'sharpness',
  'smite',
  'bane_of_arthropods',
  'protection',
  'blast_protection',
  'projectile_protection',
  'fire_protection',
  'feather_falling',
  'unbreaking',
  'mending',
  'power',
  'infinity',
  'flame',
  'punch',
  'efficiency',
  'fortune',
  'looting',
  'fire_aspect',
  'sweeping_edge',
  'knockback',
  'thorns',
  'respiration',
  'aqua_affinity',
  'depth_strider',
  'swift_sneak',
  'soul_speed',
]);

export function getEnchantmentBonus(item) {
  if (!item) return 0;
  const entries = [];

  if (Array.isArray(item.enchants)) {
    for (const e of item.enchants) {
      if (e?.name) entries.push({ name: String(e.name).toLowerCase(), lvl: Number(e.lvl ?? e.level ?? 1) || 1 });
    }
  }

  const nbtList = item.nbt?.value?.Enchantments?.value?.value ?? item.nbt?.value?.StoredEnchantments?.value?.value;
  if (Array.isArray(nbtList)) {
    for (const e of nbtList) {
      const id = e?.id?.value ?? e?.name;
      const lvl = e?.lvl?.value ?? e?.level?.value ?? 1;
      if (id) entries.push({ name: String(id).toLowerCase().replace(/^minecraft:/, ''), lvl: Number(lvl) || 1 });
    }
  }

  const compEnchants = item.components?.enchantments?.levels ?? item.components?.enchantments;
  if (compEnchants && typeof compEnchants === 'object' && !Array.isArray(compEnchants)) {
    for (const [k, v] of Object.entries(compEnchants)) {
      entries.push({ name: String(k).toLowerCase().replace(/^minecraft:/, ''), lvl: Number(v) || 1 });
    }
  }

  let bonus = 0;
  let hasCurse = false;
  if (entries.length > 0) {
    for (const { name, lvl } of entries) {
      if (name.includes('binding_curse') || name.includes('vanishing_curse')) {
        hasCurse = true;
      } else if (ENCHANT_BONUS_NAMES.has(name) || ENCHANT_BONUS_NAMES.has(name.replace(/^minecraft:/, ''))) {
        bonus += 0.35 * Math.max(1, lvl);
      } else {
        bonus += 0.25 * Math.max(1, lvl);
      }
    }
  } else if (item.components || item.nbt) {
    try {
      const raw = JSON.stringify(item.components ?? item.nbt, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase();
      if (raw.includes('binding_curse') || raw.includes('vanishing_curse')) hasCurse = true;
      for (const ench of ENCHANT_BONUS_NAMES) {
        if (raw.includes(ench)) bonus += 0.35;
      }
    } catch {}
  }

  const positive = Math.min(1.6, bonus);
  return Number((hasCurse ? positive - 2.0 : positive).toFixed(3));
}

function itemScore(item) {
  if (!item) return 0;
  const baseRank = rank(item);
  const dur = safeDurabilityRatio(item);
  // Heavily worn (<15%) gear yields to a healthy piece one tier lower instead of breaking mid-fight.
  const brokenPenalty = dur < 0.15 ? -1.5 : 0;
  return baseRank + brokenPenalty + dur * 0.25 + getEnchantmentBonus(item);
}

const ALWAYS_JUNK_ITEMS = new Set([
  'rotten_flesh',
  'poisonous_potato',
  'dead_bush',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'seagrass',
  'wheat_seeds',
  'beetroot_seeds',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'kelp',
  'vine',
  'lily_pad',
  'moss_carpet',
  'hanging_roots',
  'spore_blossom',
  'pink_petals',
  'wildflowers',
  'leaf_litter',
  'bush',
  'cactus_flower',
  'dandelion',
  'poppy',
  'blue_orchid',
  'allium',
  'azure_bluet',
  'red_tulip',
  'orange_tulip',
  'white_tulip',
  'pink_tulip',
  'oxeye_daisy',
  'cornflower',
  'lily_of_the_valley',
  'sunflower',
  'lilac',
  'rose_bush',
  'peony',
  'pumpkin_seeds',
  'melon_seeds',
  'torchflower_seeds',
  'pitcher_pod',
  'spider_eye',
  'feather',
  'ink_sac',
  'glow_ink_sac',
  'rabbit_hide',
  'snowball',
  'egg',
  'wooden_hoe',
  'stone_hoe',
]);

const EDIBLE_FOOD_ITEMS = new Set([
  'golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'cooked_beef', 'cooked_porkchop',
  'cooked_mutton', 'cooked_salmon', 'cooked_chicken', 'cooked_cod', 'cooked_rabbit', 'bread',
  'baked_potato', 'pumpkin_pie', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'apple',
  'carrot', 'melon_slice', 'sweet_berries', 'glow_berries', 'cookie', 'beef', 'porkchop',
  'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato', 'beetroot', 'dried_kelp',
]);

const PRECIOUS_LOOT_ITEMS = new Set([
  'diamond', 'emerald', 'netherite_scrap', 'netherite_ingot', 'ancient_debris',
  'iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore',
  'gold_ingot', 'raw_gold', 'gold_ore', 'deepslate_gold_ore',
  'coal', 'charcoal', 'coal_ore', 'deepslate_coal_ore',
  'ender_pearl', 'blaze_rod', 'totem_of_undying', 'elytra', 'enchanted_book',
]);

const IRON_ALWAYS_PICKUP_ITEMS = new Set([
  'iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore', 'iron_block', 'raw_iron_block',
]);

const CHEAP_BULK_BLOCKS = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mud', 'gravel', 'netherrack',
]);

export function isAlwaysJunkName(name) {
  const n = String(name ?? '').toLowerCase();
  if (!n) return false;
  return ALWAYS_JUNK_ITEMS.has(n) || n.endsWith('_sapling');
}

export function extractDroppedItemInfo(entity) {
  if (!entity) return null;
  let item = null;
  if (typeof entity.getDroppedItem === 'function') {
    try { item = entity.getDroppedItem(); } catch {}
  }
  if (!item && entity.item && typeof entity.item === 'object') {
    item = entity.item;
  }
  if (!item && entity.itemName) {
    item = { name: entity.itemName, count: entity.count ?? 1 };
  }
  const rawName = item?.name ?? null;
  if (!rawName) return null;
  return {
    name: String(rawName).toLowerCase().replace(/^minecraft:/, ''),
    count: Math.max(1, Number(item.count ?? 1)),
    item,
  };
}

const ARMOR_UPGRADE_SPECS = [
  { slot: 'torso', suffix: 'chestplate', cost: 8, label: 'áo giáp' },
  { slot: 'legs', suffix: 'leggings', cost: 7, label: 'quần giáp' },
  { slot: 'head', suffix: 'helmet', cost: 5, label: 'mũ giáp' },
  { slot: 'feet', suffix: 'boots', cost: 4, label: 'giày giáp' },
];

export class EquipmentManager {
  constructor(bot, config = {}, { log = () => {}, isTemporarilyNeeded = null } = {}) {
    this.bot = bot;
    this.config = config;
    this.log = log;
    this.isTemporarilyNeeded = typeof isTemporarilyNeeded === 'function' ? isTemporarilyNeeded : null;
    this.running = false;
    this._maintaining = null;
    this.lastDiscardAt = 0;
    this._recentlyDiscardedNames = new Map();
    this._ignoredEntityIds = new Map();
    this._ownerDroppedEntityIds = new Map();
    if (bot && typeof bot === 'object') {
      bot._equipment = this;
    }
  }

  _isProtectedByTask(name) {
    return Boolean(name && this.isTemporarilyNeeded?.(name));
  }

  get inventoryItems() { return this.bot.inventory?.items?.() ?? []; }

  _equippedSlot(slot) {
    const slots = this.bot.inventory?.slots ?? [];
    const idx = ARMOR_SLOT_INDEX[slot];
    return idx != null ? slots[idx] ?? null : null;
  }

  _offHandItem() {
    const slots = this.bot.inventory?.slots ?? [];
    return slots[OFF_HAND_SLOT] ?? null;
  }

  status() {
    const summary = {};
    for (const slot of ARMOR_SLOTS) {
      const item = this._equippedSlot(slot);
      if (item) summary[slot] = item.name;
    }
    const offHand = this._offHandItem();
    if (offHand) {
      const type = typeOf(itemName(offHand));
      summary[type ?? 'off-hand'] = offHand.name;
    }
    const held = this.bot.heldItem ?? null;
    if (held) {
      const type = typeOf(itemName(held));
      summary[type ?? 'hand'] = held.name;
    }
    return { equipped: summary, items: this.inventoryItems.map((i) => ({ name: i.name, count: i.count })) };
  }

  armorMitigation() {
    let total = 0;
    for (const slot of ARMOR_SLOTS) {
      const item = this._equippedSlot(slot);
      if (!item) continue;
      const mat = materialOf(itemName(item));
      total += ARMOR_MITIGATION_BY_MATERIAL[mat] ?? 0.05;
    }
    return Math.max(0, Math.min(0.8, Number(total.toFixed(3))));
  }

  getLowDurabilityItems(threshold = 0.10) {
    const seen = new Set();
    const low = [];
    const check = (item, slotLabel) => {
      if (!item || seen.has(item)) return;
      seen.add(item);
      const maxDur = Number(item.maxDurability ?? 0);
      if (!(maxDur > 0)) return;
      const ratio = getDurabilityRatio(item);
      if (ratio < threshold) {
        low.push({ name: item.name, slot: slotLabel, ratio: Number(ratio.toFixed(3)) });
      }
    };
    for (const slot of ARMOR_SLOTS) check(this._equippedSlot(slot), slot);
    check(this._offHandItem(), 'off-hand');
    check(this.bot.heldItem, 'hand');
    for (const item of this.inventoryItems) check(item, item.slot ?? 'inventory');
    return low;
  }

  _pickHealthyItem(items, predicate) {
    const matches = items.filter(predicate);
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const aOk = getDurabilityRatio(a) >= 0.10 ? 1 : 0;
      const bOk = getDurabilityRatio(b) >= 0.10 ? 1 : 0;
      if (aOk !== bOk) return bOk - aOk;
      return rank(b) - rank(a);
    });
    return matches[0];
  }

  async equipWeaponForSituation({ target = null, mobCount = 1, distance = 2, opponentBlocking = false, preferRanged = false } = {}) {
    const items = this.inventoryItems;
    const isBlocking = opponentBlocking || Boolean(target?.blocking) || itemName(target?.heldItem) === 'shield';

    let chosen = null;
    let reason = 'melee';

    if (isBlocking) {
      chosen = this._pickHealthyItem(items, i => itemName(i).endsWith('_axe'));
      if (chosen) reason = 'shield_break';
    }

    if (!chosen && (preferRanged || distance > 6)) {
      const ranged = this._pickHealthyItem(items, i => {
        const n = itemName(i);
        return n === 'bow' || n.endsWith('_bow') || n === 'crossbow';
      });
      if (ranged && hasArrowOrInfinity(items, ranged)) {
        chosen = ranged;
        reason = 'ranged';
      }
    }

    if (!chosen && mobCount >= 2) {
      chosen = this._pickHealthyItem(items, i => itemName(i).endsWith('_sword'));
      if (chosen) reason = 'sweep';
    }

    if (!chosen) {
      const sword = this._pickHealthyItem(items, i => itemName(i).endsWith('_sword'));
      const axe = this._pickHealthyItem(items, i => itemName(i).endsWith('_axe'));
      if (sword && (!axe || rank(sword) >= rank(axe))) chosen = sword;
      else chosen = axe;
      reason = 'melee';
    }

    if (!chosen || typeof this.bot.equip !== 'function') {
      return { equipped: false, weapon: null, reason };
    }

    if (getDurabilityRatio(chosen) < 0.10) {
      this.log(`⚠️ Vũ khí ${chosen.name} sắp hỏng (<10%)`);
    }

    const held = this.bot.heldItem;
    if (held && itemName(held) === itemName(chosen) && getDurabilityRatio(held) >= 0.10) {
      return { equipped: true, weapon: held.name, reason };
    }

    try {
      await this.bot.equip(chosen, 'hand');
      return { equipped: true, weapon: chosen.name, reason };
    } catch (error) {
      this.log(`Could not equip ${chosen.name}: ${error.message}`);
      return { equipped: false, weapon: null, reason };
    }
  }

  async equipMelee() {
    const items = this.inventoryItems;
    const sword = items.filter((i) => itemName(i).endsWith('_sword')).sort((a, b) => itemScore(b) - itemScore(a))[0];
    const axe = items.filter((i) => itemName(i).endsWith('_axe')).sort((a, b) => itemScore(b) - itemScore(a))[0];
    const best = sword && (!axe || itemScore(sword) >= itemScore(axe)) ? sword : axe;
    if (!best || typeof this.bot.equip !== 'function') return false;

    const held = this.bot.heldItem;
    if (held && (itemName(held).endsWith('_sword') || itemName(held).endsWith('_axe')) && itemScore(held) >= itemScore(best)) {
      return true;
    }

    try {
      await this.bot.equip(best, 'hand');
      return true;
    } catch (error) {
      this.log(`Could not equip melee item: ${error.message}`);
      return false;
    }
  }

  async maintainArmorAndShield() {
    const items = this.inventoryItems;
    if (typeof this.bot.equip !== 'function') return this.status();

    const inNether = String(this.bot.game?.dimension ?? '').toLowerCase().includes('nether');
    const netherLockedSlots = new Set();

    if (inNether) {
      const curHead = this._equippedSlot('head');
      const isCurGoldHelm = curHead && itemName(curHead) === 'golden_helmet' && safeDurabilityRatio(curHead) >= 0.15;
      const bestGoldHelm = items
        .filter((i) => itemName(i) === 'golden_helmet' && safeDurabilityRatio(i) >= 0.15)
        .sort((a, b) => itemScore(b) - itemScore(a))[0];

      if (isCurGoldHelm) {
        netherLockedSlots.add('head');
      } else if (bestGoldHelm) {
        try {
          await this.bot.equip(bestGoldHelm, 'head');
          this.log(`Equipped ${bestGoldHelm.name} (Nether Piglin protection)`);
          netherLockedSlots.add('head');
        } catch (error) {
          this.log(`Could not equip ${bestGoldHelm.name}: ${error.message}`);
        }
      } else {
        let alreadyHasGold = false;
        for (const s of ARMOR_SLOTS) {
          const cur = this._equippedSlot(s);
          if (cur && materialOf(itemName(cur)) === 'golden' && safeDurabilityRatio(cur) >= 0.15) {
            netherLockedSlots.add(s);
            alreadyHasGold = true;
            break;
          }
        }
        if (!alreadyHasGold) {
          const fallbackGold = items
            .filter((i) => slotForArmor(itemName(i)) && materialOf(itemName(i)) === 'golden' && safeDurabilityRatio(i) >= 0.15)
            .sort((a, b) => itemScore(b) - itemScore(a))[0];
          if (fallbackGold) {
            const targetSlot = slotForArmor(itemName(fallbackGold));
            try {
              await this.bot.equip(fallbackGold, targetSlot);
              this.log(`Equipped ${fallbackGold.name} (Nether Piglin protection)`);
              netherLockedSlots.add(targetSlot);
            } catch (error) {
              this.log(`Could not equip ${fallbackGold.name}: ${error.message}`);
            }
          }
        }
      }
    }

    for (const slot of ARMOR_SLOTS) {
      if (netherLockedSlots.has(slot)) continue;
      const current = this._equippedSlot(slot);
      const best = items
        .filter((item) => slotForArmor(itemName(item)) === slot)
        .sort((a, b) => itemScore(b) - itemScore(a))[0];
      if (!best || (current && itemScore(best) <= itemScore(current) + 0.01)) continue;
      try {
        await this.bot.equip(best, slot);
        this.log(`Equipped ${best.name}`);
      } catch (error) {
        this.log(`Could not equip ${best.name}: ${error.message}`);
      }
    }

    const offHand = this._offHandItem();
    const offHandName = itemName(offHand);
    const totem = items.find((item) => itemName(item) === 'totem_of_undying');
    const shield = items.find((item) => itemName(item) === 'shield');
    const lowHealth = typeof this.bot.health === 'number' && this.bot.health <= 10;

    if (lowHealth && totem && offHandName !== 'totem_of_undying') {
      try {
        await this.bot.equip(totem, 'off-hand');
        this.log('Equipped totem_of_undying (low health)');
      } catch (error) {
        this.log(`Could not equip totem: ${error.message}`);
      }
    } else {
      const hasOffHandProtection = offHandName === 'shield' || offHandName === 'totem_of_undying';
      if (shield && !hasOffHandProtection) {
        try {
          await this.bot.equip(shield, 'off-hand');
        } catch (error) {
          this.log(`Could not equip shield: ${error.message}`);
        }
      }
    }

    return this.status();
  }

  async maintain() {
    if (this._maintaining) return this._maintaining;
    this._maintaining = (async () => {
      await this.maintainArmorAndShield();
      await this.equipMelee();
      return this.status();
    })();
    try { return await this._maintaining; } finally { this._maintaining = null; }
  }

  get blockStackLimit() { return Math.max(0, Number(this.config.inventory?.blockStacks ?? 1)); }
  get discardObsolete() { return this.config.inventory?.discardObsolete === true; }

  ignoreDroppedEntity(entityId, { fromOwner = false, ttlMs = 120000, now = Date.now() } = {}) {
    if (entityId == null) return;
    const expiresAt = now + Math.max(1000, Number(ttlMs) || 120000);
    this._ignoredEntityIds.set(entityId, expiresAt);
    if (fromOwner) {
      this._ownerDroppedEntityIds.set(entityId, expiresAt);
    }
    if (this._ignoredEntityIds.size > 128) {
      for (const [id, exp] of this._ignoredEntityIds.entries()) {
        if (exp <= now) this._ignoredEntityIds.delete(id);
      }
      for (const [id, exp] of this._ownerDroppedEntityIds.entries()) {
        if (exp <= now) this._ownerDroppedEntityIds.delete(id);
      }
    }
  }

  evaluateItemNeed(itemOrName, { count = 1, hasChestAvailable = false } = {}) {
    const itemObj = typeof itemOrName === 'string' ? { name: itemOrName, count } : itemOrName;
    const name = itemName(itemObj);
    if (!name) return { action: 'keep', urgentKeep: false, reason: 'unknown' };

    if (this._isProtectedByTask(name)) {
      return { action: 'keep', urgentKeep: true, reason: 'active_task_needed' };
    }

    if (isAlwaysJunkName(name)) {
      return { action: 'drop', urgentKeep: false, reason: 'junk_item' };
    }

    const items = this.inventoryItems;
    const countOf = (pred) => items.reduce(
      (s, i) => (pred(itemName(i)) ? s + Math.max(1, Number(i.count ?? 1)) : s),
      0
    );
    const ownedCount = countOf((n) => n === name);
    const emptySlots = typeof this.bot.inventory?.emptySlotCount === 'function'
      ? this.bot.inventory.emptySlotCount()
      : 10;

    if (IRON_ALWAYS_PICKUP_ITEMS.has(name)) {
      const hasStackRoom = emptySlots > 0 || items.some(
        (i) => itemName(i) === name && (i.count ?? 64) < (i.stackSize ?? 64)
      );
      if (hasStackRoom) {
        return { action: 'keep', urgentKeep: true, alwaysPickup: true, reason: 'always_keep_iron' };
      }
      return { action: 'keep', urgentKeep: false, skipPickup: true, reason: 'bag_full_iron' };
    }

    if (name === 'diamond' || name === 'diamond_block') {
      const maxDiamonds = Math.max(16, Number(this.config.inventory?.maxDiamonds ?? 64));
      const totalDiamondUnits = countOf((n) => n === 'diamond') + countOf((n) => n === 'diamond_block') * 9;
      if (totalDiamondUnits >= maxDiamonds) {
        return {
          action: hasChestAvailable ? 'store' : 'keep',
          urgentKeep: false,
          skipPickup: true,
          reason: 'enough_diamonds',
        };
      }
      return { action: 'keep', urgentKeep: totalDiamondUnits < 24, reason: 'precious_gem' };
    }

    // 1. Gear triage: check armor / tools / bow / shield / totem / buckets
    const armorSlot = slotForArmor(name);
    if (armorSlot && rank(itemObj) > 0) {
      const equipped = this._equippedSlot(armorSlot);
      const pool = [...(equipped ? [equipped] : []), ...items.filter((i) => slotForArmor(itemName(i)) === armorSlot)];
      if (pool.length === 0) {
        return { action: 'keep', urgentKeep: true, reason: `fills_empty_armor_${armorSlot}` };
      }
      const winner = [...pool].sort((a, b) => itemScore(b) - itemScore(a))[0];
      if (itemScore(itemObj) > itemScore(winner) + 0.01) {
        return { action: 'keep', urgentKeep: true, reason: `upgrades_armor_${armorSlot}` };
      }
      if (name === 'golden_helmet' && safeDurabilityRatio(itemObj) >= 0.2) {
        const hasHealthyGold = pool.some((i) => itemName(i) === 'golden_helmet' && safeDurabilityRatio(i) >= 0.2);
        if (!hasHealthyGold) {
          return { action: 'keep', urgentKeep: false, reason: 'nether_gold_helmet' };
        }
      }
      if (hasChestAvailable && rank(itemObj) >= MATERIAL_RANK.iron) {
        return { action: 'store', urgentKeep: false, reason: 'spare_good_armor' };
      }
      return { action: 'drop', urgentKeep: false, reason: 'obsolete_armor' };
    }

    const toolType = ['sword', 'axe', 'pickaxe', 'shovel'].find((t) => name.endsWith(`_${t}`));
    if (toolType && rank(itemObj) > 0) {
      const heldMatches = this.bot.heldItem && itemName(this.bot.heldItem).endsWith(`_${toolType}`) ? [this.bot.heldItem] : [];
      const pool = [...heldMatches, ...items.filter((i) => itemName(i).endsWith(`_${toolType}`))];
      if (pool.length === 0) {
        return { action: 'keep', urgentKeep: true, reason: `fills_empty_${toolType}` };
      }
      const winner = [...pool].sort((a, b) => itemScore(b) - itemScore(a))[0];
      if (itemScore(itemObj) > itemScore(winner) + 0.01) {
        return { action: 'keep', urgentKeep: true, reason: `upgrades_${toolType}` };
      }
      if (hasChestAvailable && rank(itemObj) >= MATERIAL_RANK.iron) {
        return { action: 'store', urgentKeep: false, reason: 'spare_good_tool' };
      }
      return { action: 'drop', urgentKeep: false, reason: 'obsolete_tool' };
    }

    if (name === 'bow' || name === 'shield' || name === 'totem_of_undying' || name === 'water_bucket' || name === 'bucket') {
      const hasMatch =
        items.some((i) => itemName(i) === name) ||
        itemName(this.bot.heldItem) === name ||
        itemName(this._offHandItem()) === name;
      if (!hasMatch) {
        return { action: 'keep', urgentKeep: name !== 'bucket', reason: `needed_${name}` };
      }
      if (name === 'totem_of_undying') {
        return { action: 'keep', urgentKeep: true, reason: 'totem_reserve' };
      }
      if (hasChestAvailable && name !== 'bucket') {
        return { action: 'store', urgentKeep: false, reason: `spare_${name}` };
      }
      return { action: name === 'bow' ? 'drop' : (hasChestAvailable ? 'store' : 'drop'), urgentKeep: false, reason: `duplicate_${name}` };
    }

    // 2. Edible food triage
    if (EDIBLE_FOOD_ITEMS.has(name)) {
      const totalFood = countOf((n) => EDIBLE_FOOD_ITEMS.has(n));
      const keepFoodTarget = Math.max(24, Number(this.config.inventory?.keepFood ?? 16));
      if (totalFood < keepFoodTarget) {
        return { action: 'keep', urgentKeep: totalFood < 6, reason: 'needed_food' };
      }
      return {
        action: hasChestAvailable || emptySlots > 6 ? 'store' : 'drop',
        urgentKeep: false,
        reason: 'surplus_food',
      };
    }

    // 3. Working pocket caps for survival & crafting progression
    const maxCobble = Math.max(1, Number(this.blockStackLimit || 2)) * 64;
    let pocketCap = null;
    if (name.endsWith('_log') || name.endsWith('_stem')) {
      pocketCap = { cap: 32, total: countOf((n) => n.endsWith('_log') || n.endsWith('_stem')), reason: 'wood_logs' };
    } else if (name.endsWith('_planks') || name === 'planks') {
      pocketCap = { cap: 64, total: countOf((n) => n.endsWith('_planks') || n === 'planks'), reason: 'wood_planks' };
    } else if (name === 'stick') {
      pocketCap = { cap: 32, total: ownedCount, reason: 'sticks' };
    } else if (name === 'crafting_table' || name === 'chest' || name === 'barrel') {
      pocketCap = { cap: 2, total: ownedCount, reason: 'utility_block' };
    } else if (name === 'furnace' || name === 'smoker' || name === 'blast_furnace') {
      pocketCap = { cap: 2, total: ownedCount, reason: 'furnace' };
    } else if (name.endsWith('_bed')) {
      pocketCap = { cap: 1, total: countOf((n) => n.endsWith('_bed')), reason: 'bed', urgent: true };
    } else if (name === 'torch' || name === 'arrow') {
      pocketCap = { cap: 64, total: ownedCount, reason: name };
    } else if (name === 'coal' || name === 'charcoal') {
      pocketCap = { cap: 32, total: countOf((n) => n === 'coal' || n === 'charcoal'), reason: 'fuel' };
    } else if (name === 'emerald') {
      pocketCap = { cap: 32, total: ownedCount, reason: 'precious_gem', urgent: true };
    } else if (name === 'gold_ingot' || name === 'raw_gold' || name === 'gold_ore' || name === 'deepslate_gold_ore') {
      pocketCap = { cap: 32, total: ownedCount, reason: 'gold_progression' };
    } else if (name === 'ender_pearl' || name === 'blaze_rod') {
      pocketCap = { cap: 16, total: ownedCount, reason: 'end_progression', urgent: true };
    } else if (name === 'cobblestone' || name === 'cobbled_deepslate') {
      if (ownedCount >= maxCobble && !hasChestAvailable) {
        return { action: 'drop', urgentKeep: false, reason: 'excess_cobblestone_no_chest' };
      }
      pocketCap = { cap: maxCobble, total: ownedCount, reason: 'cobblestone' };
    } else if (CHEAP_BULK_BLOCKS.has(name)) {
      if (ownedCount >= (name === 'dirt' ? 32 : 64)) {
        return { action: 'drop', urgentKeep: false, reason: 'excess_cheap_block' };
      }
      if (name === 'dirt') {
        return { action: 'keep', urgentKeep: false, reason: 'scaffold_dirt' };
      }
      return {
        action: hasChestAvailable || emptySlots > 10 ? 'store' : 'drop',
        urgentKeep: false,
        reason: 'surplus_bulk_block',
      };
    }

    if (pocketCap) {
      if (pocketCap.total < pocketCap.cap) {
        return { action: 'keep', urgentKeep: Boolean(pocketCap.urgent && pocketCap.total < 8), reason: pocketCap.reason };
      }
      if (hasChestAvailable || PRECIOUS_LOOT_ITEMS.has(name) || emptySlots > 6) {
        return { action: 'store', urgentKeep: false, reason: `surplus_${pocketCap.reason}` };
      }
      return { action: 'drop', urgentKeep: false, reason: `excess_${pocketCap.reason}` };
    }

    if (PRECIOUS_LOOT_ITEMS.has(name) || hasChestAvailable || emptySlots > 6) {
      return { action: 'store', urgentKeep: PRECIOUS_LOOT_ITEMS.has(name), reason: 'useful_misc' };
    }
    return { action: 'drop', urgentKeep: false, reason: 'low_value_full_bag' };
  }

  shouldPickupDroppedEntity(entity, { ownerEntity = null, hasChestAvailable = false, now = Date.now() } = {}) {
    if (!entity?.position) return false;
    if (now - (this.lastDiscardAt ?? 0) < 4000) return false;

    const info = extractDroppedItemInfo(entity);
    const ignoreExp = this._ignoredEntityIds.get(entity.id) ?? 0;
    if (ignoreExp > now) {
      const ownerExp = this._ownerDroppedEntityIds.get(entity.id) ?? 0;
      if (ownerExp > now && info) {
        const evalRes = this.evaluateItemNeed(info.item ?? info.name, { count: info.count, hasChestAvailable });
        if (evalRes.skipPickup) return false;
        const hasBothPos = Boolean(ownerEntity?.position && this.bot.entity?.position);
        const botDist = hasBothPos ? entity.position.distanceTo(this.bot.entity.position) : Infinity;
        const ownerDist = hasBothPos ? entity.position.distanceTo(ownerEntity.position) : Infinity;
        if (evalRes.alwaysPickup) {
          if (hasBothPos && ownerDist < 1.2 && botDist > ownerDist + 0.5) {
            return false;
          }
          return true;
        }
        if (hasBothPos && evalRes.urgentKeep && botDist + 0.8 < ownerDist) {
          return true;
        }
        if (hasBothPos && evalRes.action !== 'drop' && botDist <= 2.2 && botDist + 0.9 < ownerDist) {
          return true;
        }
      }
      return false;
    }

    if (info) {
      if (!this._isProtectedByTask(info.name) && (this._recentlyDiscardedNames.get(info.name) ?? 0) > now) {
        return false;
      }
      const need = this.evaluateItemNeed(info.item ?? info.name, { count: info.count, hasChestAvailable });
      if (need.action === 'drop' || need.skipPickup) return false;
      if (need.action === 'store') {
        const emptySlots = typeof this.bot.inventory?.emptySlotCount === 'function'
          ? this.bot.inventory.emptySlotCount()
          : 10;
        if (emptySlots <= 6 || (!hasChestAvailable && emptySlots <= 12)) {
          return false;
        }
      }
    }

    return true;
  }

  async _tossItemAwayFromOwner(item, ownerEntity = null) {
    const name = itemName(item);
    const now = Date.now();
    this.lastDiscardAt = now;
    if (name) {
      this._recentlyDiscardedNames.set(name, now + 35000);
    }
    if (this.bot.entity?.position && typeof this.bot.look === 'function' && !this.bot.targetDigBlock) {
      let baseYaw = this.bot.entity.yaw ?? 0;
      if (ownerEntity?.position) {
        const dx = this.bot.entity.position.x - ownerEntity.position.x;
        const dz = this.bot.entity.position.z - ownerEntity.position.z;
        if (Math.hypot(dx, dz) > 0.2) {
          baseYaw = Math.atan2(-dx, -dz);
        }
      }
      let chosenYaw = baseYaw;
      if (typeof this.bot.blockAt === 'function') {
        const bp = this.bot.entity.position;
        const hazardRe = /(?:lava|fire|soul_fire|cactus)/;
        const isSafeAngle = (yaw) => {
          const sx = -Math.sin(yaw);
          const sz = -Math.cos(yaw);
          for (const dist of [1.2, 2.2]) {
            const x = Math.floor(bp.x + sx * dist);
            const z = Math.floor(bp.z + sz * dist);
            for (const dy of [0, -1]) {
              const blk = this.bot.blockAt({ x, y: Math.floor(bp.y) + dy, z });
              if (blk && hazardRe.test(String(blk.name ?? '').toLowerCase())) return false;
            }
          }
          return true;
        };
        const candidates = [baseYaw, baseYaw + Math.PI / 3, baseYaw - Math.PI / 3, baseYaw + (2 * Math.PI) / 3, baseYaw - (2 * Math.PI) / 3];
        chosenYaw = candidates.find(isSafeAngle) ?? baseYaw;
      }
      const curYaw = this.bot.entity.yaw ?? 0;
      const diff = Math.abs(Math.atan2(Math.sin(chosenYaw - curYaw), Math.cos(chosenYaw - curYaw)));
      if (diff > 0.35) {
        try {
          await this.bot.look(chosenYaw, 0, true);
        } catch {}
      }
    }
    if (typeof this.bot.tossStack === 'function') {
      await this.bot.tossStack(item);
      return true;
    }
    if (typeof this.bot.toss === 'function') {
      await this.bot.toss(item.type, item.metadata ?? null, item.count);
      return true;
    }
    return false;
  }

  _collectDiscardPlan({ force = false, blockStacks = null } = {}) {
    if (!force && !this.discardObsolete) {
      return { obsolete: [], junk: [] };
    }
    const items = this.inventoryItems;

    const pickWinner = (candidates) => {
      if (candidates.length === 0) return null;
      return [...candidates].sort((a, b) => itemScore(b) - itemScore(a))[0];
    };

    const bestArmorItem = {};
    const bestArmorRank = {};
    for (const slot of ARMOR_SLOTS) {
      const equipped = this._equippedSlot(slot);
      const pool = [
        ...(equipped ? [equipped] : []),
        ...items.filter((i) => slotForArmor(itemName(i)) === slot),
      ];
      const winner = pickWinner(pool);
      bestArmorItem[slot] = winner;
      bestArmorRank[slot] = pool.reduce((m, i) => Math.max(m, rank(i)), 0);
    }

    const bestToolItem = {};
    const bestToolRank = {};
    for (const type of ['sword', 'axe', 'pickaxe', 'shovel']) {
      const heldMatches = this.bot.heldItem && itemName(this.bot.heldItem).endsWith(`_${type}`)
        ? [this.bot.heldItem]
        : [];
      const pool = [
        ...heldMatches,
        ...items.filter((i) => itemName(i).endsWith(`_${type}`)),
      ];
      const winner = pickWinner(pool);
      bestToolItem[type] = winner;
      bestToolRank[type] = pool.reduce((m, i) => Math.max(m, rank(i)), 0);
    }

    const eqHead = this._equippedSlot('head');
    const keptGoldHelmet = (eqHead && itemName(eqHead) === 'golden_helmet' && safeDurabilityRatio(eqHead) >= 0.2)
      ? eqHead
      : pickWinner(items.filter((i) => itemName(i) === 'golden_helmet' && safeDurabilityRatio(i) >= 0.2));

    const heldBow = this.bot.heldItem && itemName(this.bot.heldItem) === 'bow' ? [this.bot.heldItem] : [];
    const bestBow = pickWinner([...heldBow, ...items.filter((i) => itemName(i) === 'bow')]);

    const keptBlankKeys = new Set();
    const obsolete = [];

    for (const item of items) {
      const name = itemName(item);
      if (this._isProtectedByTask(name)) continue;
      if (item === keptGoldHelmet) continue;

      let isObsolete = false;
      const armorSlot = slotForArmor(name);
      if (armorSlot && rank(item) > 0) {
        const winner = bestArmorItem[armorSlot];
        const topRank = bestArmorRank[armorSlot];
        if (item !== winner && (rank(item) < topRank || itemScore(item) < itemScore(winner) - 0.01)) {
          const isBlankUpgradeBase =
            rank(item) >= MATERIAL_RANK.diamond &&
            getEnchantmentBonus(item) === 0 &&
            winner &&
            rank(winner) < MATERIAL_RANK.diamond &&
            !keptBlankKeys.has(`armor:${armorSlot}`);
          if (isBlankUpgradeBase) {
            keptBlankKeys.add(`armor:${armorSlot}`);
          } else {
            isObsolete = true;
          }
        }
      } else {
        const toolType = ['sword', 'axe', 'pickaxe', 'shovel'].find((t) => name.endsWith(`_${t}`));
        if (toolType && rank(item) > 0) {
          const winner = bestToolItem[toolType];
          const topRank = bestToolRank[toolType];
          if (item !== winner && (rank(item) < topRank || itemScore(item) < itemScore(winner) - 0.01)) {
            const isBlankUpgradeBase =
              rank(item) >= MATERIAL_RANK.diamond &&
              getEnchantmentBonus(item) === 0 &&
              winner &&
              rank(winner) < MATERIAL_RANK.diamond &&
              !keptBlankKeys.has(`tool:${toolType}`);
            if (isBlankUpgradeBase) {
              keptBlankKeys.add(`tool:${toolType}`);
            } else {
              isObsolete = true;
            }
          }
        } else if (name === 'bow' && bestBow && item !== bestBow) {
          isObsolete = true;
        }
      }

      if (isObsolete) obsolete.push(item);
    }

    const maxCobble = Math.max(1, Number(blockStacks ?? this.blockStackLimit ?? 2)) * 64;
    const bulkLimits = new Map([
      ['cobblestone', maxCobble],
      ['cobbled_deepslate', maxCobble],
      ['dirt', 64],
      ['netherrack', 64],
      ['gravel', 64],
    ]);
    const keptCounts = new Map();
    const junk = [];

    for (const item of items) {
      const name = itemName(item);
      if (!name) continue;
      if (
        this._isProtectedByTask(name) ||
        IRON_ALWAYS_PICKUP_ITEMS.has(name) ||
        name === 'diamond' ||
        name === 'diamond_block'
      ) {
        continue;
      }
      const count = Math.max(1, Number(item.count ?? 1));
      let shouldDrop = isAlwaysJunkName(name);
      if (!shouldDrop && bulkLimits.has(name)) {
        const prev = keptCounts.get(name) ?? 0;
        const limit = bulkLimits.get(name);
        if (prev + count > limit) {
          shouldDrop = true;
        } else {
          keptCounts.set(name, prev + count);
        }
      }
      if (shouldDrop) junk.push(item);
    }

    return { obsolete, junk };
  }

  hasInventoryTrash({ blockStacks = null } = {}) {
    if (!this.discardObsolete) return false;
    const { obsolete, junk } = this._collectDiscardPlan({ force: false, blockStacks });
    return obsolete.length > 0 || junk.length > 0;
  }

  async discardObsoleteItems({ force = false, ownerEntity = null } = {}) {
    if (!force && !this.discardObsolete) return [];
    const { obsolete } = this._collectDiscardPlan({ force });
    const tossed = [];

    for (const item of obsolete) {
      try {
        const didToss = await this._tossItemAwayFromOwner(item, ownerEntity);
        if (!didToss) continue;
        tossed.push(item.name);
        this.log(`Discarded obsolete ${item.name}`);
      } catch (err) {
        this.log(`Could not discard ${item.name}: ${err.message}`);
      }
    }
    return tossed;
  }

  async discardJunkItems({ force = false, blockStacks = null, ownerEntity = null } = {}) {
    if (!force && !this.discardObsolete) return [];
    if (typeof this.bot.tossStack !== 'function' && typeof this.bot.toss !== 'function') return [];

    const { junk } = this._collectDiscardPlan({ force, blockStacks });
    const tossed = [];

    for (const item of junk) {
      const name = itemName(item);
      try {
        const didToss = await this._tossItemAwayFromOwner(item, ownerEntity);
        if (!didToss) continue;
        tossed.push(name);
      } catch (error) {
        this.log(`Could not toss junk ${name}: ${error.message}`);
      }
    }
    return tossed;
  }

  planNextGearUpgrade() {
    const items = this.inventoryItems;
    const countOf = (predicate) =>
      items.reduce((sum, item) => (predicate(itemName(item)) ? sum + Math.max(1, Number(item.count ?? 1)) : sum), 0);

    const diamonds = countOf((n) => n === 'diamond');
    const ironIngots = countOf((n) => n === 'iron_ingot');
    const goldIngots = countOf((n) => n === 'gold_ingot');
    const rawIron = countOf((n) => n === 'raw_iron');
    const ironOre = countOf((n) => n === 'iron_ore' || n === 'deepslate_iron_ore');
    const cobble = countOf((n) => n === 'cobblestone' || n === 'cobbled_deepslate');
    const sticks = countOf((n) => n === 'stick');
    const planks = countOf((n) => n.endsWith('_planks') || n === 'planks');
    const logs = countOf((n) => n.endsWith('_log') || n.endsWith('_stem'));
    const woodUnits = planks + logs * 4;
    const canGetSticks = (need = 1) => sticks >= need || woodUnits >= 2;
    const hasBucket =
      countOf((n) => n === 'bucket' || n === 'water_bucket') > 0 ||
      itemName(this.bot.heldItem).includes('bucket') ||
      itemName(this._offHandItem()).includes('bucket');

    const bestOwnedRank = (predicate, extraItems = []) => {
      let best = 0;
      for (const item of [...items, ...extraItems]) {
        if (item && predicate(itemName(item))) {
          best = Math.max(best, rank(item));
        }
      }
      return best;
    };

    const held = this.bot.heldItem ? [this.bot.heldItem] : [];
    const pickaxeRank = bestOwnedRank((n) => n.endsWith('_pickaxe'), held);
    const swordRank = bestOwnedRank((n) => n.endsWith('_sword'), held);
    const axeRank = bestOwnedRank((n) => n.endsWith('_axe'), held);
    const hasShield = itemName(this._offHandItem()) === 'shield' || items.some((i) => itemName(i) === 'shield');

    const inNether = String(this.bot.game?.dimension ?? '').toLowerCase().includes('nether');
    const hasAnyGoldArmor =
      ARMOR_SLOTS.some((s) => materialOf(itemName(this._equippedSlot(s))) === 'golden') ||
      items.some((i) => slotForArmor(itemName(i)) && materialOf(itemName(i)) === 'golden');
    if (inNether && !hasAnyGoldArmor && goldIngots >= 5) {
      return {
        action: 'craft',
        item: 'golden_helmet',
        count: 1,
        slot: 'head',
        tier: MATERIAL_RANK.golden,
        material: 'gold_ingot',
        reason: 'rèn mũ vàng đi Nether tránh Piglin đánh',
      };
    }

    // 1. Iron pickaxe unlocks diamond/gold/redstone mining; stone pickaxe unlocks iron; wooden pickaxe starts stone mining.
    if (pickaxeRank < MATERIAL_RANK.iron && ironIngots >= 3 && canGetSticks(2)) {
      return { action: 'craft', item: 'iron_pickaxe', count: 1, tier: MATERIAL_RANK.iron, material: 'iron_ingot', reason: 'rèn cúp sắt để đào được quặng quý' };
    }
    if (pickaxeRank < MATERIAL_RANK.stone && cobble >= 3 && canGetSticks(2)) {
      return { action: 'craft', item: 'stone_pickaxe', count: 1, tier: MATERIAL_RANK.stone, material: 'cobblestone', reason: 'làm cúp đá để đào được sắt' };
    }
    if (pickaxeRank < MATERIAL_RANK.wooden && woodUnits >= 9) {
      return { action: 'craft', item: 'wooden_pickaxe', count: 1, tier: MATERIAL_RANK.wooden, material: 'planks', reason: 'làm cúp gỗ để bắt đầu đào đá và than' };
    }

    // 2. Primary melee weapon: diamond_sword -> iron_sword -> stone_sword.
    if (swordRank < MATERIAL_RANK.diamond && diamonds >= 2 && canGetSticks(1)) {
      return { action: 'craft', item: 'diamond_sword', count: 1, tier: MATERIAL_RANK.diamond, material: 'diamond', reason: 'rèn kiếm kim cương' };
    }
    if (swordRank < MATERIAL_RANK.iron && ironIngots >= 2 && canGetSticks(1)) {
      return { action: 'craft', item: 'iron_sword', count: 1, tier: MATERIAL_RANK.iron, material: 'iron_ingot', reason: 'rèn kiếm sắt' };
    }
    if (swordRank < MATERIAL_RANK.stone && cobble >= 2 && canGetSticks(1)) {
      return { action: 'craft', item: 'stone_sword', count: 1, tier: MATERIAL_RANK.stone, material: 'cobblestone', reason: 'làm kiếm đá tự vệ' };
    }

    // 3. Shield for blocking creeper/skeleton/melee hits.
    if (!hasShield && ironIngots >= 1 && woodUnits >= 6) {
      return { action: 'craft', item: 'shield', count: 1, tier: MATERIAL_RANK.iron, material: 'iron_ingot', reason: 'làm khiên chắn sát thương' };
    }

    // 3b. Empty bucket for water MLG and lava defense once core iron tools/shield are secured.
    if (pickaxeRank >= MATERIAL_RANK.iron && swordRank >= MATERIAL_RANK.iron && hasShield && !hasBucket && ironIngots >= 3) {
      return { action: 'craft', item: 'bucket', count: 1, tier: MATERIAL_RANK.iron, material: 'iron_ingot', reason: 'rèn xô sắt múc nước hộ thân' };
    }

    // 4. Armor upgrades by highest protection per slot: chestplate -> leggings -> helmet -> boots.
    for (const spec of ARMOR_UPGRADE_SPECS) {
      const equipped = this._equippedSlot(spec.slot);
      const slotRank = bestOwnedRank(
        (n) => slotForArmor(n) === spec.slot,
        equipped ? [equipped] : []
      );
      if (slotRank < MATERIAL_RANK.diamond && diamonds >= spec.cost) {
        return {
          action: 'craft',
          item: `diamond_${spec.suffix}`,
          count: 1,
          slot: spec.slot,
          tier: MATERIAL_RANK.diamond,
          material: 'diamond',
          reason: `nâng cấp ${spec.label} kim cương`,
        };
      }
      if (slotRank < MATERIAL_RANK.iron && ironIngots >= spec.cost) {
        return {
          action: 'craft',
          item: `iron_${spec.suffix}`,
          count: 1,
          slot: spec.slot,
          tier: MATERIAL_RANK.iron,
          material: 'iron_ingot',
          reason: `nâng cấp ${spec.label} sắt`,
        };
      }
    }

    // 5. Diamond pickaxe once weapon/armor upgrades for current diamonds are covered.
    if (pickaxeRank < MATERIAL_RANK.diamond && diamonds >= 3 && canGetSticks(2)) {
      return { action: 'craft', item: 'diamond_pickaxe', count: 1, tier: MATERIAL_RANK.diamond, material: 'diamond', reason: 'nâng cấp cúp kim cương' };
    }

    // 6. Smelt raw iron or iron ore if any armor/weapon slot is still below iron AND a furnace is usable/craftable.
    const needsIronGear =
      swordRank < MATERIAL_RANK.iron ||
      pickaxeRank < MATERIAL_RANK.iron ||
      !hasShield ||
      ARMOR_UPGRADE_SPECS.some((spec) => {
        const equipped = this._equippedSlot(spec.slot);
        return bestOwnedRank((n) => slotForArmor(n) === spec.slot, equipped ? [equipped] : []) < MATERIAL_RANK.iron;
      });
    const fuel = countOf((n) => n === 'coal' || n === 'charcoal' || n.endsWith('_planks') || n === 'planks' || n.endsWith('_log'));
    const hasFurnaceItem = countOf((n) => n === 'furnace' || n === 'blast_furnace') >= 1;
    const furnaceStone = countOf((n) => n === 'cobblestone' || n === 'cobbled_deepslate' || n === 'blackstone');
    const furnaceIds = ['furnace', 'blast_furnace'].map((n) => this.bot.registry?.blocksByName?.[n]?.id).filter(Boolean);
    const hasNearbyFurnace = (!hasFurnaceItem && furnaceStone < 8 && furnaceIds.length > 0 && typeof this.bot.findBlock === 'function')
      ? Boolean(this.bot.findBlock({ matching: furnaceIds, maxDistance: 16 }))
      : false;
    const canFurnace = hasFurnaceItem || furnaceStone >= 8 || hasNearbyFurnace;
    if (needsIronGear && fuel >= 1 && canFurnace) {
      if (rawIron >= 2) {
        return { action: 'smelt', item: 'iron_ingot', input: 'raw_iron', count: Math.min(rawIron, 16), tier: MATERIAL_RANK.iron, material: 'raw_iron', reason: 'nung sắt thô để rèn đồ sắt' };
      }
      if (ironOre >= 2) {
        return { action: 'smelt', item: 'iron_ingot', input: 'iron_ore', count: Math.min(ironOre, 16), tier: MATERIAL_RANK.iron, material: 'iron_ore', reason: 'nung quặng sắt để rèn đồ sắt' };
      }
    }

    // 7. Upgrade axe for faster tree chopping after core armor/pick/sword priorities.
    if (axeRank < MATERIAL_RANK.iron && !needsIronGear && ironIngots >= 3 && canGetSticks(2)) {
      return { action: 'craft', item: 'iron_axe', count: 1, tier: MATERIAL_RANK.iron, material: 'iron_ingot', reason: 'rèn rìu sắt chặt cây cho nhanh' };
    }
    if (axeRank < MATERIAL_RANK.stone && cobble >= 3 && canGetSticks(2)) {
      return { action: 'craft', item: 'stone_axe', count: 1, tier: MATERIAL_RANK.stone, material: 'cobblestone', reason: 'làm rìu đá chặt cây cho nhanh' };
    }

    return null;
  }
}

export default EquipmentManager;
