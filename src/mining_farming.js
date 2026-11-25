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
const REPLACEABLE_GROUND_PLANTS = new Set([
  'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dead_bush', 'dandelion', 'poppy',
]);
const ENDERMAN_ROOF_PREFERRED = [
  'cobblestone', 'cobbled_deepslate', 'end_stone', 'stone', 'deepslate',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'crimson_planks', 'warped_planks',
  'stone_bricks', 'bricks', 'blackstone', 'obsidian', 'andesite', 'diorite', 'granite',
  'terracotta', 'oak_log', 'spruce_log', 'birch_log', 'dark_oak_log', 'jungle_log', 'acacia_log',
];
const ENDERMAN_ROOF_FALLBACK = ['netherrack', 'dirt'];
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
      setShelterHold = null,
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
    this.setShelterHold = setShelterHold;
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

  scanValuableOresDetailed() {
    const now = Date.now();
    if (now - this.lastOreScanAt < 5000) return [];
    this.lastOreScanAt = now;

    if (typeof this.bot.findBlocks !== 'function' || !this.bot.registry?.blocksByName) return [];
    const ids = RARE_ORES.map(n => this.bot.registry.blocksByName[n]?.id).filter(Boolean);
    if (ids.length === 0) return [];

    const positions = this.bot.findBlocks({ matching: ids, maxDistance: 10, count: 6 }) ?? [];
    const findings = [];

    for (const p of positions) {
      const key = `${p.x},${p.y},${p.z}`;
      const seenAt = this.reportedOres.get(key) ?? 0;
      if (now - seenAt < 300000) continue;
      this.reportedOres.set(key, now);
      const block = this.bot.blockAt?.(p);
      const name = block?.name ?? 'quặng quý';
      findings.push({
        name,
        x: p.x,
        y: p.y,
        z: p.z,
        message: `Phát hiện ${name} tại ${p.x}, ${p.y}, ${p.z}!`,
      });
    }
    return findings;
  }

  scanValuableOres() {
    return this.scanValuableOresDetailed().map(entry => entry.message);
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

  _shouldPlaceTorch(targetFeet, step) {
    if (typeof this.bot.world?.getBlockLight === 'function') {
      const blockLight = this.bot.world.getBlockLight(targetFeet);
      const skyLight = typeof this.bot.world?.getSkyLight === 'function' ? this.bot.world.getSkyLight(targetFeet) : 0;
      const tod = this.bot.time?.timeOfDay;
      const isNight = this.bot.time?.isDay === false || (typeof tod === 'number' && tod >= 12542 && tod <= 23459);
      return blockLight < 7 && (skyLight < 7 || isNight);
    }
    return step % 8 === 0;
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
          const heldType = this.bot.heldItem?.type ?? null;
          if (typeof block.canHarvest === 'function' && !block.canHarvest(heldType)) {
            return { steps: dugSteps, stoppedReason: `công cụ hiện tại không đủ cấp để đào ${block.name}` };
          }
          await this._digSafe(block, signal);
        }
      }

      await this._gotoSafe(new goals.GoalBlock(targetFeet.x, targetFeet.y, targetFeet.z), signal);

      dugSteps++;

      if (this._shouldPlaceTorch(targetFeet, step) && typeof this.bot.placeBlock === 'function') {
        const torch = (this.bot.inventory?.items?.() ?? []).find(i => i?.name === 'torch');
        const floor = this.bot.blockAt(targetFeet.offset(0, -1, 0));
        if (torch && floor && floor.name !== 'air' && (floor.boundingBox == null || floor.boundingBox === 'block')) {
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

  async farmCrops(signal = null, { forageSeeds = true } = {}) {
    if (typeof this.bot.findBlocks !== 'function' || typeof this.bot.dig !== 'function') {
      throw new Error('Bot chưa sẵn sàng làm ruộng.');
    }

    const blocksByName = this.bot.registry?.blocksByName ?? {};
    const cropIds = Object.keys(CROP_MATURE_AGE).map(n => blocksByName[n]?.id).filter(Boolean);
    const positions = cropIds.length > 0
      ? (this.bot.findBlocks({ matching: cropIds, maxDistance: 24, count: 64 }) ?? [])
      : [];
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

    const PLANTABLE_ITEMS = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds'];
    const countPlantableSeeds = () => (this.bot.inventory?.items?.() ?? []).reduce(
      (sum, item) => (PLANTABLE_ITEMS.includes(item?.name) ? sum + Math.max(1, Number(item.count ?? 1)) : sum),
      0
    );

    const farmlandId = blocksByName.farmland?.id;
    const emptyFarmland = [];
    if (farmlandId) {
      const farmPositions = this.bot.findBlocks({ matching: [farmlandId], maxDistance: 20, count: 48 }) ?? [];
      for (const fp of farmPositions) {
        const abovePos = fp.offset ? fp.offset(0, 1, 0) : new Vec3(fp.x, fp.y + 1, fp.z);
        const above = this.bot.blockAt?.(abovePos);
        if (!above || isAirBlock(above)) {
          emptyFarmland.push(fp);
        }
      }
    }

    let foragedSeeds = 0;
    if (emptyFarmland.length > 0 && forageSeeds !== false) {
      const seedsBeforeForage = countPlantableSeeds();
      const missingSeeds = emptyFarmland.length - seedsBeforeForage;
      if (missingSeeds > 0) {
        const GRASS_NAMES = ['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern'];
        const grassIds = GRASS_NAMES.map((n) => blocksByName[n]?.id).filter(Boolean);
        if (grassIds.length > 0) {
          const grassPositions = this.bot.findBlocks({
            matching: grassIds,
            maxDistance: 24,
            count: Math.min(missingSeeds * 4, 20),
          }) ?? [];
          for (const gp of grassPositions) {
            if (countPlantableSeeds() >= emptyFarmland.length) break;
            if (signal?.aborted) throw new Error('Đã hủy');
            while (this.isPaused?.()) {
              if (signal?.aborted) throw new Error('Đã hủy');
              await sleep(200);
            }
            const gBlock = this.bot.blockAt?.(gp);
            if (!gBlock || !GRASS_NAMES.includes(gBlock.name)) continue;
            if (this.bot.entity?.position && this.bot.entity.position.distanceTo(gp) > 3.5) {
              await this._gotoSafe(new goals.GoalNear(gp.x, gp.y, gp.z, 2), signal);
            }
            await this._digSafe(gBlock, signal);
            if (this.seedWaitMs > 0) {
              await sleep(Math.min(this.seedWaitMs, 200));
              if (signal?.aborted) throw new Error('Đã hủy');
            }
            if (this.bot.pathfinder?.goto && this.bot.entity?.position) {
              const drop = Object.values(this.bot.entities ?? {})
                .filter((e) => e?.position && (e.name === 'item' || e.displayName === 'Item'))
                .map((e) => ({
                  pos: e.position,
                  dist: Math.hypot(e.position.x - gp.x, e.position.y - gp.y, e.position.z - gp.z),
                }))
                .filter((x) => x.dist <= 3.5)
                .sort((a, b) => a.dist - b.dist)[0];
              if (drop) {
                try {
                  await this._gotoSafe(new goals.GoalNear(drop.pos.x, drop.pos.y, drop.pos.z, 0.8), signal);
                } catch (err) {
                  if (signal?.aborted) throw err;
                }
              }
            }
          }
        }
      }
      foragedSeeds = Math.max(0, countPlantableSeeds() - seedsBeforeForage);
    }

    if (emptyFarmland.length > 0 && countPlantableSeeds() > 0 && typeof this.bot.placeBlock === 'function') {
      for (const fp of emptyFarmland) {
        if (signal?.aborted) throw new Error('Đã hủy');
        while (this.isPaused?.()) {
          if (signal?.aborted) throw new Error('Đã hủy');
          await sleep(200);
        }
        const soil = this.bot.blockAt?.(fp);
        const abovePos = fp.offset ? fp.offset(0, 1, 0) : new Vec3(fp.x, fp.y + 1, fp.z);
        const above = this.bot.blockAt?.(abovePos);
        if (!soil || soil.name !== 'farmland' || (above && !isAirBlock(above))) continue;

        const seedItem = (this.bot.inventory?.items?.() ?? []).find((i) => PLANTABLE_ITEMS.includes(i?.name));
        if (!seedItem) break;
        if (this.bot.entity?.position && this.bot.entity.position.distanceTo(fp) > 3.5) {
          await this._gotoSafe(new goals.GoalNear(fp.x, fp.y, fp.z, 2), signal);
        }
        try {
          await this.bot.equip(seedItem, 'hand');
          await this.bot.placeBlock(soil, new Vec3(0, 1, 0));
          replanted++;
        } catch {}
      }
    }

    if (foragedSeeds > 0) {
      this.log(`🌾 Thu hoạch ${harvested}, kiếm thêm ${foragedSeeds} hạt, gieo lại ${replanted}`);
      return { harvested, replanted, foragedSeeds };
    }
    this.log(`🌾 Thu hoạch ${harvested}, gieo lại ${replanted}`);
    return { harvested, replanted };
  }

  hasMatureCropsNearby(maxDistance = 16) {
    if (typeof this.bot.findBlocks !== 'function' || !this.bot.registry?.blocksByName) return false;
    const blocksByName = this.bot.registry.blocksByName;
    const cropIds = Object.keys(CROP_MATURE_AGE).map((n) => blocksByName[n]?.id).filter(Boolean);
    if (cropIds.length === 0) return false;
    const positions = this.bot.findBlocks({ matching: cropIds, maxDistance, count: 16 }) ?? [];
    for (const p of positions) {
      if (this._isMatureCrop(this.bot.blockAt?.(p))) return true;
    }
    return false;
  }

  async harvestHayBales(maxBlocks = 3, signal = null) {
    if (typeof this.bot.findBlocks !== 'function' || typeof this.bot.dig !== 'function') {
      return { dug: 0 };
    }
    const hayId = this.bot.registry?.blocksByName?.hay_block?.id;
    if (!hayId) return { dug: 0 };
    const positions = (this.bot.findBlocks({ matching: hayId, maxDistance: 24, count: maxBlocks }) ?? [])
      .slice(0, maxBlocks);
    let dug = 0;

    for (const p of positions) {
      if (signal?.aborted) throw new Error('Đã hủy');
      while (this.isPaused?.()) {
        if (signal?.aborted) throw new Error('Đã hủy');
        await sleep(200);
      }
      if (this.bot.entity?.position && this.bot.entity.position.distanceTo(p) > 3.5) {
        await this._gotoSafe(new goals.GoalNear(p.x, p.y, p.z, 2), signal);
      }
      const block = this.bot.blockAt?.(p);
      if (!block || block.name !== 'hay_block') continue;

      const hoe = (this.bot.inventory?.items?.() ?? []).find((i) => i?.name?.endsWith('_hoe'));
      if (hoe && typeof this.bot.equip === 'function') {
        try { await this.bot.equip(hoe, 'hand'); } catch {}
      } else if (this.bot.tool?.equipForBlock) {
        try { await this.bot.tool.equipForBlock(block); } catch {}
      }

      await this._digSafe(block, signal);
      dug++;
      if (this.bot.pathfinder?.goto && this.bot.entity?.position) {
        try {
          await this._gotoSafe(new goals.GoalNear(p.x, p.y, p.z, 0.8), signal);
        } catch (err) {
          if (signal?.aborted) throw err;
        }
      }
    }

    if (dug > 0) this.log(`🌾 Đã thu thập ${dug} kiện rơm.`);
    return { dug };
  }

  findNearestFoodAnimal(maxDistance = 20) {
    const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'mooshroom', 'rabbit']);
    const pos = this.bot.entity?.position;
    if (!pos) return null;

    return Object.values(this.bot.entities ?? {})
      .filter((e) => {
        if (!e?.position) return false;
        const name = String(e.name ?? '').toLowerCase();
        if (!FOOD_ANIMALS.has(name)) return false;
        if (e.isBaby || e.metadata?.[16] === true) return false;
        if (e.customName || e.metadata?.[2]) return false;
        if (e.health !== undefined && e.health <= 0) return false;
        return pos.distanceTo(e.position) <= maxDistance;
      })
      .sort((a, b) => pos.distanceTo(a.position) - pos.distanceTo(b.position))[0] ?? null;
  }

  async huntNearbyFoodAnimal(signal = null) {
    const target = this.findNearestFoodAnimal(20);
    if (!target || typeof this.bot.attack !== 'function') return { hunted: null, kills: 0 };

    let lastPos = target.position;
    const waitMs = this.seedWaitMs === 0 ? 10 : 650;

    for (let hit = 0; hit < 10; hit++) {
      if (signal?.aborted) throw new Error('Đã hủy');
      while (this.isPaused?.()) {
        if (signal?.aborted) throw new Error('Đã hủy');
        await sleep(200);
      }
      const live = target.id != null ? (this.bot.entities?.[target.id] ?? null) : target;
      if (!live || !live.position || (live.health !== undefined && live.health <= 0)) break;
      lastPos = live.position;

      if (this.bot.entity?.position && this.bot.entity.position.distanceTo(live.position) > 2.8) {
        await this._gotoSafe(new goals.GoalNear(live.position.x, live.position.y, live.position.z, 2), signal);
      }

      const items = this.bot.inventory?.items?.() ?? [];
      const weapon = items.find((i) => i?.name?.endsWith('_sword')) ?? items.find((i) => i?.name?.endsWith('_axe'));
      if (weapon && typeof this.bot.equip === 'function' && this.bot.heldItem?.name !== weapon.name) {
        try { await this.bot.equip(weapon, 'hand'); } catch {}
      }
      if (typeof this.bot.lookAt === 'function') {
        try { await this.bot.lookAt(live.position.offset(0, 0.7, 0), true); } catch {}
      }
      await this.bot.attack(live);
      await sleep(waitMs);
    }

    if (lastPos && this.bot.pathfinder?.goto) {
      await sleep(this.seedWaitMs === 0 ? 10 : 250);
      if (!signal?.aborted) {
        try {
          await this._gotoSafe(new goals.GoalNear(lastPos.x, lastPos.y, lastPos.z, 0.8), signal);
        } catch (err) {
          if (signal?.aborted) throw err;
        }
      }
    }

    this.log(`🥩 Đã săn ${target.name} lấy thịt.`);
    return { hunted: target.name, kills: 1 };
  }

  _pickRoofBlockItem() {
    const items = this.bot.inventory?.items?.() ?? [];
    for (const name of ENDERMAN_ROOF_PREFERRED) {
      const hit = items.find((i) => String(i?.name ?? '').toLowerCase() === name && (i.count ?? 1) > 0);
      if (hit) return hit;
    }
    for (const name of ENDERMAN_ROOF_FALLBACK) {
      const hit = items.find((i) => String(i?.name ?? '').toLowerCase() === name && (i.count ?? 1) > 0);
      if (hit) return hit;
    }
    return null;
  }

  _countRoofBlocks() {
    const allowed = new Set([...ENDERMAN_ROOF_PREFERRED, ...ENDERMAN_ROOF_FALLBACK]);
    return (this.bot.inventory?.items?.() ?? []).reduce((sum, i) => {
      const n = String(i?.name ?? '').toLowerCase();
      return allowed.has(n) ? sum + Math.max(0, Number(i.count ?? 1)) : sum;
    }, 0);
  }

  _isTreeTrunkBlock(b) {
    const n = String(b?.name ?? '').toLowerCase();
    return n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_wood') || n.endsWith('_hyphae');
  }

  _findEndermanShelterSpot() {
    const pos = this.bot.entity?.position;
    if (!pos) return null;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);

    if (typeof this.bot.blockAt !== 'function') {
      return { x: bx, y: by, z: bz, alreadyBuilt: false, kind: 'built_3x3' };
    }

    const isSolid = (b) => Boolean(b && b.boundingBox === 'block');
    const isGoodGround = (b) => isSolid(b) && !isLiquidHazard(b) && b.name !== 'farmland';
    const blocksEndermanCol = (x, y, z) => (
      isSolid(this.bot.blockAt(new Vec3(x, y, z))) ||
      isSolid(this.bot.blockAt(new Vec3(x, y + 1, z))) ||
      isSolid(this.bot.blockAt(new Vec3(x, y + 2, z)))
    );
    const isInteriorClearable = (b) => {
      if (!b) return true;
      if (isLiquidHazard(b)) return false;
      if (b.boundingBox === 'block' && (b.diggable === false || this._isTreeTrunkBlock(b))) return false;
      return true;
    };

    const offsets = [];
    for (let dx = -14; dx <= 14; dx++) {
      for (let dz = -14; dz <= 14; dz++) {
        offsets.push([dx, dz]);
      }
    }
    offsets.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));

    // 1. Hide under an existing low tree canopy or previously built shelter (0 blocks needed)
    let bestExisting = null;
    for (const dy of [0, 1, -1, 2, -2]) {
      for (const [dx, dz] of offsets) {
        const cx = bx + dx;
        const cy = by + dy;
        const cz = bz + dz;
        if (!isGoodGround(this.bot.blockAt(new Vec3(cx, cy - 1, cz)))) continue;
        const body0 = this.bot.blockAt(new Vec3(cx, cy, cz));
        const body1 = this.bot.blockAt(new Vec3(cx, cy + 1, cz));
        if (isSolid(body0) || isSolid(body1)) continue;
        if (!isSolid(this.bot.blockAt(new Vec3(cx, cy + 2, cz)))) continue;

        let cardinalsSafe = true;
        let openCardinals = 0;
        for (const [rx, rz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (!blocksEndermanCol(cx + rx, cy, cz + rz)) {
            cardinalsSafe = false;
            break;
          }
          if (!isSolid(this.bot.blockAt(new Vec3(cx + rx, cy, cz + rz))) && !isSolid(this.bot.blockAt(new Vec3(cx + rx, cy + 1, cz + rz)))) {
            openCardinals++;
          }
        }
        if (!cardinalsSafe || openCardinals < 2) continue;

        let blockedCount = 0;
        let hasTrunk = false;
        for (let rx = -1; rx <= 1; rx++) {
          for (let rz = -1; rz <= 1; rz++) {
            if (blocksEndermanCol(cx + rx, cy, cz + rz)) blockedCount++;
            if (rx === 0 && rz === 0) continue;
            if (
              this._isTreeTrunkBlock(this.bot.blockAt(new Vec3(cx + rx, cy, cz + rz))) ||
              this._isTreeTrunkBlock(this.bot.blockAt(new Vec3(cx + rx, cy + 1, cz + rz)))
            ) {
              hasTrunk = true;
            }
          }
        }
        if (blockedCount < 7) continue;

        const score = Math.hypot(dx, dz) + Math.abs(dy) * 2 - (hasTrunk ? 3.5 : 0) - (blockedCount === 9 ? 1.0 : 0);
        if (!bestExisting || score < bestExisting.score) {
          bestExisting = { x: cx, y: cy, z: cz, alreadyBuilt: true, kind: hasTrunk ? 'tree' : 'canopy', score };
        }
      }
    }
    if (bestExisting) {
      return { x: bestExisting.x, y: bestExisting.y, z: bestExisting.z, alreadyBuilt: true, kind: bestExisting.kind };
    }

    // 2. Attach a 3x3 overhead roof onto an adjacent taller tree trunk or solid wall (0 pillar blocks needed)
    const attachedOffsets = offsets.filter(([dx, dz]) => Math.hypot(dx, dz) <= 8);
    for (const dy of [0, 1, -1]) {
      for (const [dx, dz] of attachedOffsets) {
        const cx = bx + dx;
        const cy = by + dy;
        const cz = bz + dz;
        if (!isGoodGround(this.bot.blockAt(new Vec3(cx, cy - 1, cz)))) continue;
        if (!isInteriorClearable(this.bot.blockAt(new Vec3(cx, cy, cz))) || !isInteriorClearable(this.bot.blockAt(new Vec3(cx, cy + 1, cz)))) continue;

        let touchesSupport = false;
        let safeSides = true;
        for (let rx = -1; rx <= 1 && safeSides; rx++) {
          for (let rz = -1; rz <= 1 && safeSides; rz++) {
            const b0 = this.bot.blockAt(new Vec3(cx + rx, cy, cz + rz));
            const b1 = this.bot.blockAt(new Vec3(cx + rx, cy + 1, cz + rz));
            if (isLiquidHazard(b0) || isLiquidHazard(b1)) safeSides = false;
            if ((isSolid(b0) && b0.diggable === false) || (isSolid(b1) && b1.diggable === false)) safeSides = false;
            const rp = new Vec3(cx + rx, cy + 2, cz + rz);
            if (!touchesSupport) {
              for (const [ox, oy, oz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
                if (isSolid(this.bot.blockAt(rp.offset(ox, oy, oz)))) {
                  touchesSupport = true;
                  break;
                }
              }
            }
          }
        }
        if (safeSides && touchesSupport) {
          return { x: cx, y: cy, z: cz, alreadyBuilt: false, kind: 'attached_3x3' };
        }
      }
    }

    // 3. Pick flat safe open ground within 4 blocks to build a standalone 3x3 overhead roof
    const buildOffsets = offsets.filter(([dx, dz]) => Math.hypot(dx, dz) <= 4);
    for (const dy of [0, 1, -1]) {
      for (const [dx, dz] of buildOffsets) {
        const cx = bx + dx;
        const cy = by + dy;
        const cz = bz + dz;
        if (!isGoodGround(this.bot.blockAt(new Vec3(cx, cy - 1, cz)))) continue;
        if (!isGoodGround(this.bot.blockAt(new Vec3(cx + 1, cy - 1, cz)))) continue;

        let valid = true;
        for (let rx = -1; rx <= 1 && valid; rx++) {
          for (let rz = -1; rz <= 1 && valid; rz++) {
            if (!isInteriorClearable(this.bot.blockAt(new Vec3(cx + rx, cy, cz + rz)))) valid = false;
            if (!isInteriorClearable(this.bot.blockAt(new Vec3(cx + rx, cy + 1, cz + rz)))) valid = false;
          }
        }
        if (valid) return { x: cx, y: cy, z: cz, alreadyBuilt: false, kind: 'built_3x3' };
      }
    }
    return null;
  }

  async _placeBlockAtTarget(targetPos, signal = null) {
    const cur = this.bot.blockAt?.(targetPos);
    if (cur?.boundingBox === 'block') return true;

    if (
      cur &&
      cur.name &&
      !AIR_BLOCKS.has(cur.name) &&
      cur.diggable !== false &&
      typeof this.bot.dig === 'function'
    ) {
      await this._digSafe(cur, signal);
    }

    if (typeof this.bot.placeBlock !== 'function') {
      throw new Error('Bot không hỗ trợ đặt block.');
    }

    const dirs = [
      [0, -1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
      [0, 1, 0],
    ];
    let refBlock = null;
    let faceVec = null;
    for (const [dx, dy, dz] of dirs) {
      const cand = this.bot.blockAt?.(targetPos.offset(dx, dy, dz));
      if (cand?.boundingBox === 'block') {
        refBlock = cand;
        faceVec = new Vec3(-dx, -dy, -dz);
        break;
      }
    }
    if (!refBlock) return false;

    const item = this._pickRoofBlockItem();
    if (!item) throw new Error('Hết khối xây mái che Enderman.');

    if (typeof this.bot.equip === 'function') {
      await this.bot.equip(item, 'hand');
    }
    if (typeof this.bot.lookAt === 'function' && refBlock.position) {
      try { await this.bot.lookAt(refBlock.position.offset(0.5, 0.5, 0.5), true); } catch {}
    }
    await this.bot.placeBlock(refBlock, faceVec);
    return true;
  }

  async buildEndermanShelter(signal = null) {
    if (signal?.aborted) throw new Error('Đã hủy');
    const spot = this._findEndermanShelterSpot();
    if (!spot) {
      throw new Error('Không tìm được gốc cây hay chỗ phẳng an toàn quanh đây để che đầu farm Enderman.');
    }

    const { x: cx, y: cy, z: cz } = spot;
    const standPos = new Vec3(cx + 0.5, cy, cz + 0.5);
    const roofOrder = [
      [1, 0], [0, 0], [1, 1], [1, -1], [0, 1], [0, -1], [-1, 0], [-1, 1], [-1, -1],
    ];
    const roofPositions = roofOrder.map(([rx, rz]) => new Vec3(cx + rx, cy + 2, cz + rz));

    if (spot.alreadyBuilt) {
      await this._gotoSafe(new goals.GoalNear(standPos.x, standPos.y, standPos.z, 0.45), signal);
      let touchedUp = 0;
      if (this._countRoofBlocks() > 0 && typeof this.bot.blockAt === 'function' && typeof this.bot.placeBlock === 'function') {
        for (const [rx, rz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          const isColBlocked = [0, 1, 2].some(
            (dy) => this.bot.blockAt(new Vec3(cx + rx, cy + dy, cz + rz))?.boundingBox === 'block'
          );
          if (isColBlocked || this._countRoofBlocks() <= 0) continue;
          try {
            if (await this._placeBlockAtTarget(new Vec3(cx + rx, cy + 2, cz + rz), signal)) {
              touchedUp++;
            }
          } catch {}
        }
      }
      this.log(`🌳 Đã núp dưới ${spot.kind === 'tree' ? 'gốc cây' : 'mái che sẵn'} tại ${cx}, ${cy}, ${cz}.`);
      return { center: { x: cx, y: cy, z: cz }, standPos, placed: touchedUp, kind: spot.kind };
    }

    const missingRoof = typeof this.bot.blockAt === 'function'
      ? roofPositions.filter((rp) => this.bot.blockAt(rp)?.boundingBox !== 'block').length
      : roofPositions.length;

    let hasExistingSupport = false;
    if (typeof this.bot.blockAt === 'function') {
      for (const rp of roofPositions) {
        if (this.bot.blockAt(rp)?.boundingBox === 'block') {
          hasExistingSupport = true;
          break;
        }
        for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
          if (this.bot.blockAt(rp.offset(dx, dy, dz))?.boundingBox === 'block') {
            hasExistingSupport = true;
            break;
          }
        }
        if (hasExistingSupport) break;
      }
    }

    const pillarNeeded = missingRoof > 0 && !hasExistingSupport ? 2 : 0;
    const minRequired = pillarNeeded > 0
      ? (typeof this.bot.dig === 'function' ? Math.max(missingRoof, 3) : missingRoof + pillarNeeded)
      : missingRoof;
    if (missingRoof > 0 && this._countRoofBlocks() < minRequired) {
      throw new Error(`Cần ít nhất ${minRequired} khối rắn (đá cuội, ván gỗ, đá End...) trong túi để đặt mái che 3x3 trên đầu.`);
    }

    await this._gotoSafe(new goals.GoalNear(standPos.x, standPos.y, standPos.z, 0.5), signal);

    if (typeof this.bot.blockAt === 'function' && typeof this.bot.dig === 'function') {
      for (let rx = -1; rx <= 1; rx++) {
        for (let rz = -1; rz <= 1; rz++) {
          for (const dy of [0, 1]) {
            const p = new Vec3(cx + rx, cy + dy, cz + rz);
            const blk = this.bot.blockAt(p);
            if (blk && blk.boundingBox === 'block' && blk.diggable !== false && !this._isTreeTrunkBlock(blk)) {
              if (this.bot.tool?.equipForBlock) {
                try { await this.bot.tool.equipForBlock(blk); } catch {}
              }
              await this._digSafe(blk, signal);
            }
          }
        }
      }
    }

    let placed = 0;
    if (pillarNeeded > 0) {
      const p0 = new Vec3(cx + 1, cy, cz);
      const p1 = new Vec3(cx + 1, cy + 1, cz);
      const tempPillar = [];
      if (await this._placeBlockAtTarget(p0, signal)) tempPillar.push(p0);
      if (await this._placeBlockAtTarget(p1, signal)) tempPillar.push(p1);

      const anchorRoof = new Vec3(cx + 1, cy + 2, cz);
      if (this.bot.blockAt?.(anchorRoof)?.boundingBox !== 'block') {
        if (await this._placeBlockAtTarget(anchorRoof, signal)) placed++;
      }

      if (typeof this.bot.dig === 'function') {
        for (let i = tempPillar.length - 1; i >= 0; i--) {
          const p = tempPillar[i];
          const blk = this.bot.blockAt?.(p);
          if (blk && blk.boundingBox === 'block' && blk.diggable !== false) {
            if (this.bot.tool?.equipForBlock) {
              try { await this.bot.tool.equipForBlock(blk); } catch {}
            }
            await this._digSafe(blk, signal);
          }
        }
        await sleep(this.seedWaitMs === 0 ? 5 : 400);
      }
    }

    let remaining = [...roofPositions];
    for (let pass = 0; pass < 4 && remaining.length > 0; pass++) {
      if (signal?.aborted) throw new Error('Đã hủy');
      const nextRemaining = [];
      let progressed = false;
      for (const rp of remaining) {
        const already = typeof this.bot.blockAt === 'function' && this.bot.blockAt(rp)?.boundingBox === 'block';
        if (already) {
          progressed = true;
          continue;
        }
        const ok = await this._placeBlockAtTarget(rp, signal);
        if (ok) {
          placed++;
          progressed = true;
        } else {
          nextRemaining.push(rp);
        }
      }
      remaining = nextRemaining;
      if (!progressed) break;
    }

    await this._gotoSafe(new goals.GoalNear(standPos.x, standPos.y, standPos.z, 0.45), signal);
    this.log(`🛡️ Đã đặt xong mái 3x3 trên đầu tại ${cx}, ${cy}, ${cz}.`);
    return { center: { x: cx, y: cy, z: cz }, standPos, placed, kind: spot.kind ?? 'built_3x3' };
  }

  _canSeeEndermanEyes(standPos, center, entity) {
    if (!entity?.position) return false;
    if (typeof this.bot.blockAt !== 'function') return true;
    const x0 = standPos.x;
    const y0 = standPos.y + 1.62;
    const z0 = standPos.z;
    const x1 = entity.position.x;
    const y1 = entity.position.y + 2.52;
    const z1 = entity.position.z;

    for (const t of [0.25, 0.5, 0.75]) {
      const bx = Math.floor(x0 + (x1 - x0) * t);
      const by = Math.floor(y0 + (y1 - y0) * t);
      const bz = Math.floor(z0 + (z1 - z0) * t);
      if (Math.abs(bx - center.x) <= 1 && Math.abs(bz - center.z) <= 1 && by === center.y + 2) {
        continue;
      }
      const blk = this.bot.blockAt(new Vec3(bx, by, bz));
      if (!blk || blk.boundingBox !== 'block') continue;
      const n = String(blk.name ?? '').toLowerCase();
      if (!['glass', 'bars'].some((k) => n.includes(k))) {
        return false;
      }
    }
    return true;
  }

  async farmEndermen(targetCount = 8, { countMode = 'kills', maxIdleChecks = 6 } = {}, signal = null) {
    const goalTarget = Math.max(1, Number(targetCount ?? 8));
    const { center, standPos, placed, kind } = await this.buildEndermanShelter(signal);

    const countPearls = () => (this.bot.inventory?.items?.() ?? []).reduce(
      (sum, i) => (String(i?.name ?? '').toLowerCase() === 'ender_pearl' ? sum + Math.max(1, Number(i.count ?? 1)) : sum),
      0
    );
    const startPearls = countPearls();
    const progress = () => (countMode === 'pearls' ? Math.max(0, countPearls() - startPearls) : kills);

    let kills = 0;
    const engagedIds = new Set();
    let emptyChecks = 0;
    const stepWaitMs = this.seedWaitMs === 0 ? 12 : 250;
    const swingWaitMs = this.seedWaitMs === 0 ? 12 : 650;

    const sweepNearbyPearls = async () => {
      if (!this.bot.entity?.position || !this.bot.pathfinder?.goto) return;
      const hasDangerNear = Object.values(this.bot.entities ?? {}).some((e) =>
        e?.position &&
        String(e.name ?? '').toLowerCase() === 'enderman' &&
        (e.health === undefined || e.health > 0) &&
        standPos.distanceTo(e.position) <= 8
      );
      if (hasDangerNear) return;

      const drops = Object.values(this.bot.entities ?? {})
        .filter((e) => e?.position && (e.name === 'item' || e.objectType === 'Item' || e.displayName === 'Item') && standPos.distanceTo(e.position) <= 10)
        .sort((a, b) => standPos.distanceTo(a.position) - standPos.distanceTo(b.position));
      if (drops.length === 0) return;

      this.setShelterHold?.(null);
      try {
        for (const drop of drops.slice(0, 3)) {
          if (signal?.aborted) throw new Error('Đã hủy');
          try {
            await this.bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.8));
          } catch (err) {
            if (signal?.aborted) throw err;
          }
          await sleep(stepWaitMs);
        }
        try {
          await this.bot.pathfinder.goto(new goals.GoalNear(standPos.x, standPos.y, standPos.z, 0.45));
        } catch (err) {
          if (signal?.aborted) throw err;
        }
      } finally {
        this.setShelterHold?.(standPos);
      }
    };

    const maxLoops = Math.max(40, goalTarget * 60 + 40);
    this.setShelterHold?.(standPos);
    try {
      for (let iter = 0; iter < maxLoops && progress() < goalTarget; iter++) {
        if (signal?.aborted) throw new Error('Đã hủy');
        while (this.isPaused?.()) {
          if (signal?.aborted) throw new Error('Đã hủy');
          await sleep(100);
        }

        if (this.bot.entity?.position && this.bot.entity.position.distanceTo(standPos) > 0.85 && this.bot.pathfinder?.goto) {
          try {
            await this.bot.pathfinder.goto(new goals.GoalNear(standPos.x, standPos.y, standPos.z, 0.4));
          } catch (err) {
            if (signal?.aborted) throw err;
          }
        }

        for (const id of [...engagedIds]) {
          const live = this.bot.entities?.[id];
          if (!live || (live.health !== undefined && live.health <= 0)) {
            engagedIds.delete(id);
            kills++;
          }
        }
        if (progress() >= goalTarget) break;

        const endermen = Object.values(this.bot.entities ?? {})
          .filter((e) => {
            if (!e?.position) return false;
            if (String(e.name ?? '').toLowerCase() !== 'enderman') return false;
            if (e.health !== undefined && e.health <= 0) return false;
            return standPos.distanceTo(e.position) <= 64;
          })
          .map((e) => ({ entity: e, dist: standPos.distanceTo(e.position) }))
          .sort((a, b) => a.dist - b.dist);

        const closeEntry = endermen.find((x) => x.dist <= 3.45);
        if (closeEntry) {
          const closeE = closeEntry.entity;
          emptyChecks = 0;
          if (closeE.id != null) engagedIds.add(closeE.id);

          const items = this.bot.inventory?.items?.() ?? [];
          const weapon = items.find((i) => i?.name?.endsWith('_sword')) ?? items.find((i) => i?.name?.endsWith('_axe'));
          if (weapon && typeof this.bot.equip === 'function' && this.bot.heldItem?.name !== weapon.name) {
            try { await this.bot.equip(weapon, 'hand'); } catch {}
          }
          if (typeof this.bot.lookAt === 'function') {
            try { await this.bot.lookAt(closeE.position.offset(0, 1.4, 0), true); } catch {}
          }
          if (typeof this.bot.attack === 'function') {
            await this.bot.attack(closeE);
          }
          if (closeE.health !== undefined && closeE.health <= 0) {
            if (closeE.id != null) engagedIds.delete(closeE.id);
            kills++;
          }
          await sleep(swingWaitMs);
          continue;
        }

        const aggroEntry = endermen.find(
          (x) => x.dist <= 40 && (x.entity.target === this.bot.entity || (x.entity.id != null && engagedIds.has(x.entity.id)))
        );
        if (aggroEntry) {
          emptyChecks = 0;
          if (typeof this.bot.lookAt === 'function') {
            const p = aggroEntry.entity.position;
            try { await this.bot.lookAt(new Vec3(p.x, p.y + 2.52, p.z), true); } catch {}
          }
          await sleep(stepWaitMs);
          continue;
        }

        const lureEntry = endermen.find((x) => this._canSeeEndermanEyes(standPos, center, x.entity));
        if (lureEntry) {
          const lureTarget = lureEntry.entity;
          emptyChecks = 0;
          if (lureTarget.id != null) engagedIds.add(lureTarget.id);
          if (typeof this.bot.lookAt === 'function') {
            const p = lureTarget.position;
            try { await this.bot.lookAt(new Vec3(p.x, p.y + 2.52, p.z), true); } catch {}
          }
          await sleep(this.seedWaitMs === 0 ? 15 : 450);
          continue;
        }

        await sweepNearbyPearls();
        emptyChecks++;
        if (emptyChecks >= maxIdleChecks) break;
        await sleep(stepWaitMs);
      }

      if (!signal?.aborted) {
        await sweepNearbyPearls();
      }
    } finally {
      this.setShelterHold?.(null);
    }

    const pearlsGained = Math.max(0, countPearls() - startPearls);
    this.log(`👁️ Farm Enderman xong: ${kills} Enderman, +${pearlsGained} ngọc Ender.`);
    return { kills, pearlsGained, shelter: center, roofPlaced: placed, shelterKind: kind };
  }
}

export default MiningFarmingManager;
