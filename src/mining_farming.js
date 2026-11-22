import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { hasPickaxeTier, requiredPickTier } from './readiness.js';
import { raceTimeout } from './survival/constants.js';

const RARE_ORES = ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'ancient_debris'];
const CROP_MATURE_AGE = {
  wheat: 7,
  carrots: 7,
  potatoes: 7,
  beetroots: 3,
};
const CROP_TO_SEED = {
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
};
const FALLING_BLOCKS = new Set(['sand', 'red_sand', 'gravel']);
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isAirBlock(block) {
  return Boolean(block && AIR_BLOCKS.has(block.name));
}

function snapCardinal(yaw = 0) {
  // In Mineflayer: 0 = north (-z), PI = south (+z), PI/2 = west (-x), -PI/2 = east (+x)
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  if (Math.abs(dx) >= Math.abs(dz)) {
    return new Vec3(dx >= 0 ? 1 : -1, 0, 0);
  }
  return new Vec3(0, 0, dz >= 0 ? 1 : -1);
}

function isLiquidHazard(block) {
  const n = block?.name?.toLowerCase() ?? '';
  return n.includes('lava') || n.includes('water');
}

export class MiningFarmingManager {
  constructor(
    bot,
    config = {},
    {
      log = () => {},
      isPaused = null,
      isInterrupted = null,
      ensurePickaxe = null,
      digTimeoutMs = null,
      seedWaitMs = 350,
    } = {}
  ) {
    this.bot = bot;
    this.config = config;
    this.log = log;
    this.isPaused = isPaused;
    this.isInterrupted = isInterrupted ?? (() => Boolean(this.isPaused?.()));
    this.ensurePickaxe = ensurePickaxe;
    this.digTimeoutMs = digTimeoutMs;
    this.seedWaitMs = seedWaitMs;
    this.reportedOres = new Map();
    this.lastOreScanAt = 0;
  }

  async _gotoSafe(goal, signal) {
    if (!this.bot.pathfinder?.goto) return;
    while (!signal?.aborted) {
      while (this.isPaused?.() && !signal?.aborted) {
        await sleep(200);
      }
      if (signal?.aborted) throw new Error('Đã hủy');
      try {
        await this.bot.pathfinder.goto(goal);
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        if ((err?.name === 'GoalChanged' || err?.name === 'PathStopped') && this.isInterrupted?.()) {
          continue;
        }
        throw err;
      }
    }
  }

  scanValuableOres() {
    const now = Date.now();
    if (now - this.lastOreScanAt < 5000) return [];
    this.lastOreScanAt = now;

    if (typeof this.bot.findBlocks !== 'function' || !this.bot.registry?.blocksByName) return [];
    const ids = RARE_ORES.map(n => this.bot.registry.blocksByName[n]?.id).filter(Boolean);
    if (ids.length === 0) return [];

    const positions = this.bot.findBlocks({ matching: ids, maxDistance: 10, count: 6 }) ?? [];
    const alerts = [];

    for (const p of positions) {
      const key = `${p.x},${p.y},${p.z}`;
      const seenAt = this.reportedOres.get(key) ?? 0;
      if (now - seenAt < 300000) continue;
      this.reportedOres.set(key, now);
      const block = this.bot.blockAt?.(p);
      const name = block?.name ?? 'quặng quý';
      alerts.push(`Phát hiện ${name} tại ${p.x}, ${p.y}, ${p.z}!`);
    }
    return alerts;
  }

  async _digSafe(block, signal) {
    while (!signal?.aborted) {
      while (this.isPaused?.() && !signal?.aborted) {
        await sleep(200);
      }
      if (signal?.aborted) throw new Error('Đã hủy');

      const estMs = typeof this.bot.digTime === 'function' ? this.bot.digTime(block) : 3000;
      const timeoutMs = this.digTimeoutMs > 0
        ? this.digTimeoutMs
        : Math.min(Math.max((Number.isFinite(estMs) ? estMs : 3000) + 3500, 5000), 15000);

      const abortHandler = () => {
        try { this.bot.stopDigging?.(); } catch {}
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      try {
        await raceTimeout(this.bot.dig(block), timeoutMs, abortHandler);
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        const interruptedByPause = this.isInterrupted?.() && (
          err?.name === 'GoalChanged' ||
          err?.name === 'PathStopped' ||
          /Digging aborted/i.test(err?.message ?? '')
        );
        if (interruptedByPause) {
          continue;
        }
        throw err;
      } finally {
        signal?.removeEventListener('abort', abortHandler);
      }
    }
  }

  _checkTunnelSafe(nextFeet, dir = null) {
    if (typeof this.bot.blockAt !== 'function') return { safe: true };
    const checks = [
      nextFeet,
      nextFeet.offset(0, 1, 0),
      nextFeet.offset(0, 2, 0),
      nextFeet.offset(0, -1, 0),
    ];
    if (dir) {
      const side = new Vec3(-dir.z, 0, dir.x);
      checks.push(
        nextFeet.offset(side.x, 0, side.z),
        nextFeet.offset(-side.x, 0, -side.z),
        nextFeet.offset(side.x, 1, side.z),
        nextFeet.offset(-side.x, 1, -side.z)
      );
    }
    for (const p of checks) {
      const b = this.bot.blockAt(p);
      if (!b) continue;
      if (isLiquidHazard(b)) return { safe: false, reason: `gặp ${b.name} tại ${p.x},${p.y},${p.z}` };
    }
    const ceiling = this.bot.blockAt(nextFeet.offset(0, 2, 0));
    if (ceiling && FALLING_BLOCKS.has(ceiling.name)) {
      return { safe: false, reason: `có ${ceiling.name} dễ sập phía trên tại ${ceiling.position?.x ?? nextFeet.x},${ceiling.position?.y ?? nextFeet.y + 2},${ceiling.position?.z ?? nextFeet.z}` };
    }
    const floor = this.bot.blockAt(nextFeet.offset(0, -1, 0));
    const belowFloor = this.bot.blockAt(nextFeet.offset(0, -2, 0));
    if (isAirBlock(floor) && isAirBlock(belowFloor)) {
      return { safe: false, reason: `có vực/hang sâu phía trước tại ${nextFeet.x},${nextFeet.y - 1},${nextFeet.z}` };
    }
    return { safe: true };
  }

  async digTunnel(length = 16, signal = null) {
    if (!this.bot.entity?.position || typeof this.bot.dig !== 'function') {
      throw new Error('Bot chưa sẵn sàng đào hầm.');
    }

    const dir = snapCardinal(this.bot.entity.yaw ?? 0);
    const start = this.bot.entity.position.floored
      ? this.bot.entity.position.floored()
      : new Vec3(Math.floor(this.bot.entity.position.x), Math.floor(this.bot.entity.position.y), Math.floor(this.bot.entity.position.z));

    const enforcePickaxe = Boolean(this.ensurePickaxe) ||
      (typeof this.bot.inventory?.items === 'function' && hasPickaxeTier(this.bot.inventory.items() ?? [], 'wood'));

    let dugSteps = 0;
    for (let step = 1; step <= length; step++) {
      if (signal?.aborted) throw new Error('Đã hủy');
      while (this.isPaused?.()) {
        if (signal?.aborted) throw new Error('Đã hủy');
        await sleep(200);
      }

      const targetFeet = start.offset(dir.x * step, 0, dir.z * step);
      const targetHead = targetFeet.offset(0, 1, 0);
      const aheadCheck = targetFeet.offset(dir.x, 0, dir.z);

      const safety = this._checkTunnelSafe(targetFeet, dir);
      if (!safety.safe) {
        return { steps: dugSteps, stoppedReason: safety.reason };
      }
      const aheadSafety = this._checkTunnelSafe(aheadCheck);
      if (!aheadSafety.safe) {
        return { steps: dugSteps, stoppedReason: aheadSafety.reason };
      }

      for (const pos of [targetHead, targetFeet]) {
        if (signal?.aborted) throw new Error('Đã hủy');
        while (this.isPaused?.()) {
          if (signal?.aborted) throw new Error('Đã hủy');
          await sleep(200);
        }
        const block = this.bot.blockAt(pos);
        if (block && block.name !== 'air' && block.diggable !== false) {
          if (enforcePickaxe) {
            const reqTier = requiredPickTier([block.name]);
            if (reqTier !== 'none' && !hasPickaxeTier(this.bot.inventory?.items?.() ?? [], reqTier)) {
              if (typeof this.ensurePickaxe === 'function') {
                await this.ensurePickaxe(reqTier, signal).catch(() => false);
              }
              if (!hasPickaxeTier(this.bot.inventory?.items?.() ?? [], reqTier)) {
                return { steps: dugSteps, stoppedReason: 'hỏng hoặc hết cuốc đào phù hợp' };
              }
            }
          }
          if (this.bot.tool?.equipForBlock) {
            try { await this.bot.tool.equipForBlock(block); } catch {}
          }
          await this._digSafe(block, signal);
        }
      }

      await this._gotoSafe(new goals.GoalBlock(targetFeet.x, targetFeet.y, targetFeet.z), signal);

      dugSteps++;

      if (step % 8 === 0 && typeof this.bot.placeBlock === 'function') {
        const torch = (this.bot.inventory?.items?.() ?? []).find(i => i?.name === 'torch');
        const floor = this.bot.blockAt(targetFeet.offset(0, -1, 0));
        if (torch && floor && floor.name !== 'air') {
          try {
            await this.bot.equip(torch, 'hand');
            await this.bot.placeBlock(floor, new Vec3(0, 1, 0));
          } catch {}
        }
      }
    }

    this.log(`⛏️ Đã đào hầm xong ${dugSteps} block`);
    return { steps: dugSteps, stoppedReason: null };
  }

  _isMatureCrop(block) {
    if (!block?.name) return false;
    const maxAge = CROP_MATURE_AGE[block.name];
    if (maxAge == null) return false;
    const props = block.getProperties?.() ?? block.properties ?? {};
    return Number(props.age) >= maxAge;
  }

  async farmCrops(signal = null) {
    if (typeof this.bot.findBlocks !== 'function' || typeof this.bot.dig !== 'function') {
      throw new Error('Bot chưa sẵn sàng làm ruộng.');
    }

    const blocksByName = this.bot.registry?.blocksByName ?? {};
    const cropIds = Object.keys(CROP_MATURE_AGE).map(n => blocksByName[n]?.id).filter(Boolean);
    if (cropIds.length === 0) return { harvested: 0, replanted: 0 };

    const positions = this.bot.findBlocks({ matching: cropIds, maxDistance: 24, count: 64 }) ?? [];
    let harvested = 0;
    let replanted = 0;

    for (const p of positions) {
      if (signal?.aborted) throw new Error('Đã hủy');
      while (this.isPaused?.()) {
        if (signal?.aborted) throw new Error('Đã hủy');
        await sleep(200);
      }

      const block = this.bot.blockAt(p);
      if (!this._isMatureCrop(block)) continue;
      const cropName = block.name;

      if (this.bot.entity?.position && this.bot.entity.position.distanceTo(p) > 3.5) {
        await this._gotoSafe(new goals.GoalNear(p.x, p.y, p.z, 2), signal);
      }

      await this._digSafe(block, signal);
      harvested++;

      const seedName = CROP_TO_SEED[cropName];
      const findSeed = () => (seedName
        ? (this.bot.inventory?.items?.() ?? []).find(i => i?.name === seedName)
        : null);
      let seed = findSeed();
      if (seedName && !seed) {
        if (this.seedWaitMs > 0) {
          await sleep(this.seedWaitMs);
          if (signal?.aborted) throw new Error('Đã hủy');
        }
        seed = findSeed();
        if (!seed && this.bot.pathfinder?.goto && this.bot.entity?.position) {
          const drop = Object.values(this.bot.entities ?? {})
            .filter(e => e?.position && (e.name === 'item' || e.displayName === 'Item'))
            .map(e => ({
              pos: e.position,
              dist: Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z),
            }))
            .filter(x => x.dist <= 3.5)
            .sort((a, b) => a.dist - b.dist)[0];
          if (drop) {
            try {
              await this._gotoSafe(new goals.GoalNear(drop.pos.x, drop.pos.y, drop.pos.z, 0.8), signal);
            } catch (err) {
              if (signal?.aborted) throw err;
            }
            if (this.seedWaitMs > 0) {
              await sleep(100);
              if (signal?.aborted) throw new Error('Đã hủy');
            }
            seed = findSeed();
          }
        }
      }
      const soil = this.bot.blockAt(p.offset ? p.offset(0, -1, 0) : new Vec3(p.x, p.y - 1, p.z));
      if (seed && soil && soil.name === 'farmland' && typeof this.bot.placeBlock === 'function') {
        try {
          await this.bot.equip(seed, 'hand');
          await this.bot.placeBlock(soil, new Vec3(0, 1, 0));
          replanted++;
        } catch {}
      }
    }

    this.log(`🌾 Thu hoạch ${harvested}, gieo lại ${replanted}`);
    return { harvested, replanted };
  }
}

export default MiningFarmingManager;
