import { resolveCandidateNames } from './constants.js';
import { bestFood, emergencyHeal, autoEat } from './nutrition.js';
import { isOnFire, isInLava, isNether, handleHazards, performUnstuckStep, clearUnstuckControls } from './hazard_reflex.js';
import {
  ITEM_DESPAWN_MS,
  DEFAULT_MAX_DEATH_DISTANCE,
  recordDeath,
  evaluateDeathRecovery,
  getPendingDeathRecovery,
  clearDeath,
  checkHealthAlerts,
  pickupNearbyItem,
  checkAutoReturnCondition,
  checkAutoReturn,
  saveWaypoint,
  getWaypoint,
  listWaypoints,
  isSafeSleepDimension,
  findSafeSleepBed,
} from './shelter_routine.js';
import { scanNearbyThreats } from './threat_radar.js';
import {
  gotoWithTimeout,
  digWithTimeout,
  collectBlockWithTimeout,
  collectNearbyItemDrops,
} from './gather_motion.js';
import {
  findTreeCluster,
  clearTreeFoliageObstruction,
  digReachableTreeLog,
  mineTreeLogBlock,
  chopWholeTree,
} from './gather_tree.js';
import { ensurePickaxe, gather, giveToOwner, countTargetItems } from './gather.js';

export { resolveCandidateNames, scanNearbyThreats, isSafeSleepDimension, findSafeSleepBed, performUnstuckStep, clearUnstuckControls };

export class SurvivalManager {
  constructor(bot, config = {}, { memory = null, home = null, crafting = null, log = () => {} } = {}) {
    this.bot = bot;
    this.config = config;
    this.memory = memory;
    this.home = home;
    this.crafting = crafting;
    this.log = log;
    this.eating = false;
    this.hazardBusy = false;
    this.lastEatAt = 0;
    this.lastHealAt = 0;
    this.lastPickupAt = 0;
    this.lastGaveItemAt = 0;
    this.lastAutoReturnAt = 0;
    this.lastWaterExtinguishAt = 0;
    this.pendingWaterPickupAt = 0;
    this.lastWebDigAt = 0;
    this.lastSuffocationDigAt = 0;
    this._hazardJumpActive = false;
    this._lastTrackPos = null;
    this._lastTrackAt = 0;
    this._lastUnstuckAt = 0;
    this._unstuckCount = 0;
    this._unstuckDir = 1;
    this._unstuckTimers = new Set();
    this._unstuckWaiters = new Set();
    this._lastBotAlertAt = 0;
    this._lastOwnerAlertAt = 0;
    this._timeouts = {
      gotoMs: 18000,
      stuckMs: 4500,
      dropGotoMs: 4000,
      dropStuckMs: 2000,
      digExtraMs: 3500,
      digMinMs: 5000,
      digMaxMs: 15000,
      collectMs: 20000,
      equipMs: 2500,
      lookMs: 1500,
      verifyDelayMs: 120,
      dropWaitMs: 300,
      placeMs: 1500,
      pillarJumpMs: 450,
      pillarSettleMs: 80,
    };
  }

  get busy() {
    return Boolean(this.eating || this.hazardBusy);
  }

  _bestFood() { return bestFood(this.bot); }
  _isOnFire() { return isOnFire(this.bot); }
  _isInLava() { return isInLava(this.bot); }
  _isNether() { return isNether(this.bot); }

  emergencyHeal() { return emergencyHeal(this); }
  autoEat(opts) { return autoEat(this, opts); }
  handleHazards() { return handleHazards(this); }
  unstuck(opts) { return performUnstuckStep(this, opts); }
  stopUnstuck() { return clearUnstuckControls(this); }

  recordDeath(entity, dimension) { return recordDeath(this, entity, dimension); }
  evaluateDeathRecovery(death, opts = {}) {
    return evaluateDeathRecovery(death, {
      fromPos: this.bot?.entity?.position ?? null,
      maxDistance: this.config?.survival?.maxDeathRecoverDistance ?? DEFAULT_MAX_DEATH_DISTANCE,
      itemDespawnMs: this.config?.survival?.itemDespawnMs ?? ITEM_DESPAWN_MS,
      ...opts,
    });
  }
  getPendingDeathRecovery(opts) { return getPendingDeathRecovery(this, opts); }
  clearDeath() { return clearDeath(this); }
  checkHealthAlerts(opts) { return checkHealthAlerts(this, opts); }
  pickupNearbyItem(opts) { return pickupNearbyItem(this, opts); }
  checkAutoReturnCondition(opts) { return checkAutoReturnCondition(this, opts); }
  checkAutoReturn(opts) { return checkAutoReturn(this, opts); }

  scanThreats(opts) { return scanNearbyThreats(this.bot, opts); }

  ensurePickaxe(tier, signal) { return ensurePickaxe(this, tier, signal); }
  countMatchingItems(targetText) { return countTargetItems(this, targetText); }
  gather(targetText, count, signal, opts) { return gather(this, targetText, count, signal, opts); }

  _gotoWithTimeout(goal, opts) { return gotoWithTimeout(this, goal, opts); }
  _digWithTimeout(block, opts) { return digWithTimeout(this, block, opts); }
  _collectBlockWithTimeout(block, opts) { return collectBlockWithTimeout(this, block, opts); }
  _findTreeCluster(seedPos, allowedIds, skipped, maxBlocks) { return findTreeCluster(this, seedPos, allowedIds, skipped, maxBlocks); }
  _clearTreeFoliageObstruction(targetBlock, signal, isPaused) { return clearTreeFoliageObstruction(this, targetBlock, signal, isPaused); }
  _digReachableTreeLog(block, signal, isPaused) { return digReachableTreeLog(this, block, signal, isPaused); }
  _mineTreeLogBlock(block, targetText, signal, isPaused) { return mineTreeLogBlock(this, block, targetText, signal, isPaused); }
  _collectNearbyItemDrops(centers, signal, isPaused) { return collectNearbyItemDrops(this, centers, signal, isPaused); }
  _chopWholeTree(seedPos, ids, targetText, skipped, signal, isPaused) { return chopWholeTree(this, seedPos, ids, targetText, skipped, signal, isPaused); }

  giveToOwner(ownerName, targetText, count, signal, opts) { return giveToOwner(this, ownerName, targetText, count, signal, opts); }
  saveWaypoint(name, position) { return saveWaypoint(this, name, position); }
  getWaypoint(name) { return getWaypoint(this, name); }
  listWaypoints() { return listWaypoints(this); }
}

export { evaluateDeathRecovery };
export default SurvivalManager;
