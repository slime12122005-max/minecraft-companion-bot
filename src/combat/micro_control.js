import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { HAZARD_BLOCKS, RANGED_MOBS } from './threat_assessment.js';

const OFF_HAND_SLOT = 45;

export function itemName(item) { return item?.name?.toLowerCase() ?? ''; }
export function isShield(name) { return name === 'shield'; }
export function isBow(name) { return name === 'bow' || name.endsWith('_bow'); }
export function isArrow(name) { return name === 'arrow' || name.endsWith('_arrow'); }

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

export async function face(ctx, entity) {
  if (!entity?.position) return;
  try {
    const look = entity.position.offset(0, entity.height ?? 1.62, 0);
    if (ctx.humanizer?.smoothLookAt) {
      await ctx.humanizer.smoothLookAt(look, { steps: 3, jitterRad: 0.015 });
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
    if (typeof ctx.equipment?.equipWeaponForSituation === 'function') {
      await ctx.equipment.equipWeaponForSituation({ target, mobCount, distance, opponentBlocking });
    } else if (ctx.equipment?.equipMelee) {
      await ctx.equipment.equipMelee();
    }
    if (isFriendlyInCursor(ctx.bot, target, owner)) return;
    const finalCooldownMs = getAttackCooldownMs(ctx.bot.heldItem);
    if (now - ctx.lastAttackAt < finalCooldownMs + jitterMs) return;
    ctx.lastAttackAt = now;
    if (typeof ctx.bot.attack === 'function') {
      await ctx.bot.attack(target);
      ctx.humanizer?.triggerWTap?.({ inWater: Boolean(ctx.bot.entity?.isInWater) });
    }
  } catch {}
}

export async function jumpCrit(ctx, target, opts = {}) {
  if (ctx.isEating?.()) return;
  let jumped = false;
  try {
    if (typeof ctx.bot.setControlState === 'function') {
      jumped = true;
      ctx.bot.setControlState('jump', true);
      await new Promise(r => setTimeout(r, ctx.critJumpMs));
      ctx.bot.setControlState('jump', false);
      jumped = false;
    }
    if (!ctx.running || ctx.isEating?.()) return;
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
  if (ctx.bot.pathfinder && target?.position) {
    ctx.retreatGoal = null;
    try {
      ctx._setCombatGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 3));
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
    if (ctx.bot.entity.position.distanceTo(owner.position) > 3) {
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
    if (distance < 4.5) {
      if (itemName(target).includes('creeper')) {
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
      } else if (ctx.humanizer?.maybeCombatStrafe && ctx.bot.entity?.position) {
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
          distance,
          inWater: Boolean(ctx.bot.entity?.isInWater),
          isCreeper: false,
          onGround: Boolean(ctx.bot.entity?.onGround),
          safeLeft,
          safeRight,
        });
      }
      ctx._lowerShield();
      const allowCrit = ctx.config.crit && !ctx.bot.entity?.isInWater;
      const cooldownMs = getAttackCooldownMs(ctx.bot.heldItem);
      if (allowCrit) {
        if (ctx._canCrit()) await ctx._attack(target, { owner });
        else if (ctx.bot.entity?.onGround && Date.now() - ctx.lastAttackAt >= cooldownMs) await ctx._jumpCrit(target, { owner });
      } else {
        await ctx._attack(target, { owner });
      }
    } else if (distance <= ctx.config.radius) {
      const isRangedEnemy = RANGED_MOBS.some(r => itemName(target).includes(r));
      if (isRangedEnemy && ctx._hasShield()) {
        ctx.creeperShieldUntil = Date.now() + 1200;
        await ctx._raiseShield();
      } else {
        ctx._lowerShield();
      }
      await ctx._moveClose(target);
    }
    return;
  }

  ctx._releaseCombatGoal();
  ctx._setBusy(false);
}
