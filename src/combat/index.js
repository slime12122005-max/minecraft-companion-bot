import {
  evaluateThreatScore,
  isHostileThreat,
  isReachableThreat,
  pickThreat,
  resolveFocusTarget,
  resolveJevDecision,
  serializeCombatEntity,
} from './threat_assessment.js';
import {
  applyDecision,
  attack,
  emergencyWater,
  face,
  fleeFrom,
  isArrow,
  isBow,
  isCreeperIgnited,
  isSafeEscapeSpot,
  isShield,
  itemName,
  jumpCrit,
  lowerShield,
  moveClose,
  moveTo,
  pickupEmergencyWater,
  raiseShield,
  retreat,
  shootBow,
} from './micro_control.js';

const OFF_HAND_SLOT = 45;

export { evaluateThreatScore };

function hasInfinityEnchant(bow) {
  try {
    const raw = JSON.stringify(bow?.components ?? bow?.nbt ?? '', (_, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase();
    return raw.includes('infinity');
  } catch {
    return false;
  }
}

export class CombatController {
  constructor(bot, config = {}, { jev, equipment, log = () => {}, onBusyChange = null, isEating = null, bowChargeMs = 950, critJumpMs = 260 } = {}) {
    this.bot = bot;
    this.config = {
      enabled: true,
      defendOwner: true,
      radius: 16,
      retreatHealth: 8,
      crit: true,
      bow: true,
      shieldAgainstCreeper: true,
      useCausality: true,
      useThreatScore: true,
      minConfidence: 0.3,
      jevIntervalMs: config.llm?.jevIntervalMs ?? 4000,
      ...config.combat,
    };
    this.jev = jev;
    this.equipment = equipment;
    this.log = log;
    this.onBusyChange = onBusyChange;
    this.isEating = isEating;
    this.bowChargeMs = bowChargeMs;
    this.critJumpMs = critJumpMs;

    this.running = false;
    this.busy = false;
    this._ownsPathfinder = false;
    this._tick = null;
    this._jev = null;
    this.targetId = null;
    this.lastDecision = null;
    this.lastDecisionAt = 0;
    this.lastJevedAt = 0;
    this.lastJevTelemetry = null;
    this.lastThreatAssessment = null;
    this._currentMobCount = 1;
    this._currentTargetDist = 2;
    this.lastAttackAt = 0;
    this.creeperShieldUntil = 0;
    this.shieldActive = false;
    this.bowCharging = false;
    this.retreatGoal = null;
    this.lastRetreatAt = 0;
    this.fallWaterCooldownUntil = 0;
    this.pendingWaterPickupAt = 0;
    this.lastOwnerHealth = null;
    this.ownerHurtUntil = 0;
  }

  _setBusy(nextBusy) {
    if (this.busy === nextBusy) return;
    this.busy = nextBusy;
    try { this.onBusyChange?.({ busy: nextBusy }); } catch {}
  }

  _setCombatGoal(goal) {
    if (!this.bot.pathfinder) return;
    this._ownsPathfinder = true;
    this.bot.pathfinder.setGoal(goal);
  }

  _releaseCombatGoal() {
    if (!this._ownsPathfinder) return;
    this._ownsPathfinder = false;
    if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._setBusy(false);
    this.log('[combat] started');
  }

  stop() {
    this.running = false;
    this.targetId = null;
    this.lastDecision = null;
    this.lastDecisionAt = 0;
    this.retreatGoal = null;
    this.lastRetreatAt = 0;
    this.pendingWaterPickupAt = 0;
    this._lowerShield();
    if (this.bowCharging) {
      this.bowCharging = false;
      try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch {}
    }
    try { if (typeof this.bot.setControlState === 'function') this.bot.setControlState('jump', false); } catch {}
    this._releaseCombatGoal();
    this._setBusy(false);
  }

  async tick(state) {
    if (!this.running) return;
    if (this._tick) return this._tick;
    this._tick = this._runTick(state);
    try { return await this._tick; } finally { this._tick = null; }
  }

  async _runTick(state) {
    if (!this.config.enabled) return;
    const now = Date.now();

    if (this._isFallingDangerously() && now >= this.fallWaterCooldownUntil) {
      this.fallWaterCooldownUntil = now + 2000;
      this._setBusy(true);
      await this._emergencyWater();
      return;
    }

    if (this.pendingWaterPickupAt && now <= this.pendingWaterPickupAt && this.bot.entity?.onGround) {
      await this._pickupEmergencyWater();
    }

    if (this.shieldActive && now >= this.creeperShieldUntil) {
      this._lowerShield();
    }

    const owner = state?.owner ? this._ownerEntity(state.owner) : null;
    if (this.config.defendOwner && owner && typeof owner.health === 'number') {
      if (this.lastOwnerHealth !== null && owner.health < this.lastOwnerHealth) {
        this.ownerHurtUntil = now + 6000;
      }
      this.lastOwnerHealth = owner.health;
    }

    const nearby = this._nearbyMobs(owner);
    if (nearby.length === 0) {
      if (this.busy && Date.now() - this.lastRetreatAt < 6000) {
        const bufferMobs = this._nearbyMobs(owner, this.config.radius + 6);
        if (bufferMobs.length > 0) return;
      }
      this.targetId = null;
      this.lastDecision = null;
      this.lastDecisionAt = 0;
      this.lastThreatAssessment = null;
      this._lowerShield();
      this._releaseCombatGoal();
      this._setBusy(false);
      return;
    }

    const threat = this._pickThreat(nearby, state, owner, now < this.ownerHurtUntil);
    if (!threat) return;
    this.targetId = threat.id;
    this._currentMobCount = nearby.length;
    this._currentTargetDist = threat.distance;

    const health = this.bot.health ?? 20;
    const armorMit = this.equipment?.armorMitigation?.() ?? 0;
    const threatAssessment = evaluateThreatScore(nearby, { health, armorMitigation: armorMit });
    this.lastThreatAssessment = threatAssessment;

    const urgentCreeper = nearby.find(m =>
      m.name.toLowerCase().includes('creeper') &&
      (m.distance < 4.5 || now < this.creeperShieldUntil || (isCreeperIgnited(m.entity) && m.distance < 5.5))
    );
    if (urgentCreeper) {
      this._setBusy(true);
      if (isCreeperIgnited(urgentCreeper.entity)) {
        await this._fleeFrom(urgentCreeper.entity);
      } else if (this.config.shieldAgainstCreeper && this._hasShield()) {
        if (urgentCreeper.distance < 4.5) this.creeperShieldUntil = now + 2500;
        await this._face(urgentCreeper.entity);
        await this._raiseShield();
        if (urgentCreeper.distance < 2.8) await this._fleeFrom(urgentCreeper.entity);
      } else {
        await this._fleeFrom(urgentCreeper.entity);
      }
      return;
    }

    if (this.bot.entity?.isInWater && typeof this.bot.oxygenLevel === 'number' && this.bot.oxygenLevel <= 8) {
      this._setBusy(true);
      this._releaseCombatGoal();
      return;
    }

    const closeCount = nearby.filter(m => m.distance <= 5).length;
    const isWarden = threat.name.toLowerCase().includes('warden');
    const swarmed = closeCount >= 3 && health <= 12;
    if (health <= this.config.retreatHealth || isWarden || swarmed) {
      this._setBusy(true);
      if (this._hasShield() && (swarmed || isWarden)) await this._raiseShield();
      await this._retreat(owner, threat.entity);
      return;
    }

    this._triggerAsyncPlanner(state, nearby, threat, owner, health, now, closeCount, threatAssessment);

    const jevInterval = this.config.jevIntervalMs ?? 4000;
    const hasFreshDecision = this.lastDecision && (now - this.lastDecisionAt <= Math.max(3000, jevInterval * 2));
    const decision = hasFreshDecision
      ? this._resolveJevDecision(this.lastDecision, nearby, threat, owner, health)
      : this._localReflexDecision(threat, nearby, health, threatAssessment);

    if (decision.action !== 'idle') this._setBusy(true);
    await this._applyDecision(decision, threat, owner);
  }

  _resolveJevDecision(raw, nearby, threat, owner, health) {
    return resolveJevDecision(this, raw, nearby, threat, owner, health);
  }

  _resolveFocusTarget(focus, nearby, owner) {
    return resolveFocusTarget(focus, nearby, owner);
  }

  _triggerAsyncPlanner(state, nearby, threat, owner, health, now, closeCount = 1, threatAssessment = null) {
    if (!this.jev?.chooseCombat || this.config.useCausality === false) return;
    const jevInterval = this.config.jevIntervalMs ?? 4000;
    if (now - this.lastJevedAt < jevInterval || this._jev) return;

    const isComplex = nearby.length >= 2 || health <= 12 || (this._canUseBow() && threat.distance > 4) || jevInterval === 0 || this.config.alwaysUseJev === true;
    if (!isComplex) return;

    this.lastJevedAt = now;
    const jevState = {
      health,
      food: this.bot.food ?? 20,
      saturation: this.bot.saturation ?? 0,
      inWater: Boolean(this.bot.entity?.isInWater),
      closeCount,
      threatScore: threatAssessment?.score ?? null,
      threatPosture: threatAssessment?.posture ?? null,
      inventory: this._inventorySummary(),
      equipped: this._equippedSummary(),
      nearby: nearby.map(m => ({ id: m.id, name: m.name, type: m.type, distance: m.distance, position: m.position })),
      target: { ...serializeCombatEntity(threat.entity), distance: threat.distance },
      owner: serializeCombatEntity(owner),
      canBow: this._canUseBow(),
      canCrit: Boolean(this.config.crit && !this.bot.entity?.isInWater),
      shield: this._hasShield(),
    };

    this._jev = Promise.resolve(this.jev.chooseCombat(jevState))
      .then(decision => {
        if (decision && typeof decision === 'object') {
          this.lastDecision = decision;
          this.lastDecisionAt = Date.now();
          this.lastJevTelemetry = {
            action: decision.action ?? null,
            confidence: decision.confidence ?? null,
            focus: decision.focus ?? null,
            danger: decision.danger ?? null,
            urgentRetreat: decision.urgentRetreat ?? null,
            probabilities: decision.probabilities ?? null,
            at: this.lastDecisionAt,
          };
          if (decision.confidence != null || decision.danger != null) {
            const confStr = decision.confidence != null ? `${Math.round(decision.confidence * 100)}%` : '?';
            const dangerStr = decision.danger != null ? decision.danger.toFixed(1) : '?';
            this.log(`Jev: ${decision.action} (${confStr}, danger=${dangerStr})`);
          }
        }
      })
      .catch(() => {})
      .finally(() => { this._jev = null; });
  }

  _canUseBow() {
    if (!this.config.bow) return false;
    const bow = this._findInventoryItem(isBow);
    if (!bow) return false;
    if (hasInfinityEnchant(bow)) return true;
    return !!this._findInventoryItem(isArrow);
  }

  _localReflexDecision(threat, nearby = [], health = 20, assessment = null) {
    if (
      this.config.useThreatScore !== false &&
      assessment?.posture === 'retreat' &&
      (nearby.length >= 2 || health <= 12)
    ) {
      return { action: 'retreat', targetId: threat.id };
    }
    if (this._canUseBow() && threat.distance > 6 && threat.distance < 20) {
      return { action: 'bow', targetId: threat.id };
    }
    return { action: 'melee', targetId: threat.id };
  }

  _isHostileThreat(e, owner) { return isHostileThreat(this.bot, e, owner); }
  _isReachableThreat(e, owner) { return isReachableThreat(this.bot, e, owner, this.config.maxVerticalDistance ?? 5); }

  _nearbyMobs(owner = null, radiusOverride = null) {
    const radius = radiusOverride ?? this.config.radius;
    const pos = this.bot.entity?.position;
    if (!pos) return [];
    return Object.values(this.bot.entities ?? {})
      .filter(e => this._isHostileThreat(e, owner) && pos.distanceTo(e.position) <= radius && this._isReachableThreat(e, owner))
      .map(e => ({ id: e.id, name: e.name ?? '', type: e.type, distance: pos.distanceTo(e.position), position: e.position, entity: e }))
      .sort((a, b) => a.distance - b.distance);
  }

  _pickThreat(mobs, state, owner = null, ownerHurtRecently = false) {
    return pickThreat(this.bot, mobs, state, owner, ownerHurtRecently);
  }

  _ownerEntity(ownerName) {
    if (!ownerName) return null;
    const playerEntity = this.bot.players?.[ownerName]?.entity;
    if (playerEntity?.position) return playerEntity;
    return this._entityByName(ownerName);
  }

  _entityByName(name) {
    if (!name) return null;
    return Object.values(this.bot.entities ?? {}).find(e => e && (e.username === name || e.name === name) && e.position) ?? null;
  }

  _applyDecision(decision, threat, owner) { return applyDecision(this, decision, threat, owner); }

  _face(entity) { return face(this, entity); }
  _raiseShield() { return raiseShield(this); }
  _lowerShield() { return lowerShield(this); }
  _attack(target, opts) { return attack(this, target, opts); }
  _jumpCrit(target, opts) { return jumpCrit(this, target, opts); }
  _shootBow(target, bowArg) { return shootBow(this, target, bowArg); }
  _moveClose(target) { return moveClose(this, target); }
  _moveTo(entity, range) { return moveTo(this, entity, range); }
  _isSafeEscapeSpot(point) { return isSafeEscapeSpot(this, point); }
  _fleeFrom(threat) { return fleeFrom(this, threat); }
  _retreat(owner, threat) { return retreat(this, owner, threat); }
  _emergencyWater() { return emergencyWater(this); }
  _pickupEmergencyWater() { return pickupEmergencyWater(this); }

  _canCrit() {
    const e = this.bot.entity;
    return !e.onGround && e.velocity && e.velocity.y < 0;
  }

  _isFallingDangerously() {
    const e = this.bot.entity;
    return !!e && !e.onGround && e.velocity && e.velocity.y < -0.5;
  }

  _hasShield() {
    const slots = this.bot.inventory?.slots ?? [];
    return slots.some(s => s && isShield(itemName(s))) || !!this._findInventoryItem(isShield);
  }

  _findInventoryItem(pred) {
    return (this.bot.inventory?.items?.() ?? []).find(i => i && pred(itemName(i))) ?? null;
  }

  _inventorySummary() {
    return (this.bot.inventory?.items?.() ?? []).slice(0, 12).map(i => ({ name: i.name, count: i.count }));
  }

  _equippedSummary() {
    const slots = this.bot.inventory?.slots ?? [];
    return slots.filter(s => s).map(s => ({ name: s.name, slot: s.slot }));
  }
}

export default CombatController;
