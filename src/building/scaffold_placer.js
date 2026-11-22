import {
  BLOCKED,
  ROTATIONS,
  blockName,
  checkAbort,
  isAir,
  isReplaceable,
  keyFor,
  rotateBlock,
  rotatePosition,
  vector,
} from './blueprint_loader.js';

const SCAFFOLD_ITEMS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'oak_planks'];

export function findSupport(bot, target) {
  for (const [dx, dy, dz, face] of [
    [0, -1, 0, vector(0, 1, 0)],
    [0, 0, -1, vector(0, 0, 1)],
    [0, 0, 1, vector(0, 0, -1)],
    [-1, 0, 0, vector(1, 0, 0)],
    [1, 0, 0, vector(-1, 0, 0)],
  ]) {
    const p = target.offset(dx, dy, dz);
    const block = bot.blockAt(p);
    if (block && !isAir(block) && !BLOCKED.has(blockName(block))) return { block, face };
  }
  return null;
}

export async function placeTemporaryScaffold(builder, target, placedScaffolds, signal) {
  const items = builder.bot.inventory?.items?.() ?? [];
  const scaffoldItem = items.find(i => SCAFFOLD_ITEMS.includes(i?.name));
  if (!scaffoldItem) return false;

  let anchorY = null;
  for (let dy = 2; dy <= 8; dy++) {
    const below = builder.bot.blockAt(vector(target.x, target.y - dy, target.z));
    if (below && !isAir(below) && !BLOCKED.has(blockName(below))) {
      anchorY = target.y - dy;
      break;
    }
  }
  if (anchorY == null) return false;

  for (let sy = anchorY + 1; sy <= target.y - 1; sy++) {
    checkAbort(signal);
    const sPos = vector(target.x, sy, target.z);
    const cur = builder.bot.blockAt(sPos);
    if (cur && !isReplaceable(cur)) continue;

    const supportBlock = builder.bot.blockAt(vector(target.x, sy - 1, target.z));
    if (!supportBlock || isAir(supportBlock)) return false;

    const item = (builder.bot.inventory?.items?.() ?? []).find(i => SCAFFOLD_ITEMS.includes(i?.name));
    if (!item) return false;

    await builder._moveWithinReach(sPos, signal);
    await builder.bot.equip(item, 'hand');
    await builder.bot.placeBlock(supportBlock, vector(0, 1, 0));
    placedScaffolds.push(sPos);
  }
  return builder._findSupport(target) != null;
}

export async function cleanupScaffolds(builder, placedScaffolds, signal) {
  if (typeof builder.bot.dig !== 'function') return;
  for (let i = placedScaffolds.length - 1; i >= 0; i--) {
    if (signal?.aborted) break;
    const sPos = placedScaffolds[i];
    const b = builder.bot.blockAt(sPos);
    if (b && !isAir(b)) {
      await builder._moveWithinReach(sPos, signal);
      await builder.bot.dig(b);
    }
  }
}

export async function buildBlueprint(builder, args = {}, signal) {
  const file = args.file ?? args.path;
  const bp = await builder._load(file);
  const { x, y, z } = args;
  const rotation = args.rotation ?? 0;
  if (![x, y, z].every(Number.isInteger)) throw new TypeError('Build origin x, y, z must be integers');
  if (!ROTATIONS.has(rotation)) throw new RangeError('rotation must be 0, 90, 180, or 270');

  const progressKey = keyFor(file, x, y, z, rotation);
  const done = new Set(builder.memory?.get?.(progressKey, []) ?? []);
  const remaining = bp.blocks
    .filter(b => !done.has(`${b.x},${b.y},${b.z}`))
    .sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const counts = {};
  for (const b of remaining) counts[b.name] = (counts[b.name] ?? 0) + 1;

  const maxSession = builder.config.maxBlocksPerSession ?? Infinity;
  const maxAttempts = builder.config.maxPlacementAttempts ?? Math.min(bp.blocks.length + 5, maxSession);
  const autoScaffold = args.autoScaffold === true || builder.config.autoScaffold === true;
  const placedScaffolds = [];
  let placed = 0;

  try {
    for (const original of remaining) {
      checkAbort(signal);
      await builder._waitIfPaused(signal);
      if (placed >= maxAttempts) throw new Error('Build placement attempt limit reached');
      const p = rotatePosition(original.x, original.z, bp.size.x, bp.size.z, rotation);
      const target = vector(x + p.x, y + original.y, z + p.z);
      const existing = builder.bot.blockAt(target);
      const wanted = rotateBlock(original, rotation);

      if (blockName(existing) === wanted.name) {
        done.add(`${original.x},${original.y},${original.z}`);
        await builder.memory?.set?.(progressKey, [...done]);
        continue;
      }
      if (!isReplaceable(existing)) {
        throw new Error(`Cannot place ${wanted.name} at ${target.x},${target.y},${target.z}: target contains ${blockName(existing)}; builder will not break existing blocks`);
      }

      const item = builder.bot.inventory?.items?.().find(i => i.name === wanted.name);
      if (!item) {
        throw new Error(`Missing material ${wanted.name}; remaining material counts: ${JSON.stringify(counts)}`);
      }
      if (builder.equipment?.maintainArmorAndShield) await builder.equipment.maintainArmorAndShield();

      let support = builder._findSupport(target);
      if (!support && autoScaffold) {
        await placeTemporaryScaffold(builder, target, placedScaffolds, signal);
        support = builder._findSupport(target);
      }
      if (!support) {
        throw new Error(`No safe support block for ${wanted.name} at ${target.x},${target.y},${target.z}; scaffolding is not placed automatically`);
      }

      await builder._moveWithinReach(target, signal);
      if (builder._isOwnerInside?.(target)) {
        throw new Error(`Cannot place ${wanted.name} at ${target.x},${target.y},${target.z}: owner is standing inside target block`);
      }
      await builder.bot.equip(item, 'hand');
      await builder._placeOriented(support.block, support.face, wanted.properties);

      const actual = builder.bot.blockAt(target);
      if (blockName(actual) !== wanted.name) {
        throw new Error(`Placement verification failed at ${target.x},${target.y},${target.z}: expected ${wanted.name}, found ${blockName(actual)}`);
      }
      done.add(`${original.x},${original.y},${original.z}`);
      counts[wanted.name] = Math.max(0, (counts[wanted.name] ?? 1) - 1);
      await builder.memory?.set?.(progressKey, [...done]);
      placed++;
    }
  } finally {
    if (placedScaffolds.length > 0) {
      await cleanupScaffolds(builder, placedScaffolds, signal).catch(() => {});
    }
    await builder.memory?.flush?.();
  }

  const complete = done.size >= bp.blocks.length;
  builder.log({ type: 'building', status: complete ? 'complete' : 'progress', placed, total: bp.blocks.length });
  return {
    complete,
    placed,
    total: bp.blocks.length,
    remainingMaterials: counts,
    origin: { x, y, z },
    rotation,
    scaffoldsCleaned: placedScaffolds.length,
  };
}
