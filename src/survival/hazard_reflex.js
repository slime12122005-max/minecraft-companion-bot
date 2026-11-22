import { raceTimeout } from './constants.js';

const FALLING_SUFFOCATION_BLOCKS = new Set(['sand', 'red_sand', 'gravel']);
const SHOVEL_PREFERRED_BLOCKS = new Set(['sand', 'red_sand', 'gravel', 'dirt']);
const NON_SUFFOCATING_KEYWORDS = [
  'air', 'water', 'lava', 'glass', 'leaves', 'ice', 'slime_block', 'honey_block',
  'piston', 'fence', 'door', 'trapdoor', 'slab', 'stairs', 'wall', 'pane', 'bars',
  'spawner', 'beacon', 'tnt', 'bed', 'web', 'vine', 'carpet', 'torch', 'sign',
  'banner', 'chest', 'lantern', 'chain', 'ladder', 'scaffolding', 'flower',
  'grass', 'fern', 'sapling', 'wheat', 'carrot', 'potato', 'beetroot', 'rail',
  'button', 'lever', 'pressure_plate', 'redstone',
];

export function isSuffocatingBlock(block) {
  if (!block || !block.name || block.diggable === false) return false;
  const name = String(block.name).toLowerCase();
  if (FALLING_SUFFOCATION_BLOCKS.has(name) || name.endsWith('_concrete_powder')) {
    return true;
  }
  if (block.boundingBox !== 'block') return false;
  return !NON_SUFFOCATING_KEYWORDS.some(k => name.includes(k));
}

async function runHazardHandAction(ctx, fn) {
  ctx.hazardBusy = true;
  try {
    return await fn();
  } finally {
    ctx.hazardBusy = false;
  }
}

export function isOnFire(bot) {
  const flag = bot.entity?.metadata?.[0];
  return typeof flag === 'number' && (flag & 0x01) !== 0;
}

export function isInLava(bot) {
  if (bot.entity?.isInLava) return true;
  const pos = bot.entity?.position;
  if (!pos || typeof bot.blockAt !== 'function') return false;
  const feet = bot.blockAt(pos);
  return !!feet?.name?.toLowerCase().includes('lava');
}

export function isNether(bot) {
  const dim = String(bot.game?.dimension ?? '').toLowerCase();
  return dim.includes('nether');
}

export async function handleHazards(ctx) {
  const entity = ctx.bot.entity;
  if (!entity?.position) return false;
  const now = Date.now();
  let acted = false;

  const inLava = ctx._isInLava();
  const onFire = ctx._isOnFire();
  const oxygen = ctx.bot.oxygenLevel;
  const drowning = typeof oxygen === 'number' && oxygen <= 10;

  // 1. Drowning or stuck in lava -> swim / jump up
  if (drowning || inLava) {
    if (typeof ctx.bot.setControlState === 'function') {
      ctx.bot.setControlState('jump', true);
      ctx._hazardJumpActive = true;
    }
    acted = true;
  } else if (ctx._hazardJumpActive) {
    ctx._hazardJumpActive = false;
    if (typeof ctx.bot.setControlState === 'function') {
      ctx.bot.setControlState('jump', false);
    }
  }

  // 2. Extinguish fire / solidify lava with water bucket (outside Nether)
  if ((inLava || onFire) && !entity.isInWater && !ctx._isNether() && now - ctx.lastWaterExtinguishAt >= 4000) {
    const items = ctx.bot.inventory?.items?.() ?? [];
    const bucket = items.find(i => i?.name?.toLowerCase() === 'water_bucket');
    if (bucket && typeof ctx.bot.equip === 'function' && typeof ctx.bot.activateItem === 'function') {
      ctx.lastWaterExtinguishAt = now;
      await runHazardHandAction(ctx, async () => {
        try {
          await ctx.bot.equip(bucket, 'hand');
          if (typeof ctx.bot.look === 'function') {
            await ctx.bot.look(entity.yaw ?? 0, -Math.PI / 2, true);
          }
          ctx.bot.activateItem(false);
          ctx.pendingWaterPickupAt = now + 2000;
          ctx.log('💧 Đã đổ nước dập lửa/lava');
          acted = true;
        } catch {}
      });
    }
  } else if (
    ctx.pendingWaterPickupAt &&
    now <= ctx.pendingWaterPickupAt &&
    !inLava &&
    !onFire
  ) {
    ctx.pendingWaterPickupAt = 0;
    const items = ctx.bot.inventory?.items?.() ?? [];
    const emptyBucket = items.find(i => i?.name?.toLowerCase() === 'bucket');
    const feet = ctx.bot.blockAt?.(entity.position);
    if (emptyBucket && feet?.name?.toLowerCase().includes('water') && typeof ctx.bot.activateItem === 'function') {
      await runHazardHandAction(ctx, async () => {
        try {
          await ctx.bot.equip(emptyBucket, 'hand');
          if (typeof ctx.bot.look === 'function') {
            await ctx.bot.look(entity.yaw ?? 0, -Math.PI / 2, true);
          }
          ctx.bot.activateItem(false);
        } catch {}
      });
    }
  }

  // 3. Escape cobweb
  if (entity.isInWeb && now - ctx.lastWebDigAt >= 1500 && typeof ctx.bot.dig === 'function') {
    const feet = ctx.bot.blockAt?.(entity.position);
    const head = ctx.bot.blockAt?.(entity.position.offset(0, 1, 0));
    const web = [feet, head].find(b => b?.name?.toLowerCase().includes('web'));
    if (web) {
      ctx.lastWebDigAt = now;
      await runHazardHandAction(ctx, async () => {
        try {
          await ctx.bot.dig(web);
          acted = true;
        } catch {}
      });
    }
  }

  // 4. Escape suffocation (e.g. falling sand/gravel covering head)
  if (!ctx.bot.isSleeping && typeof ctx.bot.dig === 'function' && now - (ctx.lastSuffocationDigAt ?? 0) >= 800) {
    const headPos = typeof entity.position.offset === 'function'
      ? entity.position.offset(0, 1, 0)
      : { x: entity.position.x, y: entity.position.y + 1, z: entity.position.z };
    const head = ctx.bot.blockAt?.(headPos);
    if (isSuffocatingBlock(head)) {
      ctx.lastSuffocationDigAt = now;
      await runHazardHandAction(ctx, async () => {
        try {
          if (ctx.bot.targetDigBlock && ctx.bot.targetDigBlock !== head) {
            try { ctx.bot.stopDigging?.(); } catch {}
          }
          const headName = String(head.name).toLowerCase();
          if (SHOVEL_PREFERRED_BLOCKS.has(headName) || headName.endsWith('_concrete_powder')) {
            if (typeof ctx.bot.equip === 'function') {
              const shovel = (ctx.bot.inventory?.items?.() ?? []).find(i => i?.name?.toLowerCase().endsWith('_shovel'));
              if (shovel) {
                try { await ctx.bot.equip(shovel, 'hand'); } catch {}
              }
            }
          } else if (ctx.bot.tool?.equipForBlock) {
            try { await ctx.bot.tool.equipForBlock(head); } catch {}
          }
          await raceTimeout(ctx.bot.dig(head), 4000, () => {
            try { ctx.bot.stopDigging?.(); } catch {}
          });
          ctx.log(`🪨 Thoát ngạt thở: đã phá ${head.name}`);
          acted = true;
        } catch {}
      });
    }
  }

  // 5. Anti-stuck when pathfinder is trying to move
  if (!ctx.eating && !ctx.bot.isSleeping && ctx.bot.pathfinder?.isMoving?.()) {
    if (!ctx._lastTrackPos || entity.position.distanceTo(ctx._lastTrackPos) >= 0.35) {
      ctx._lastTrackPos = entity.position.clone ? entity.position.clone() : { ...entity.position };
      ctx._lastTrackAt = now;
    } else if (now - ctx._lastTrackAt >= 4000 && now - ctx._lastUnstuckAt >= 4000) {
      ctx._lastUnstuckAt = now;
      ctx._lastTrackAt = now;
      if (typeof ctx.bot.setControlState === 'function') {
        ctx.bot.setControlState('jump', true);
        setTimeout(() => {
          if (!ctx._hazardJumpActive) {
            try { ctx.bot.setControlState('jump', false); } catch {}
          }
        }, 250).unref?.();
      }
    }
  } else {
    ctx._lastTrackPos = null;
    ctx._lastTrackAt = now;
  }

  return acted;
}
