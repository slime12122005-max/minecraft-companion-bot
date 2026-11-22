import {
  BLOCKED,
  ROTATIONS,
  blockName,
  checkAbort,
  isAir,
  isReplaceable,
  rotatePosition,
  vector,
} from './blueprint_loader.js';

export function isVegetation(block) {
  const name = blockName(block);
  return /(?:grass|flower|fern|vine|leaves|sapling|mushroom|dead_bush|seagrass|kelp|snow)$/.test(name) || block?.material === 'plant';
}

export function isSmallHole(bot, target) {
  const below = bot.blockAt(target.offset(0, -1, 0));
  return isAir(below) && !isAir(bot.blockAt(target.offset(0, -2, 0)));
}

export async function prepareSite(builder, args = {}, signal) {
  if (args.confirmed !== true) {
    throw new Error('Terrain preparation requires confirmed: true from an explicit user command');
  }
  const file = args.file ?? args.path;
  const bp = await builder._load(file);
  const { x, y, z } = args;
  if (![x, y, z].every(Number.isInteger)) throw new TypeError('Preparation origin x, y, z must be integers');
  const rotation = args.rotation ?? 0;
  if (!ROTATIONS.has(rotation)) throw new RangeError('rotation must be 0, 90, 180, or 270');

  const bounds = new Set();
  for (const b of bp.blocks) {
    const p = rotatePosition(b.x, b.z, bp.size.x, bp.size.z, rotation);
    bounds.add(`${x + p.x},${y + b.y},${z + p.z}`);
  }
  const maxClear = builder.config.maxPrepareBlocks ?? 200;
  if (bounds.size > maxClear) throw new Error(`Preparation area exceeds configured limit (${maxClear} blocks)`);

  const report = { cleared: 0, filled: 0, protected: 0, skipped: 0 };
  for (const point of bounds) {
    checkAbort(signal);
    await builder._waitIfPaused(signal);
    const [bx, by, bz] = point.split(',').map(Number);
    const target = vector(bx, by, bz);
    const block = builder.bot.blockAt(target);
    if (!block || isReplaceable(block)) { report.skipped++; continue; }
    if (BLOCKED.has(blockName(block)) || block?.entity || block?.getProperties?.().waterlogged) {
      report.protected++;
      continue;
    }
    const name = blockName(block);
    if (name.includes('lava')) { report.protected++; continue; }
    if (name.includes('water')) {
      if (builder.config.keepWater === false) {
        const filler = builder.bot.inventory?.items?.().find(i => /dirt|cobblestone|stone/.test(i.name));
        if (!filler) { report.skipped++; continue; }
        await builder._moveWithinReach(target, signal);
        await builder.bot.equip(filler, 'hand');
        const support = builder._findSupport(target);
        if (support) {
          await builder.bot.placeBlock(support.block, support.face);
          report.filled++;
        } else {
          report.skipped++;
        }
      } else {
        report.protected++;
      }
      continue;
    }
    if (builder._isVegetation(block)) {
      await builder._moveWithinReach(target, signal);
      await builder.bot.dig(block);
      report.cleared++;
      continue;
    }
    if (builder._isSmallHole(target)) {
      const filler = builder.bot.inventory?.items?.().find(i => /dirt|cobblestone|stone/.test(i.name));
      if (!filler) { report.skipped++; continue; }
      await builder._moveWithinReach(target, signal);
      await builder.bot.equip(filler, 'hand');
      const support = builder._findSupport(target);
      if (support) {
        await builder.bot.placeBlock(support.block, support.face);
        report.filled++;
      } else {
        report.skipped++;
      }
      continue;
    }
    report.protected++;
  }
  return { confirmed: true, bounds: bounds.size, ...report };
}
