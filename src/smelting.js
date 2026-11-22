import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { resolveSmeltInputs } from './crafting_recipes.js';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const WOODEN_TOOL_SUFFIXES = ['_pickaxe', '_axe', '_sword', '_shovel', '_hoe'];

const FUEL_COAL = {
  match: (name) => name === 'coal' || name === 'charcoal',
  smeltsPerUnit: 8,
};
const FUEL_PLANKS = {
  match: (name) => name.endsWith('_planks'),
  smeltsPerUnit: 1.5,
};
const FUEL_STICKS = {
  match: (name) => name === 'stick',
  smeltsPerUnit: 0.5,
};

function isWoodenTool(name) {
  const n = String(name ?? '').toLowerCase();
  return WOODEN_TOOL_SUFFIXES.some(s => n.endsWith(s));
}

function posKeyOf(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

export class SmeltingManager {
  constructor(bot, config = {}, { memory = null, crafting = null, log = () => {}, isPaused = null, isInterrupted = null } = {}) {
    this.bot = bot;
    this.config = config;
    this.memory = memory;
    this.crafting = crafting;
    this.log = typeof log === 'function' ? log : () => {};
    this.isPaused = isPaused;
    this.isInterrupted = isInterrupted ?? (() => Boolean(this.isPaused?.()));
    this.activeJobs = new Map();

    const saved = this.memory?.get?.('smeltingJobs', null);
    if (saved && typeof saved === 'object') {
      for (const [key, job] of Object.entries(saved)) {
        if (job && job.pos && Number.isFinite(job.pos.x) && Number.isFinite(job.pos.y) && Number.isFinite(job.pos.z)) {
          this.activeJobs.set(key, { ...job, pos: { x: Math.floor(job.pos.x), y: Math.floor(job.pos.y), z: Math.floor(job.pos.z) } });
        }
      }
    }
  }

  _persistJobs() {
    if (!this.memory?.set) return;
    const obj = {};
    for (const [k, v] of this.activeJobs.entries()) {
      obj[k] = v;
    }
    this.memory.set('smeltingJobs', obj);
  }

  hasReadyJob({ maxDistance = 32, now = Date.now() } = {}) {
    const pos = this.bot?.entity?.position;
    for (const job of this.activeJobs.values()) {
      if (now < (job.readyAt ?? 0)) continue;
      if (!pos || !(maxDistance > 0)) return true;
      const dist = Math.hypot(pos.x - job.pos.x, pos.y - job.pos.y, pos.z - job.pos.z);
      if (dist <= maxDistance) return true;
    }
    return false;
  }

  selectOptimalFuel(itemCount) {
    const desired = Math.max(1, Number(itemCount) || 1);
    const items = (this.bot?.inventory?.items?.() ?? []).filter(i => i && !isWoodenTool(i.name) && (i.count ?? 0) > 0);
    const orderedRules = desired <= 2
      ? [FUEL_PLANKS, FUEL_STICKS, FUEL_COAL]
      : [FUEL_COAL, FUEL_PLANKS, FUEL_STICKS];

    for (const rule of orderedRules) {
      const candidates = items.filter(i => rule.match(String(i.name ?? '').toLowerCase()));
      for (const item of candidates) {
        const needed = Math.ceil(desired / rule.smeltsPerUnit);
        if (item.count >= needed) {
          return {
            item,
            count: needed,
            maxItems: Math.floor(item.count * rule.smeltsPerUnit),
            smeltsPerUnit: rule.smeltsPerUnit,
          };
        }
      }
    }

    let bestPartial = null;
    for (const rule of orderedRules) {
      const candidates = items.filter(i => rule.match(String(i.name ?? '').toLowerCase()));
      for (const item of candidates) {
        const maxItems = Math.floor(item.count * rule.smeltsPerUnit);
        if (maxItems < 1) continue;
        if (!bestPartial || maxItems > bestPartial.maxItems) {
          bestPartial = {
            item,
            count: Math.min(item.count, Math.ceil(desired / rule.smeltsPerUnit)),
            maxItems,
            smeltsPerUnit: rule.smeltsPerUnit,
          };
        }
      }
    }
    return bestPartial;
  }

  async _gotoSafe(pos, signal = null) {
    if (!this.bot?.pathfinder?.goto || !this.bot?.entity?.position || !pos) return;
    const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z);
    while (!signal?.aborted) {
      while (this.isPaused?.() && !signal?.aborted) {
        await SLEEP(200);
      }
      if (signal?.aborted) throw new Error('Đã hủy');
      if (this.bot.entity.position.distanceTo(target) <= 4) return;
      try {
        await this.bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2));
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        if ((err?.name === 'GoalChanged' || err?.name === 'PathStopped') && this.isInterrupted?.()) {
          continue;
        }
        throw err;
      }
    }
    if (signal?.aborted) throw new Error('Đã hủy');
  }

  async startSmelting(targetText, count = 1, signal = null) {
    const candidates = resolveSmeltInputs(targetText);
    const items = this.bot?.inventory?.items?.() ?? [];
    const inputItem = items.find(i => candidates.includes(String(i?.name ?? '').toLowerCase()));
    if (!inputItem) {
      return { ok: false, reason: 'MISSING_INPUT_ITEM' };
    }

    const desired = Math.max(1, Math.min(Number(count) || 1, inputItem.count ?? 1, 64));
    const fuelPlan = this.selectOptimalFuel(desired);
    if (!fuelPlan) {
      return { ok: false, reason: 'MISSING_FUEL' };
    }

    const actualCount = Math.min(desired, fuelPlan.maxItems);
    if (actualCount < 1) {
      return { ok: false, reason: 'INSUFFICIENT_FUEL' };
    }
    const fuelCount = Math.min(fuelPlan.item.count, Math.max(1, Math.ceil(actualCount / fuelPlan.smeltsPerUnit)));

    let furnaceBlock = typeof this.bot?.findBlock === 'function'
      ? this.bot.findBlock({
          matching: (b) => {
            const n = String(b?.name ?? '').toLowerCase();
            return n === 'furnace' || n === 'lit_furnace' || n === 'blast_furnace' || n === 'smoker';
          },
          maxDistance: 32,
        })
      : null;

    if (!furnaceBlock && typeof this.crafting?._findOrPlaceFurnace === 'function') {
      furnaceBlock = await this.crafting._findOrPlaceFurnace(signal).catch(() => null);
    }
    if (!furnaceBlock || typeof this.bot?.openFurnace !== 'function') {
      return { ok: false, reason: 'NO_FURNACE_NEARBY' };
    }

    await this._gotoSafe(furnaceBlock.position, signal);
    if (signal?.aborted) return { ok: false, reason: 'ABORTED' };

    const furnace = await this.bot.openFurnace(furnaceBlock);
    try {
      if (furnace.outputItem?.()) {
        await furnace.takeOutput?.();
      }
      await furnace.putFuel(fuelPlan.item.type, fuelPlan.item.metadata ?? null, fuelCount);
      await furnace.putInput(inputItem.type, inputItem.metadata ?? null, actualCount);
    } finally {
      try { furnace.close?.(); } catch {}
    }

    const blockName = String(furnaceBlock.name ?? 'furnace').toLowerCase();
    const msPerItem = (blockName === 'blast_furnace' || blockName === 'smoker') ? 5100 : 10200;
    const durationMs = actualCount * msPerItem;
    const key = posKeyOf(furnaceBlock.position);
    const readyAt = Date.now() + durationMs;

    this.activeJobs.set(key, {
      pos: {
        x: Math.floor(furnaceBlock.position.x),
        y: Math.floor(furnaceBlock.position.y),
        z: Math.floor(furnaceBlock.position.z),
      },
      blockName,
      inputName: inputItem.name,
      expectedCount: actualCount,
      remainingCount: actualCount,
      msPerItem,
      startedAt: Date.now(),
      readyAt,
    });
    this._persistJobs();

    this.log(`🔥 Đã nạp ${actualCount} ${inputItem.name} vào lò (${key}), dự kiến xong sau ${Math.round(durationMs / 1000)}s`);
    return {
      ok: true,
      posKey: key,
      readyAt,
      waitMs: durationMs,
      count: actualCount,
      inputName: inputItem.name,
    };
  }

  async collectReadyOutputs(signal = null, { force = false } = {}) {
    const collected = [];
    const now = Date.now();
    for (const [key, job] of [...this.activeJobs.entries()]) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if (!force && now < (job.readyAt ?? 0)) continue;

      const targetVec = new Vec3(job.pos.x, job.pos.y, job.pos.z);
      if (this.bot?.entity?.position && this.bot.entity.position.distanceTo(targetVec) > 4) {
        await this._gotoSafe(targetVec, signal);
      }

      const block = this.bot?.blockAt?.(targetVec);
      if (!block) {
        // Chunk still unloaded: preserve job in memory instead of dropping it
        continue;
      }
      const bName = String(block.name ?? '').toLowerCase();
      if (!bName.includes('furnace') && bName !== 'smoker') {
        this.activeJobs.delete(key);
        continue;
      }
      if (typeof this.bot?.openFurnace !== 'function') continue;

      const furnace = await this.bot.openFurnace(block);
      try {
        const out = furnace.outputItem?.();
        if (out && (out.count ?? 0) > 0) {
          await furnace.takeOutput();
          collected.push({ name: out.name ?? job.inputName, count: out.count, posKey: key });
        }
        const remainingInput = furnace.inputItem?.();
        if (remainingInput && (remainingInput.count ?? 0) > 0) {
          const msPerItem = job.msPerItem ?? 10200;
          job.remainingCount = remainingInput.count;
          job.readyAt = Date.now() + remainingInput.count * msPerItem;
          this.activeJobs.set(key, job);
        } else {
          this.activeJobs.delete(key);
        }
      } finally {
        try { furnace.close?.(); } catch {}
      }
    }

    this._persistJobs();
    return { collected, pendingCount: this.activeJobs.size };
  }
}

export default SmeltingManager;
