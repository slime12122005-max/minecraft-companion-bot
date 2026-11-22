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
    const sword = items.filter((i) => itemName(i).endsWith('_sword')).sort((a, b) => rank(b) - rank(a))[0];
    const axe = items.filter((i) => itemName(i).endsWith('_axe')).sort((a, b) => rank(b) - rank(a))[0];
    const best = sword && (!axe || rank(sword) >= rank(axe)) ? sword : axe;
    if (!best || typeof this.bot.equip !== 'function') return false;

    const held = this.bot.heldItem;
    if (held && (itemName(held).endsWith('_sword') || itemName(held).endsWith('_axe')) && rank(held) >= rank(best)) {
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

    for (const slot of ARMOR_SLOTS) {
      const current = this._equippedSlot(slot);
      const best = items
        .filter((item) => slotForArmor(itemName(item)) === slot)
        .sort((a, b) => rank(b) - rank(a))[0];
      if (!best || (current && rank(best) <= rank(current))) continue;
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
    const bestArmor = {};
    for (const slot of ARMOR_SLOTS) {
      const equipped = this._equippedSlot(slot);
      let top = equipped ? rank(equipped) : 0;
      for (const item of items) {
        if (slotForArmor(itemName(item)) === slot) top = Math.max(top, rank(item));
      }
      bestArmor[slot] = top;
    }

    const bestTool = {};
    for (const type of ['sword', 'axe', 'pickaxe', 'shovel']) {
      let top = 0;
      if (this.bot.heldItem && itemName(this.bot.heldItem).endsWith(`_${type}`)) {
        top = rank(this.bot.heldItem);
      }
      for (const item of items) {
        if (itemName(item).endsWith(`_${type}`)) top = Math.max(top, rank(item));
      }
      bestTool[type] = top;
    }

    const tossed = [];
    for (const item of items) {
      const name = itemName(item);
      const armorSlot = slotForArmor(name);
      let isObsolete = false;
      if (armorSlot && rank(item) > 0 && rank(item) < bestArmor[armorSlot]) {
        isObsolete = true;
      } else {
        const toolType = ['sword', 'axe', 'pickaxe', 'shovel'].find(t => name.endsWith(`_${t}`));
        if (toolType && rank(item) > 0 && rank(item) < bestTool[toolType]) {
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
}

export default EquipmentManager;
