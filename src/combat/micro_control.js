import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { HAZARD_BLOCKS, RANGED_MOBS } from './threat_assessment.js';

const OFF_HAND_SLOT = 45;

export function itemName(item) { return item?.name?.toLowerCase() ?? ''; }
export function isShield(name) { return name === 'shield'; }
export function isBow(name) { return name === 'bow' || name.endsWith('_bow'); }
export function isArrow(name) { return name === 'arrow' || name.endsWith('_arrow'); }

export function isNearFarmland(bot) {
  const pos = bot?.entity?.position;
  if (!pos || typeof bot.blockAt !== 'function') return false;
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [0, -1]) {
      const checkPos = typeof pos.offset === 'function'
        ? pos.offset(dx, dy, dz)
        : new Vec3(pos.x + dx, pos.y + dy, pos.z + dz);
      if (itemName(bot.blockAt(checkPos)) === 'farmland') return true;
    }
  }
  return false;
}

export function getAttackCooldownMs(item) {
  const name = itemName(item);
  let speed = 4.0;
  if (name.endsWith('_sword')) speed = 1.6;
  else if (name === 'wooden_axe' || name === 'stone_axe') speed = 0.8;
  else if (name === 'iron_axe') speed = 0.9;
  else if (name.endsWith('_axe')) speed = 1.0;
  else if (name === 'trident') speed = 1.1;
  else if (name === 'mace') speed = 0.6;
  else if (name.endsWith('_pickaxe')) speed = 1.2;
  else if (name.endsWith('_shovel')) speed = 1.0;
  return Math.ceil(20 / speed) * 50;
}

export function isCreeperIgnited(entity) {
  return Boolean(
    entity?.ignited === true ||
    entity?.metadata?.[16] === 1 ||
    entity?.metadata?.[18] === true
  );
}

export function wouldKnockCreeperTowardOwner(botPos, creeperPos, ownerPos) {
  if (!botPos || !creeperPos || !ownerPos) return false;
  const ux = creeperPos.x - botPos.x;
  const uz = creeperPos.z - botPos.z;
  const vx = ownerPos.x - creeperPos.x;
  const vz = ownerPos.z - creeperPos.z;
  if (Math.hypot(vx, vz) >= 6.0) return false;
  return ux * vx + uz * vz > 0;
}

export function isFriendlyInCursor(bot, target, owner = null) {
  if (typeof bot?.entityAtCursor !== 'function') return false;
  const hit = bot.entityAtCursor(3.5);
  if (!hit || hit === target || (target?.id != null && hit.id === target.id)) return false;
  if (owner && (hit === owner || (owner.id != null && hit.id === owner.id) || (owner.username && hit.username === owner.username))) {
    return true;
  }
  return hit.type === 'player';
}

function resolveAimHeight(entity) {
  const rawH = typeof entity?.height === 'number' && entity.height > 0 ? entity.height : 1.8;
  return Math.max(0.35, Math.min(1.5, rawH * 0.75));
}

export async function face(ctx, entity) {
  if (!entity?.position) return;
  try {
    const look = entity.position.offset(0, resolveAimHeight(entity), 0);
    if (ctx.humanizer?.smoothLookAt) {
      const cfgStepMs = ctx.humanizer.config?.lookStepMs ?? 22;
      await ctx.humanizer.smoothLookAt(look, {
        steps: 3,
        stepMs: Math.min(8, cfgStepMs),
        jitterRad: 0.008,
      });
    } else if (typeof ctx.bot.lookAt === 'function') {
      await ctx.bot.lookAt(look, false);
    }
  } catch {}
}

export async function raiseShield(ctx) {
  const offHand = ctx.bot.inventory?.slots?.[OFF_HAND_SLOT];
  if (!offHand || !isShield(itemName(offHand))) {
    const shield = ctx._findInventoryItem(isShield);
    if (!shield) return;
    try { await ctx.bot.equip(shield, 'off-hand'); } catch { return; }
  }
  try {
    if (!ctx.shieldActive && typeof ctx.bot.activateItem === 'function') {
      ctx.bot.activateItem(true);
      ctx.shieldActive = true;
    }
  } catch {}
}

export function lowerShield(ctx) {
  if (!ctx.shieldActive) return;
  ctx.shieldActive = false;
  try {
    if (typeof ctx.bot.deactivateItem === 'function') ctx.bot.deactivateItem();
  } catch {}
}

async function ensureMeleeReady(ctx, {
  target = null,
  mobCount = ctx._currentMobCount ?? 1,
  distance = ctx._currentTargetDist ?? 2,
  opponentBlocking = false,
} = {}) {
  const prevHeldName = itemName(ctx.bot.heldItem);
  try {
    if (typeof ctx.equipment?.equipWeaponForSituation === 'function') {
      await ctx.equipment.equipWeaponForSituation({ target, mobCount, distance, opponentBlocking });
    } else if (ctx.equipment?.equipMelee) {
      await ctx.equipment.equipMelee();
    }
  } catch {}
  const nextHeldName = itemName(ctx.bot.heldItem);
  if (ctx.bot._client && nextHeldName && nextHeldName !== prevHeldName) {
    ctx.lastWeaponEquipAt = Date.now();
    return true;
  }
  return false;
}

export async function attack(ctx, target, { mobCount = ctx._currentMobCount ?? 1, distance = ctx._currentTargetDist ?? 2, owner = null } = {}) {
  if (ctx.isEating?.()) return;
  const now = Date.now();
  const cooldownMs = getAttackCooldownMs(ctx.bot.heldItem);
  const jitterMs = ctx.humanizer?.getAttackJitterMs?.() ?? 0;
  if (now - ctx.lastAttackAt < cooldownMs + jitterMs) return;
  const opponentBlocking = Boolean(
    target?.blocking ||
    (typeof target?.metadata?.[8] === 'number' && (target.metadata[8] & 0x01) !== 0) ||
    itemName(target?.heldItem) === 'shield'
  );
  try {
    await ensureMeleeReady(ctx, { target, mobCount, distance, opponentBlocking });
    if (isFriendlyInCursor(ctx.bot, target, owner)) return;
    const finalCooldownMs = getAttackCooldownMs(ctx.bot.heldItem);
    if (now - ctx.lastAttackAt < finalCooldownMs + jitterMs) return;
    if (ctx.bot._client && now - (ctx.lastWeaponEquipAt ?? 0) < Math.min(450, finalCooldownMs * 0.7)) {
      return;
    }
    ctx.lastAttackAt = now;
    if (typeof ctx.bot.attack === 'function') {
      await ctx.bot.attack(target);
      ctx.humanizer?.triggerWTap?.({ inWater: Boolean(ctx.bot.entity?.isInWater) });
    }
  } catch {}
}

export async function jumpCrit(ctx, target, opts = {}) {
  if (ctx.isEating?.()) return;
  if (isNearFarmland(ctx.bot)) {
    await ctx._attack(target, opts);
    return;
  }
  let jumped = false;
  try {
    if (typeof ctx.bot.setControlState === 'function') {
      const holdMs = Math.min(60, Math.max(0, ctx.critJumpMs));
      jumped = true;
      ctx.bot.setControlState('jump', true);
      if (holdMs > 0) await new Promise(r => setTimeout(r, holdMs));
      ctx.bot.setControlState('jump', false);
      jumped = false;

      let remaining = Math.max(0, ctx.critJumpMs - holdMs);
      while (remaining > 0 && ctx.running && !ctx.isEating?.() && !ctx._canCrit()) {
        const step = Math.min(25, remaining);
        await new Promise(r => setTimeout(r, step));
        remaining -= step;
      }
    }
    if (!ctx.running || ctx.isEating?.()) return;
    if (ctx.bot._client && target?.position && typeof ctx.bot.lookAt === 'function') {
      try {
        await ctx.bot.lookAt(target.position.offset(0, resolveAimHeight(target), 0), true);
      } catch {}
    }
    await ctx._attack(target, opts);
  } catch {
  } finally {
    if (jumped && typeof ctx.bot.setControlState === 'function') {
      try { ctx.bot.setControlState('jump', false); } catch {}
    }
  }
}

export async function shootBow(ctx, target, bowArg = null) {
  if (ctx.isEating?.()) return;
  const bow = bowArg ?? ctx._findInventoryItem(isBow);
  if (!bow) return;
  try { await ctx.bot.equip(bow, 'hand'); } catch { return; }
  const pos = target.position;
  const dist = ctx.bot.entity.position.distanceTo(pos);
  const aim = pos.offset(0, target.height ?? 1.62, 0).offset(0, dist * 0.06, 0);
  try {
    if (ctx.humanizer?.smoothLookAt) {
      await ctx.humanizer.smoothLookAt(aim, { steps: 3, jitterRad: 0.01 });
    } else if (typeof ctx.bot.lookAt === 'function') {
      await ctx.bot.lookAt(aim, false);
    }
    if (typeof ctx.bot.activateItem === 'function') {
      ctx.bowCharging = true;
      ctx.bot.activateItem(false);
      await new Promise(r => setTimeout(r, ctx.bowChargeMs));
      if (ctx.bowCharging) {
        ctx.bowCharging = false;
        if (typeof ctx.bot.deactivateItem === 'function') ctx.bot.deactivateItem();
      }
    }
  } catch {}
}

export async function moveClose(ctx, target) {
  if (!ctx.isEating?.() && target?.position && ctx.bot.entity?.position) {
    const dist = ctx.bot.entity.position.distanceTo(target.position);
    if (dist <= 7) {
      await ensureMeleeReady(ctx, {
        target,
        mobCount: ctx._currentMobCount ?? 1,
        distance: dist,
        opponentBlocking: false,
      });
    }
  }
  if (ctx.bot.pathfinder && target?.position) {
    ctx.retreatGoal = null;
    if (ctx._ownsPathfinder && ctx._followTargetId != null && target.id != null && ctx._followTargetId === target.id) {
      return;
    }
    try {
      ctx._setCombatGoal(new goals.GoalFollow(target, 1.9), true, target.id ?? null);
    } catch {}
  }
}

export async function moveTo(ctx, entity, range = 2) {
  if (ctx.bot.pathfinder && entity?.position) {
    ctx.retreatGoal = null;
    try {
      ctx._setCombatGoal(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, range));
    } catch {}
  }
}

export function isSafeEscapeSpot(ctx, point) {
  if (typeof ctx.bot.blockAt !== 'function') return true;
  const feet = ctx.bot.blockAt(point);
  if (!feet) return true;
  if (HAZARD_BLOCKS.has(itemName(feet))) return false;
  const below = ctx.bot.blockAt(point.offset(0, -1, 0));
  if (below && HAZARD_BLOCKS.has(itemName(below))) return false;
  if (below && itemName(below) === 'air') {
    let airDepth = 1;
    for (let dy = -2; dy >= -4; dy--) {
      const b = ctx.bot.blockAt(point.offset(0, dy, 0));
      if (b && itemName(b) === 'air') airDepth++;
      else break;
    }
    if (airDepth >= 4) return false;
  }
  return true;
}

export async function fleeFrom(ctx, threat) {
  ctx.lastRetreatAt = Date.now();
  if (!ctx.bot.pathfinder || !threat?.position || !ctx.bot.entity?.position) return;
  const pos = ctx.bot.entity.position;
  const dx = pos.x - threat.position.x;
  const dz = pos.z - threat.position.z;
  const len = Math.hypot(dx, dz) || 1;
  const baseAngle = Math.atan2(dz / len, dx / len);
  const angles = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];

  let chosen = null;
  for (const delta of angles) {
    const a = baseAngle + delta;
    const cand = pos.offset(Math.cos(a) * 8, 0, Math.sin(a) * 8);
    if (ctx._isSafeEscapeSpot(cand)) {
      chosen = cand;
      break;
    }
  }
  const away = chosen ?? pos.offset((dx / len) * 8, 0, (dz / len) * 8);
  try {
    ctx._setCombatGoal(new goals.GoalNear(away.x, away.y, away.z, 2));
    ctx.retreatGoal = away;
  } catch {}
}

export async function retreat(ctx, owner, threat) {
  ctx.lastRetreatAt = Date.now();
  if (ctx.config.defendOwner && owner?.position && ctx.bot.entity?.position) {
    const distToOwner = ctx.bot.entity.position.distanceTo(owner.position);
    const ownerSafer = !threat?.position ||
      owner.position.distanceTo(threat.position) > ctx.bot.entity.position.distanceTo(threat.position) + 1.5;
    if (distToOwner > 3 && ownerSafer) {
      await ctx._moveTo(owner, 2);
      return;
    }
  }
  await ctx._fleeFrom(threat);
}

export async function emergencyWater(ctx) {
  const bucket = ctx._findInventoryItem(name => name.includes('water_bucket'));
  if (!bucket) return;
  try { await ctx.bot.equip(bucket, 'hand'); } catch { return; }
  try {
    if (typeof ctx.bot.look === 'function') {
      await ctx.bot.look(ctx.bot.entity?.yaw ?? 0, -Math.PI / 2, true);
    }
    if (typeof ctx.bot.activateItem === 'function') {
      ctx.bot.activateItem(false);
      ctx.pendingWaterPickupAt = Date.now() + 4000;
      return;
    }
    if (typeof ctx.bot.placeBlock === 'function' && ctx.bot.entity?.position) {
      const below = ctx.bot.blockAt(ctx.bot.entity.position.offset(0, -1, 0));
      if (below) {
        await ctx.bot.placeBlock(below, new Vec3(0, 1, 0));
        ctx.pendingWaterPickupAt = Date.now() + 4000;
      }
    }
  } catch {}
}

export async function pickupEmergencyWater(ctx) {
  ctx.pendingWaterPickupAt = 0;
  const bucket = ctx._findInventoryItem(name => name === 'bucket');
  if (!bucket || !ctx.bot.entity?.position) return;
  const feetBlock = ctx.bot.blockAt?.(ctx.bot.entity.position);
  if (!feetBlock || !itemName(feetBlock).includes('water')) return;
  try {
    await ctx.bot.equip(bucket, 'hand');
    if (typeof ctx.bot.look === 'function') {
      await ctx.bot.look(ctx.bot.entity?.yaw ?? 0, -Math.PI / 2, true);
    }
    ctx.bot.activateItem?.(false);
  } catch {}
}

export async function applyDecision(ctx, decision, threat, owner) {
  const action = decision?.action ?? 'idle';
  const targetId = decision?.targetId ?? threat?.id;
  const target = (targetId != null ? ctx.bot.entities?.[targetId] : null) ?? threat?.entity;
  if (!target || !target.position) {
    ctx._releaseCombatGoal();
    ctx._setBusy(false);
    return;
  }

  const distance = ctx.bot.entity.position.distanceTo(target.position);
  if (distance > ctx.config.radius) {
    ctx._releaseCombatGoal();
    ctx._setBusy(false);
    return;
  }

  if (action === 'retreat' || action === 'flee') {
    await ctx._retreat(owner, target);
    return;
  }
  if (action === 'idle') {
    ctx._lowerShield();
    ctx._releaseCombatGoal();
    ctx._setBusy(false);
    return;
  }

  await ctx._face(target);

  if (action === 'shield' || (ctx.config.shieldAgainstCreeper && itemName(target).includes('creeper') && distance < 4.5)) {
    if (ctx._hasShield()) {
      ctx.creeperShieldUntil = Date.now() + 2500;
      await ctx._raiseShield();
    } else {
      await ctx._fleeFrom(target);
    }
    return;
  }

  const bow = ctx._findInventoryItem(isBow);
  if (action === 'bow' && ctx._canUseBow() && bow && distance > 4 && distance < 24) {
    ctx._lowerShield();
    await ctx._shootBow(target, bow);
    return;
  }

  if (action === 'attack' || action === 'melee' || action === 'bow') {
    const isCreeper = itemName(target).includes('creeper');
    if (distance < 4.5 && isCreeper) {
      if (isCreeperIgnited(target)) {
        await ctx._fleeFrom(target);
        return;
      }
      if (
        owner?.position &&
        ctx.bot.entity?.position &&
        wouldKnockCreeperTowardOwner(ctx.bot.entity.position, target.position, owner.position)
      ) {
        const dx = target.position.x - ctx.bot.entity.position.x;
        const dz = target.position.z - ctx.bot.entity.position.z;
        const len = Math.hypot(dx, dz) || 1;
        const sideCandidates = [
          target.position.offset((-dz / len) * 3, 0, (dx / len) * 3),
          target.position.offset((dz / len) * 3, 0, (-dx / len) * 3),
        ];
        const safeSide = sideCandidates.find(
          cand => !wouldKnockCreeperTowardOwner(cand, target.position, owner.position) && ctx._isSafeEscapeSpot(cand)
        ) ?? sideCandidates[0];
        if (ctx.bot.pathfinder && safeSide) {
          try {
            ctx._setCombatGoal(new goals.GoalNear(safeSide.x, safeSide.y, safeSide.z, 1));
          } catch {}
        }
        return;
      }
    }

    const holdPos = ctx.shelterHoldPos ?? null;
    const isRangedEnemy = RANGED_MOBS.some(r => itemName(target).includes(r));
    if (holdPos) {
      ctx._lowerShield();
      if (ctx.bot.entity?.position && ctx.bot.pathfinder) {
        const holdDist = ctx.bot.entity.position.distanceTo(holdPos);
        if (holdDist > 0.75) {
          try {
            ctx._setCombatGoal(new goals.GoalNear(holdPos.x, holdPos.y, holdPos.z, 0.4));
          } catch {}
        } else if (ctx._ownsPathfinder && holdDist <= 0.65) {
          ctx._releaseCombatGoal();
        }
      }
    } else if (distance > 2.65) {
      if (distance >= 4.5 && isRangedEnemy && ctx._hasShield()) {
        ctx.creeperShieldUntil = Date.now() + 1200;
        await ctx._raiseShield();
      } else {
        ctx._lowerShield();
      }
      await ctx._moveClose(target);
    } else {
      ctx._lowerShield();
      if (ctx._followTargetId != null && distance <= 2.2) {
        ctx._releaseCombatGoal();
      }
    }

    if (!holdPos && !isCreeper && (distance <= 3.0 || (isRangedEnemy && distance <= 14.0)) && ctx.humanizer?.maybeCombatStrafe && ctx.bot.entity?.position) {
      const bp = ctx.bot.entity.position;
      const dx = target.position.x - bp.x;
      const dz = target.position.z - bp.z;
      const len = Math.hypot(dx, dz) || 1;
      const rx = -dz / len;
      const rz = dx / len;
      const safeRight = typeof bp.offset === 'function'
        ? ctx._isSafeEscapeSpot(bp.offset(rx * 1.8, 0, rz * 1.8))
        : false;
      const safeLeft = typeof bp.offset === 'function'
        ? ctx._isSafeEscapeSpot(bp.offset(-rx * 1.8, 0, -rz * 1.8))
        : false;
      ctx.humanizer.maybeCombatStrafe({
        distance: Math.min(distance, 2.8),
        inWater: Boolean(ctx.bot.entity?.isInWater),
        isCreeper: false,
        onGround: Boolean(ctx.bot.entity?.onGround),
        safeLeft,
        safeRight,
      });
    }

    const maxSwingDist = ctx.config.attackRange ?? (ctx.bot._client ? 3.25 : 4.5);
    const effectiveSwingDist = holdPos ? Math.max(maxSwingDist, 3.4) : maxSwingDist;
    if (distance <= effectiveSwingDist) {
      ctx._lowerShield();
      const preferGroundedSweep = (ctx._currentMobCount ?? 1) >= 2 && itemName(ctx.bot.heldItem).endsWith('_sword');
      const allowCrit = !holdPos && ctx.config.crit && !ctx.bot.entity?.isInWater && !isNearFarmland(ctx.bot) && !preferGroundedSweep && distance <= 3.15;
      const cooldownMs = getAttackCooldownMs(ctx.bot.heldItem);
      if (allowCrit) {
        if (ctx._canCrit()) await ctx._attack(target, { owner });
        else if (ctx.bot.entity?.onGround && Date.now() - ctx.lastAttackAt >= cooldownMs) await ctx._jumpCrit(target, { owner });
      } else {
        await ctx._attack(target, { owner });
      }
    }
    return;
  }

  ctx._releaseCombatGoal();
  ctx._setBusy(false);
}
