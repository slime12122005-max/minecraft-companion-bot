import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import {
  FUEL_VALUES,
  SMELT_OUTPUT_TO_INPUT,
  planCraftDependencies,
  resolveCraftName,
  resolveSmeltInputs,
} from './crafting_recipes.js';

export { resolveCraftName, resolveSmeltInputs, planCraftDependencies };

const REPLACEABLE_NAMES = new Set(['air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow']);
const INVALID_SUPPORT_NAMES = new Set(['air', 'water', 'lava', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow']);
const SLEEP = ms => new Promise(r => setTimeout(r, ms));

export class CraftManager {
  constructor(bot, config = {}, { log = () => {} } = {}) {
    this.bot = bot;
    this.config = config;
    this.log = log;
  }

  _countItem(itemId) {
    if (typeof this.bot.inventory?.count === 'function') {
      return this.bot.inventory.count(itemId, null);
    }
    return (this.bot.inventory?.items?.() ?? [])
      .filter(i => i && i.type === itemId)
      .reduce((sum, i) => sum + (i.count ?? 0), 0);
  }

  async _moveNextTo(block) {
    if (!this.bot.pathfinder?.goto || !this.bot.entity?.position || !block?.position) return;
    if (this.bot.entity.position.distanceTo(block.position) <= 4) return;
    await this.bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
  }

  async _placeUtilityBlock(itemName) {
    const item = (this.bot.inventory?.items?.() ?? []).find(i => i?.name === itemName);
    if (!item || !this.bot.entity?.position || typeof this.bot.blockAt !== 'function') return null;

    const base = this.bot.entity.position.floored ? this.bot.entity.position.floored() : new Vec3(
      Math.floor(this.bot.entity.position.x),
      Math.floor(this.bot.entity.position.y),
      Math.floor(this.bot.entity.position.z)
    );

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2]]) {
      const targetPos = base.offset(dx, 0, dz);
      const belowPos = base.offset(dx, -1, dz);
      const target = this.bot.blockAt(targetPos);
      const below = this.bot.blockAt(belowPos);
      const targetOk = target && REPLACEABLE_NAMES.has(target.name?.toLowerCase?.() ?? '');
      const belowOk = below && !INVALID_SUPPORT_NAMES.has(below.name?.toLowerCase?.() ?? '');
      if (targetOk && belowOk) {
        try {
          await this.bot.equip(item, 'hand');
          await this.bot.placeBlock(below, new Vec3(0, 1, 0));
          return this.bot.blockAt(targetPos);
        } catch {}
      }
    }
    return null;
  }

  async _ensureCraftingTable(signal) {
    const tableDef = this.bot.registry?.blocksByName?.crafting_table;
    if (tableDef && typeof this.bot.findBlock === 'function') {
      const existing = this.bot.findBlock({ matching: tableDef.id, maxDistance: 16 });
      if (existing) {
        await this._moveNextTo(existing);
        return existing;
      }
    }

    const tableItemDef = this.bot.registry?.itemsByName?.crafting_table;
    if (tableItemDef && this._countItem(tableItemDef.id) === 0) {
      const crafted = await this._craftRecursive(tableItemDef.id, 1, 1, signal, false);
      if (!crafted) return null;
    }

    const placed = await this._placeUtilityBlock('crafting_table');
    if (placed) return placed;

    if (tableDef && typeof this.bot.findBlock === 'function') {
      return this.bot.findBlock({ matching: tableDef.id, maxDistance: 16 });
    }
    return null;
  }

  async _trySmeltMissingIngredient(ingId, reqTotal, signal) {
    if (typeof this.bot.openFurnace !== 'function') return false;
    const ingName = this.bot.registry?.items?.[ingId]?.name?.toLowerCase?.();
    const smeltRule = ingName ? SMELT_OUTPUT_TO_INPUT[ingName] : null;
    if (!smeltRule) return false;

    const neededToSmelt = Math.max(1, reqTotal - this._countItem(ingId));
    const items = this.bot.inventory?.items?.() ?? [];
    const hasRawInput = items.some(i => smeltRule.inputs.includes(i?.name?.toLowerCase?.()) && (i.count ?? 0) > 0);
    const fuelChoice = this._selectFuel(items, neededToSmelt);
    if (!hasRawInput || !fuelChoice || fuelChoice.insufficient) return false;

    try {
      await this.smeltItem(smeltRule.smeltTarget, neededToSmelt, signal);
    } catch {
      return false;
    }
    return this._countItem(ingId) >= reqTotal;
  }

  async _craftRecursive(itemId, count, depth, signal, allowTable = true) {
    if (signal?.aborted) throw new Error('Đã hủy');
    if (depth > 4) return false;

    const already = this._countItem(itemId);
    const need = Math.max(1, count);
    if (already >= need && depth > 0) return true;

    const recipes = this.bot.recipesAll?.(itemId, null, allowTable) ?? [];
    if (recipes.length === 0) return false;

    for (const recipe of recipes) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if (recipe.requiresTable && !allowTable) continue;
      const perCraft = recipe.result?.count ?? 1;
      const craftsNeeded = Math.ceil((depth === 0 ? need : (need - already)) / perCraft);
      if (craftsNeeded <= 0) return true;

      const missing = (recipe.delta ?? []).filter(d => d.count < 0);
      let ok = true;
      for (let pass = 0; pass < 3; pass++) {
        let allSatisfied = true;
        for (const ing of missing) {
          const reqTotal = Math.abs(ing.count) * craftsNeeded;
          if (this._countItem(ing.id) < reqTotal) {
            allSatisfied = false;
            if (ing.id === itemId) { ok = false; break; }
            let made = await this._craftRecursive(ing.id, reqTotal, depth + 1, signal, allowTable);
            if (!made) {
              made = await this._trySmeltMissingIngredient(ing.id, reqTotal, signal);
            }
            if (!made) { ok = false; break; }
          }
        }
        if (!ok || allSatisfied) break;
      }
      if (!ok || missing.some(ing => this._countItem(ing.id) < Math.abs(ing.count) * craftsNeeded)) continue;

      let tableBlock = null;
      if (recipe.requiresTable) {
        tableBlock = await this._ensureCraftingTable(signal);
        if (!tableBlock) continue;
        let topUpOk = true;
        for (const ing of missing) {
          const reqTotal = Math.abs(ing.count) * craftsNeeded;
          if (this._countItem(ing.id) < reqTotal) {
            if (ing.id === itemId) { topUpOk = false; break; }
            let made = await this._craftRecursive(ing.id, reqTotal, depth + 1, signal, allowTable);
            if (!made) {
              made = await this._trySmeltMissingIngredient(ing.id, reqTotal, signal);
            }
            if (!made || this._countItem(ing.id) < reqTotal) { topUpOk = false; break; }
          }
        }
        if (!topUpOk || missing.some(ing => this._countItem(ing.id) < Math.abs(ing.count) * craftsNeeded)) continue;
      }

      const readyRecipes = this.bot.recipesFor?.(itemId, null, craftsNeeded * perCraft, tableBlock ?? null) ?? [recipe];
      const chosen = readyRecipes[0] ?? recipe;
      await this.bot.craft(chosen, craftsNeeded, tableBlock ?? null);
      this.log(`🔨 Đã chế tạo x${craftsNeeded * perCraft} (itemId=${itemId})`);
      return true;
    }

    return false;
  }

  async craftItem(targetText, count = 1, signal = null) {
    const itemName = resolveCraftName(targetText, this.bot.registry, this.bot.inventory?.items?.() ?? []);
    const itemDef = this.bot.registry?.itemsByName?.[itemName];
    if (!itemDef) {
      throw new Error(`Không tìm thấy vật phẩm "${targetText}" để chế tạo.`);
    }
    if (typeof this.bot.craft !== 'function') {
      throw new Error('Bot chưa hỗ trợ bot.craft.');
    }

    const ok = await this._craftRecursive(itemDef.id, count, 0, signal, true);
    if (!ok) {
      throw new Error(`Thiếu nguyên liệu để chế tạo ${count} ${itemName}.`);
    }
    return { name: itemName, count };
  }

  _selectFuel(items, desiredCount) {
    const valid = [];
    let sawAnyFuel = false;
    for (const rule of FUEL_VALUES) {
      for (const item of items) {
        const name = item?.name?.toLowerCase?.() ?? '';
        if (!name || !rule.match(name)) continue;
        sawAnyFuel = true;
        const maxItems = Math.floor((item.count ?? 0) * rule.per);
        if (maxItems >= 1) {
          valid.push({ item, per: rule.per, maxItems });
        }
      }
    }
    if (valid.length === 0) {
      return sawAnyFuel ? { insufficient: true } : null;
    }
    const sufficient = valid.find(v => v.maxItems >= desiredCount);
    if (sufficient) return sufficient;
    return valid.reduce((best, cur) => (cur.maxItems > best.maxItems ? cur : best), valid[0]);
  }

  async _findOrPlaceFurnace(signal = null) {
    const blocks = this.bot.registry?.blocksByName ?? {};
    const furnaceIds = ['furnace', 'blast_furnace', 'smoker'].map(n => blocks[n]?.id).filter(Boolean);
    if (furnaceIds.length > 0 && typeof this.bot.findBlock === 'function') {
      const existing = this.bot.findBlock({ matching: furnaceIds, maxDistance: 16 });
      if (existing) {
        await this._moveNextTo(existing);
        return existing;
      }
    }
    const hasFurnaceItem = (this.bot.inventory?.items?.() ?? []).some(i => i?.name === 'furnace');
    if (!hasFurnaceItem && this.bot.registry?.itemsByName?.furnace && typeof this.bot.craft === 'function') {
      await this.craftItem('lò nung', 1, signal).catch(() => {});
    }
    return this._placeUtilityBlock('furnace');
  }

  async smeltItem(targetText, count = 1, signal = null, { pollMs = 500, timeoutMs = null } = {}) {
    const candidates = resolveSmeltInputs(targetText);
    const items = this.bot.inventory?.items?.() ?? [];
    const input = items.find(i => candidates.includes(i?.name?.toLowerCase()));
    if (!input) {
      throw new Error(`Không có nguyên liệu "${targetText}" để nung trong túi.`);
    }

    const desired = Math.min(count, input.count);
    const initialFuelChoice = this._selectFuel(items, desired);
    if (!initialFuelChoice) {
      throw new Error('Không có nhiên liệu (than, gỗ, ván) để nung.');
    }
    if (initialFuelChoice.insufficient) {
      throw new Error('Nhiên liệu không đủ để nung ít nhất 1 món.');
    }

    const furnaceBlock = await this._findOrPlaceFurnace(signal);
    if (!furnaceBlock || typeof this.bot.openFurnace !== 'function') {
      throw new Error('Không có lò nung gần đây và thiếu 8 đá cuội để làm lò.');
    }

    const latestItems = this.bot.inventory?.items?.() ?? items;
    const latestInput = latestItems.find(i => candidates.includes(i?.name?.toLowerCase())) ?? input;
    const currentInputCount = latestInput?.count ?? 0;
    const fuelChoice = this._selectFuel(latestItems, Math.min(count, currentInputCount)) ?? initialFuelChoice;
    if (fuelChoice.insufficient) {
      throw new Error('Nhiên liệu không đủ để nung ít nhất 1 món.');
    }

    const toSmelt = Math.min(count, currentInputCount, fuelChoice.maxItems);
    if (toSmelt < 1) {
      throw new Error(`Không đủ nguyên liệu hoặc nhiên liệu để nung "${targetText}".`);
    }
    const fuelNeeded = Math.min(fuelChoice.item.count, Math.max(1, Math.ceil(toSmelt / fuelChoice.per)));
    const effectiveTimeoutMs = timeoutMs ?? (toSmelt * 10000 + 15000);
    const furnace = await this.bot.openFurnace(furnaceBlock);

    try {
      await furnace.putFuel(fuelChoice.item.type, fuelChoice.item.metadata ?? null, fuelNeeded);
      await furnace.putInput(latestInput.type, latestInput.metadata ?? null, toSmelt);

      let outputCount = 0;
      let outputName = null;
      const deadline = Date.now() + effectiveTimeoutMs;

      while (outputCount < toSmelt && Date.now() < deadline) {
        if (signal?.aborted) throw new Error('Đã hủy');
        const out = furnace.outputItem?.();
        if (out && out.count > 0) {
          outputName = out.name ?? outputName;
          const got = out.count;
          await furnace.takeOutput();
          outputCount += got;
          if (outputCount >= toSmelt) break;
        }
        await SLEEP(pollMs);
      }

      this.log(`🔥 Đã nung xong ${outputCount}/${toSmelt} ${outputName ?? targetText}`);
      return { name: outputName ?? latestInput.name, count: outputCount, requested: toSmelt };
    } finally {
      try { furnace.close?.(); } catch {}
    }
  }
}

export default CraftManager;
