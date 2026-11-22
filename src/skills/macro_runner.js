import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { foodSupply } from '../readiness.js';

const CHEST_BLOCK_NAMES = new Set(['chest', 'trapped_chest', 'barrel']);

export const BUILTIN_MACROS = Object.freeze({
  prepare_caving_kit: {
    description: 'Chuẩn bị bộ đồ đi hang: đảm bảo que, đuốc, cúp đủ cấp, thức ăn và mặc trang bị tốt nhất',
    steps: [
      { action: 'ensure_item', item: 'stick', minCount: 8, fallbackCraft: true },
      { action: 'ensure_item', item: 'torch', minCount: 32, fallbackCraft: true },
      { action: 'ensure_tool_tier', minTier: 'stone' },
      { action: 'restock_food', minFoodPoints: 40 },
      { action: 'equip_best_all' },
    ],
  },
  deposit_mining_loot: {
    description: 'Về nhà, thu lò nung đã xong và cất toàn bộ đồ dư vào rương nhà',
    steps: [
      { action: 'return_home' },
      { action: 'collect_ready_furnaces' },
      { action: 'deposit_excess_items', keepCategories: ['TOOLS', 'WEAPONS', 'ARMOR', 'FOOD', 'TORCH'] },
    ],
  },
});

function countItemByName(items = [], itemName) {
  const target = String(itemName ?? '').toLowerCase();
  return (items ?? [])
    .filter(i => String(i?.name ?? '').toLowerCase() === target)
    .reduce((sum, i) => sum + (i.count ?? 1), 0);
}

export function createSessionMacroHandlers(ctx) {
  const { bot, crafting, survival, equipment, home, smelting } = ctx;

  return {
    async ensure_item(step, signal) {
      const target = String(step.item ?? '').trim();
      const minCount = Math.max(1, Number(step.minCount ?? 1));
      let have = countItemByName(bot.inventory?.items?.() ?? [], target);
      if (have >= minCount) {
        return { ok: true, detail: { item: target, count: have } };
      }

      if (home?.findInChests && typeof bot.openChest === 'function') {
        const hits = home.findInChests(target);
        for (const hit of hits) {
          if (have >= minCount || signal?.aborted) break;
          if (hit.x == null || hit.y == null || hit.z == null) continue;
          try {
            await ctx.gotoSafe?.(new goals.GoalGetToBlock(hit.x, hit.y, hit.z), signal);
            const block = bot.blockAt?.(new Vec3(hit.x, hit.y, hit.z));
            if (block && CHEST_BLOCK_NAMES.has(block.name)) {
              await home.takeFromChest(block, target, minCount - have);
              have = countItemByName(bot.inventory?.items?.() ?? [], target);
            }
          } catch (err) {
            if (signal?.aborted) throw err;
          }
        }
      }

      if (have < minCount && step.fallbackCraft && crafting?.craftItem) {
        try {
          await crafting.craftItem(target, minCount - have, signal);
        } catch (err) {
          if (signal?.aborted) throw err;
        }
        have = countItemByName(bot.inventory?.items?.() ?? [], target);
      }

      if (have < minCount) {
        return { ok: false, reason: `MISSING_${target.toUpperCase()}`, detail: { have, minCount } };
      }
      return { ok: true, detail: { item: target, count: have } };
    },

    async ensure_tool_tier(step, signal) {
      const tier = String(step.minTier ?? 'stone');
      const ok = await survival?.ensurePickaxe?.(tier, signal);
      if (!ok) {
        return { ok: false, reason: `MISSING_PICKAXE_${tier.toUpperCase()}` };
      }
      return { ok: true, detail: { tier } };
    },

    async restock_food(step, signal) {
      const minPts = Math.max(1, Number(step.minFoodPoints ?? 20));
      let pts = foodSupply(bot.inventory?.items?.() ?? []);
      if (pts < minPts && home?.findInChests && typeof bot.openChest === 'function') {
        for (const candidate of ['bread', 'cooked_beef', 'cooked_porkchop', 'baked_potato', 'apple']) {
          if (pts >= minPts || signal?.aborted) break;
          const hits = home.findInChests(candidate);
          if (hits.length === 0) continue;
          const hit = hits[0];
          try {
            await ctx.gotoSafe?.(new goals.GoalGetToBlock(hit.x, hit.y, hit.z), signal);
            const block = bot.blockAt?.(new Vec3(hit.x, hit.y, hit.z));
            if (block && CHEST_BLOCK_NAMES.has(block.name)) {
              await home.takeFromChest(block, candidate, 8);
              pts = foodSupply(bot.inventory?.items?.() ?? []);
            }
          } catch (err) {
            if (signal?.aborted) throw err;
          }
        }
      }
      if (pts < minPts) {
        return { ok: false, reason: 'INSUFFICIENT_FOOD', detail: { foodPoints: pts, minFoodPoints: minPts } };
      }
      return { ok: true, detail: { foodPoints: pts } };
    },

    async equip_best_all() {
      const res = await equipment?.maintain?.();
      return { ok: true, detail: res ?? {} };
    },

    async return_home(_step, signal) {
      const target = home?.get?.();
      if (!target) {
        return { ok: false, reason: 'NO_HOME_SET' };
      }
      await ctx.gotoSafe?.(new goals.GoalNear(target.x, target.y, target.z, 2), signal);
      return { ok: true, detail: { x: target.x, y: target.y, z: target.z } };
    },

    async collect_ready_furnaces(_step, signal) {
      if (!smelting?.collectReadyOutputs) {
        return { ok: true, detail: { collected: [], pendingCount: 0 } };
      }
      const res = await smelting.collectReadyOutputs(signal);
      return { ok: true, detail: res };
    },

    async deposit_excess_items(_step, signal) {
      let chest = typeof bot.findBlock === 'function'
        ? bot.findBlock({ matching: b => b && CHEST_BLOCK_NAMES.has(b.name), maxDistance: 6 })
        : null;
      if (!chest) {
        const saved = home?.getStorageChest?.();
        if (!saved) {
          return { ok: false, reason: 'NO_STORAGE_CHEST' };
        }
        await ctx.gotoSafe?.(new goals.GoalGetToBlock(saved.x, saved.y, saved.z), signal);
        chest = bot.blockAt?.(new Vec3(saved.x, saved.y, saved.z));
      }
      if (!chest || !CHEST_BLOCK_NAMES.has(chest.name)) {
        return { ok: false, reason: 'CHEST_NOT_FOUND' };
      }
      const stored = await home.storeSurplus(chest);
      return { ok: true, detail: { stored: Boolean(stored) } };
    },
  };
}

export class MacroRunner {
  constructor(handlers = {}, { log = () => {} } = {}) {
    this.handlers = handlers;
    this.log = typeof log === 'function' ? log : () => {};
  }

  listMacros() {
    return Object.entries(BUILTIN_MACROS).map(([name, def]) => ({
      name,
      description: def.description,
      steps: def.steps.length,
    }));
  }

  async run(macroName, signal = null) {
    const macro = BUILTIN_MACROS[macroName];
    if (!macro) {
      return { ok: false, error: `UNKNOWN_MACRO: ${macroName}` };
    }

    const completedSteps = [];
    for (let idx = 0; idx < macro.steps.length; idx++) {
      if (signal?.aborted) {
        return { ok: false, reason: 'ABORTED', abortedAtStep: idx, completedSteps };
      }
      const step = macro.steps[idx];
      const fn = this.handlers[step.action];
      if (typeof fn !== 'function') {
        return { ok: false, reason: `MISSING_HANDLER: ${step.action}`, failedStep: idx, completedSteps };
      }
      const res = await fn(step, signal);
      if (!res?.ok) {
        const reason = res?.reason || 'STEP_FAILED';
        this.log(`⚠️ [Macro:${macroName}] Dừng tại bước #${idx} (${step.action}): ${reason}`);
        return {
          ok: false,
          failedStep: idx,
          stepAction: step.action,
          reason,
          detail: res?.detail ?? null,
          completedSteps,
        };
      }
      completedSteps.push({ step: idx, action: step.action, detail: res.detail ?? null });
    }

    this.log(`✅ [Macro:${macroName}] Hoàn thành ${completedSteps.length} bước`);
    return { ok: true, macroName, completedSteps };
  }
}

export default MacroRunner;
