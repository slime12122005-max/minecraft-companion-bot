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
]);

const ARMOR_UPGRADE_SPECS = [
  { slot: 'torso', suffix: 'chestplate', cost: 8, label: 'áo giáp' },
  { slot: 'legs', suffix: 'leggings', cost: 7, label: 'quần giáp' },
  { slot: 'head', suffix: 'helmet', cost: 5, label: 'mũ giáp' },
  { slot: 'feet', suffix: 'boots', cost: 4, label: 'giày giáp' },
];

export class EquipmentManager {
  constructor(bot, config = {}, { log = () => {} } = {}) {
    this.bot = bot;
    this.config = config;
    this.log = log;
    this.running = false;
    this._maintaining = null;
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

  async discardObsoleteItems({ force = false } = {}) {
    if (!force && !this.discardObsolete) return [];
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

    // Keep 1 healthy golden_helmet for Nether safety.
    const eqHead = this._equippedSlot('head');
    const keptGoldHelmet = (eqHead && itemName(eqHead) === 'golden_helmet' && safeDurabilityRatio(eqHead) >= 0.2)
      ? eqHead
      : pickWinner(items.filter((i) => itemName(i) === 'golden_helmet' && safeDurabilityRatio(i) >= 0.2));

    // Keep at most 1 weaker duplicate bow? Only keep highest-scoring bow.
    const heldBow = this.bot.heldItem && itemName(this.bot.heldItem) === 'bow' ? [this.bot.heldItem] : [];
    const bestBow = pickWinner([...heldBow, ...items.filter((i) => itemName(i) === 'bow')]);

    // Allow keeping at most 1 unenchanted diamond/netherite blank per slot/toolType when an enchanted lower-tier item wins.
    const keptBlankKeys = new Set();
    const tossed = [];

    for (const item of items) {
      const name = itemName(item);
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

      if (!isObsolete) continue;

      try {
        if (typeof this.bot.tossStack === 'function') {
          await this.bot.tossStack(item);
        } else if (typeof this.bot.toss === 'function') {
          await this.bot.toss(item.type, item.metadata ?? null, item.count);
        } else {
          continue;
        }
        tossed.push(item.name);
        this.log(`Discarded obsolete ${item.name}`);
      } catch (err) {
        this.log(`Could not discard ${item.name}: ${err.message}`);
      }
    }
    return tossed;
  }

  async discardJunkItems({ force = false, blockStacks = null } = {}) {
    if (!force && !this.discardObsolete) return [];
    if (typeof this.bot.tossStack !== 'function') return [];

    const items = [...this.inventoryItems];
    const maxCobble = Math.max(1, Number(blockStacks ?? this.blockStackLimit ?? 2)) * 64;
    const bulkLimits = new Map([
      ['cobblestone', maxCobble],
      ['cobbled_deepslate', maxCobble],
      ['dirt', 64],
      ['netherrack', 64],
      ['gravel', 64],
    ]);
    const keptCounts = new Map();
    const tossed = [];

    for (const item of items) {
      const name = itemName(item);
      if (!name) continue;
      const count = Math.max(1, Number(item.count ?? 1));

      let shouldDrop = ALWAYS_JUNK_ITEMS.has(name);
      if (!shouldDrop && bulkLimits.has(name)) {
        const prev = keptCounts.get(name) ?? 0;
        const limit = bulkLimits.get(name);
        if (prev + count > limit) {
          shouldDrop = true;
        } else {
          keptCounts.set(name, prev + count);
        }
      }
      if (!shouldDrop) continue;

      try {
        await this.bot.tossStack(item);
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

    // 6. Smelt raw iron or iron ore if any armor/weapon slot is still below iron.
    const needsIronGear =
      swordRank < MATERIAL_RANK.iron ||
      pickaxeRank < MATERIAL_RANK.iron ||
      !hasShield ||
      ARMOR_UPGRADE_SPECS.some((spec) => {
        const equipped = this._equippedSlot(spec.slot);
        return bestOwnedRank((n) => slotForArmor(n) === spec.slot, equipped ? [equipped] : []) < MATERIAL_RANK.iron;
      });
    const fuel = countOf((n) => n === 'coal' || n === 'charcoal' || n.endsWith('_planks') || n === 'planks' || n.endsWith('_log'));
    if (needsIronGear && fuel >= 1) {
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
