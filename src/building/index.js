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

export class Builder {
  constructor(bot, config = {}, { log = () => {}, equipment = null, memory = null, isPaused = null } = {}) {
    this.bot = bot;
    this.config = config.building ?? {};
    this.log = typeof log === 'function' ? log : () => {};
    this.equipment = equipment;
    this.memory = memory;
    this.isPaused = isPaused;
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
    const pos = this.bot.entity?.position;
    if (!pos) return false;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);
    return bx === target.x && bz === target.z && (by === target.y || by + 1 === target.y);
  }

  async _moveWithinReach(target, signal) {
    if (!this.bot.pathfinder?.goto || !this.bot.entity?.position) return;
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
        if (!inside || stillInside || nowDist <= 4.2) return;
      } catch (err) {
        checkAbort(signal);
        if ((err.name === 'GoalChanged' || err.name === 'PathStopped') && this.isPaused?.()) {
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
