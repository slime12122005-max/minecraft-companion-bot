import path from 'node:path';
import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import {
  FACING_TO_PLAYER_YAW,
  SCHEMATIC_CATALOG,
  checkAbort,
  downloadSchematic,
  loadBlueprint,
  rotatePosition,
  sleep,
} from './blueprint_loader.js';
import { buildSupplyPlan, calculateMaterialShortage } from './material_calculator.js';
import { isSmallHole, isVegetation, prepareSite } from './site_preparer.js';
import { buildBlueprint, findSupport } from './scaffold_placer.js';

export { SCHEMATIC_CATALOG, downloadSchematic, rotatePosition, calculateMaterialShortage, buildSupplyPlan };

export function intersectsBlockAABB(entityPos, blockPos) {
  if (!entityPos || !blockPos) return false;
  const bx = Math.floor(blockPos.x);
  const by = Math.floor(blockPos.y);
  const bz = Math.floor(blockPos.z);
  return (
    Math.abs(entityPos.x - (bx + 0.5)) < 0.8 &&
    entityPos.y < by + 1 &&
    entityPos.y + 1.8 > by &&
    Math.abs(entityPos.z - (bz + 0.5)) < 0.8
  );
}

export class Builder {
  constructor(bot, config = {}, { log = () => {}, equipment = null, memory = null, isPaused = null, isInterrupted = null } = {}) {
    this.bot = bot;
    this.config = config.building ?? {};
    this.ownerName = config.owner ?? null;
    this.log = typeof log === 'function' ? log : () => {};
    this.equipment = equipment;
    this.memory = memory;
    this.isPaused = isPaused;
    this.isInterrupted = isInterrupted ?? (() => Boolean(this.isPaused?.()));
    this.schematic = null;
    this.loadedFile = null;
    this.blueprint = null;
  }

  async _load(file) {
    if (typeof file !== 'string' || !file.trim()) throw new TypeError('A schematic file path is required');
    const fullPath = path.resolve(file);
    if (this.blueprint && this.loadedFile === fullPath) return this.blueprint;
    const loaded = await loadBlueprint(file, { bot: this.bot, config: this.config });
    this.schematic = loaded.schematic;
    this.loadedFile = loaded.file;
    this.blueprint = loaded.blueprint;
    return this.blueprint;
  }

  async inspect(file) {
    const bp = await this._load(file);
    return {
      file: this.loadedFile,
      size: { ...bp.size },
      blockCount: bp.blocks.length,
      materials: { ...bp.materials },
      catalog: SCHEMATIC_CATALOG,
    };
  }

  async calculateMaterials(file, { home = null } = {}) {
    const info = await this.inspect(file);
    const invItems = this.bot.inventory?.items?.() ?? [];
    const chestTotals = home?.listChestInventory?.() ?? {};
    return calculateMaterialShortage(info.materials, invItems, chestTotals);
  }

  async planMaterialSupply(file, { home = null } = {}) {
    const analysis = await this.calculateMaterials(file, { home });
    return {
      ...analysis,
      supplyPlan: buildSupplyPlan(analysis.missing),
    };
  }

  async _waitIfPaused(signal) {
    while (this.isPaused?.()) {
      checkAbort(signal);
      await sleep(200);
    }
  }

  _isStandingInside(target) {
    return intersectsBlockAABB(this.bot.entity?.position, target);
  }

  _isOwnerInside(target) {
    if (!this.ownerName) return false;
    const ownerPos = this.bot.players?.[this.ownerName]?.entity?.position ?? null;
    return intersectsBlockAABB(ownerPos, target);
  }

  async _moveWithinReach(target, signal) {
    if (!this.bot.pathfinder?.goto || !this.bot.entity?.position) return;
    let escapeAttempts = 0;
    while (true) {
      checkAbort(signal);
      await this._waitIfPaused(signal);
      const inside = this._isStandingInside(target);
      const dist = this.bot.entity.position.distanceTo(target);
      if (!inside && dist <= 4.2) return;

      const goal = inside
        ? new goals.GoalInvert(new goals.GoalBlock(target.x, target.y, target.z))
        : new goals.GoalNear(target.x, target.y, target.z, 3.2);

      try {
        await this.bot.pathfinder.goto(goal);
        const stillInside = this._isStandingInside(target);
        const nowDist = this.bot.entity.position.distanceTo(target);
        if (!inside) return;
        if (!stillInside && nowDist <= 4.2) return;
        if (stillInside) {
          escapeAttempts += 1;
          if (escapeAttempts >= 3) {
            throw new Error(`Cannot move out of target block at ${target.x},${target.y},${target.z}`);
          }
        }
      } catch (err) {
        checkAbort(signal);
        if ((err?.name === 'GoalChanged' || err?.name === 'PathStopped') && this.isInterrupted?.()) {
          continue;
        }
        throw err;
      }
    }
  }

  build(args = {}, signal) {
    return buildBlueprint(this, args, signal);
  }

  async _placeOriented(referenceBlock, face, properties = {}) {
    const yaw = typeof properties.facing === 'string' ? FACING_TO_PLAYER_YAW[properties.facing] : undefined;
    if (yaw !== undefined && typeof this.bot.look === 'function' && typeof this.bot._placeBlockWithOptions === 'function') {
      await this.bot.look(yaw, 0, true);
      const half = properties.half === 'top' || properties.half === 'bottom' ? properties.half : undefined;
      await this.bot._placeBlockWithOptions(referenceBlock, face, { swingArm: 'right', forceLook: 'ignore', half });
      return;
    }
    await this.bot.placeBlock(referenceBlock, face);
  }

  _findSupport(target) {
    return findSupport(this.bot, target);
  }

  prepare(args = {}, signal) {
    return prepareSite(this, args, signal);
  }

  _isVegetation(block) {
    return isVegetation(block);
  }

  _isSmallHole(target) {
    return isSmallHole(this.bot, target);
  }
}

export default Builder;
