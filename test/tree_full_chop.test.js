import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter } from '../src/commands.js';
import { SurvivalManager, resolveCandidateNames } from '../src/survival/index.js';
import {
  getTreeWoodFamily,
  isMatchingTreeBlock,
  isWithinDigReach,
  pickTreePillarItem,
} from '../src/survival/constants.js';

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

function keyOf(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

function createTreeHarness({
  blocks = [],
  startPos = pos(0.5, 64, 0.5),
  inventoryItems = [],
  blockIds = { oak_log: 17, oak_wood: 18, oak_leaves: 19, spruce_log: 20, spruce_leaves: 21, grass_block: 2, cobblestone: 4 },
  dropLogsOnDig = false,
  lowLeafBlockXRange = null,
} = {}) {
  const world = new Map();
  // Lay down grass floor at y=63 across -4..12, -4..12 unless overridden
  for (let x = -4; x <= 12; x++) {
    for (let z = -4; z <= 12; z++) {
      world.set(`${x},63,${z}`, { type: blockIds.grass_block ?? 2, name: 'grass_block', boundingBox: 'block' });
    }
  }
  for (const [coordKey, def] of blocks) {
    world.set(coordKey, {
      type: blockIds[def.name] ?? def.type ?? 17,
      boundingBox: def.boundingBox ?? 'block',
      ...def,
    });
  }

  const inv = inventoryItems.map(i => ({ ...i }));
  const entities = {};
  let nextEntityId = 1;
  let heldItem = null;
  const controlHistory = [];
  const placedBlocks = [];
  const dugBlocks = [];

  const addInv = (name, count = 1) => {
    const existing = inv.find(i => i.name === name);
    if (existing) existing.count += count;
    else inv.push({ name, type: blockIds[name] ?? 99, count, stackSize: 64 });
  };

  const removeInv = (name, count = 1) => {
    const idx = inv.findIndex(i => i.name === name && i.count > 0);
    if (idx < 0) return false;
    inv[idx].count -= count;
    if (inv[idx].count <= 0) inv.splice(idx, 1);
    return true;
  };

  const pickupAtPos = (bp) => {
    for (const [eid, e] of Object.entries(entities)) {
      if (!e?.position) continue;
      if (Math.hypot(e.position.x - bp.x, e.position.y - bp.y, e.position.z - bp.z) <= 2.2) {
        addInv(e.itemName, e.count ?? 1);
        delete entities[eid];
      }
    }
  };

  const bot = {
    entity: { position: startPos, eyeHeight: 1.62 },
    registry: {
      blocksByName: Object.fromEntries(
        Object.entries(blockIds).map(([name, id]) => [name, { id, name }])
      ),
    },
    inventory: {
      emptySlotCount: () => Math.max(0, 36 - inv.length),
      items: () => inv.map(i => ({ ...i })),
    },
    entities,
    heldItem,
    world: {
      raycast: (origin, dir, maxDist) => {
        for (let t = 0.2; t <= maxDist; t += 0.2) {
          const rx = Math.floor(origin.x + dir.x * t);
          const ry = Math.floor(origin.y + dir.y * t);
          const rz = Math.floor(origin.z + dir.z * t);
          const hit = world.get(`${rx},${ry},${rz}`);
          if (hit) return { position: pos(rx, ry, rz) };
        }
        return null;
      },
    },
    findBlocks: ({ matching }) => {
      const idSet = new Set(Array.isArray(matching) ? matching : [matching]);
      const out = [];
      for (const [k, b] of world.entries()) {
        if (idSet.has(b.type)) {
          const [x, y, z] = k.split(',').map(Number);
          out.push(pos(x, y, z));
        }
      }
      return out.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    },
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b
        ? { position: pos(x, y, z), boundingBox: 'block', ...b }
        : { position: pos(x, y, z), type: 0, name: 'air', boundingBox: 'empty' };
    },
    setControlState: (k, v) => {
      controlHistory.push([k, v]);
    },
    equip: async (item) => {
      heldItem = inv.find(i => i.name === item.name) ?? item;
      bot.heldItem = heldItem;
    },
    lookAt: async () => {},
    pathfinder: {
      setGoal: () => {},
      stop: () => {},
      goto: async (goal) => {
        if (lowLeafBlockXRange) {
          const [minX, maxX] = lowLeafBlockXRange;
          const blockingLeaves = [...world.entries()].some(([k, b]) => {
            if (!b.name.endsWith('_leaves')) return false;
            const [lx, ly, lz] = k.split(',').map(Number);
            return lx >= minX && lx <= maxX && (ly === 64 || ly === 65) && lz === 0;
          });
          if (blockingLeaves && (goal.x ?? 0) >= maxX - 1) {
            const err = new Error('Blocked by low leaves');
            err.name = 'NoPath';
            throw err;
          }
        }
        const gx = goal.x ?? bot.entity.position.x;
        const gz = goal.z ?? bot.entity.position.z;
        const tx = Number.isInteger(gx) ? gx + 0.5 : gx;
        const tz = Number.isInteger(gz) ? gz + 0.5 : gz;
        const floorX = Math.floor(tx);
        const floorZ = Math.floor(tz);
        const maxClimbY = Math.floor(bot.entity.position.y) + 1;
        let gy = 64;
        for (let checkY = maxClimbY; checkY >= 63; checkY--) {
          const below = world.get(`${floorX},${checkY - 1},${floorZ}`);
          if (below && below.boundingBox !== 'empty' && !below.name.endsWith('_leaves')) {
            gy = checkY;
            break;
          }
        }
        bot.entity.position = pos(tx, gy, tz);
        pickupAtPos(bot.entity.position);
      },
    },
    dig: async (block) => {
      const bp = block.position;
      if (!isWithinDigReach(bot.entity.position, bp, bot.entity.eyeHeight)) {
        const err = new Error('Block out of reach');
        err.name = 'NoPath';
        throw err;
      }
      const k = keyOf(bp);
      const existing = world.get(k);
      if (!existing) return;
      dugBlocks.push({ key: k, name: existing.name });
      world.delete(k);

      if (existing.name.endsWith('_log') || existing.name.endsWith('_wood')) {
        if (dropLogsOnDig) {
          const eid = `item_${nextEntityId++}`;
          entities[eid] = {
            name: 'item',
            displayName: 'Item',
            itemName: existing.name,
            count: 1,
            position: pos(bp.x + 0.5, 64.1, bp.z + 0.5),
          };
        } else {
          addInv(existing.name, 1);
        }
      } else if (existing.name === 'cobblestone' || existing.name === 'dirt') {
        addInv(existing.name, 1);
      }
    },
    placeBlock: async (refBlock, faceVec) => {
      const tx = Math.floor(refBlock.position.x + faceVec.x);
      const ty = Math.floor(refBlock.position.y + faceVec.y);
      const tz = Math.floor(refBlock.position.z + faceVec.z);
      const itemName = heldItem?.name;
      if (!itemName || !removeInv(itemName, 1)) {
        throw new Error('No held block to place');
      }
      const k = `${tx},${ty},${tz}`;
      world.set(k, { type: blockIds[itemName] ?? 99, name: itemName, boundingBox: 'block' });
      placedBlocks.push({ key: k, name: itemName });
    },
    collectBlock: {
      collect: async () => {
        throw new Error('collectBlock should not be used when direct tree digging is active');
      },
    },
  };

  const survival = new SurvivalManager(bot);
  survival._timeouts = {
    ...survival._timeouts,
    gotoMs: 200,
    stuckMs: 120,
    digExtraMs: 100,
    digMinMs: 100,
    digMaxMs: 300,
    equipMs: 100,
    lookMs: 100,
    verifyDelayMs: 0,
    dropWaitMs: 0,
    placeMs: 150,
    pillarJumpMs: 10,
    pillarSettleMs: 0,
  };

  return { bot, survival, world, inv, controlHistory, placedBlocks, dugBlocks };
}

test('tall 9-block spruce tree is chopped 100% by pillaring up with chopped logs and tearing pillar down completely', async () => {
  const blocks = [];
  for (let y = 64; y <= 72; y++) {
    blocks.push([`2,${y},0`, { name: 'spruce_log' }]);
  }
  // Crown leaves around top trunk + directly over head at y=73
  blocks.push(['2,73,0', { name: 'spruce_leaves' }]);
  for (const y of [70, 71, 72]) {
    blocks.push([`3,${y},0`, { name: 'spruce_leaves' }]);
    blocks.push([`1,${y},0`, { name: 'spruce_leaves' }]);
    blocks.push([`2,${y},1`, { name: 'spruce_leaves' }]);
    blocks.push([`2,${y},-1`, { name: 'spruce_leaves' }]);
  }

  // Start with EMPTY inventory and dropped spruce logs requiring pickup before pillaring!
  const { bot, survival, world, controlHistory, placedBlocks } = createTreeHarness({
    blocks,
    startPos: pos(0.5, 64, 0.5),
    inventoryItems: [],
    dropLogsOnDig: true,
  });

  const got = await survival.gather('gỗ thông', 4);
  assert.equal(got, 9, 'Should count exactly the 9 natural spruce_log blocks, never double-counting pillar blocks');

  const remainingSpruceLogs = [...world.values()].filter(b => b.name === 'spruce_log');
  assert.equal(remainingSpruceLogs.length, 0, 'No floating top logs or leftover pillar logs should remain');
  assert.ok(placedBlocks.length >= 2, 'Bot should have pillared up at least 2 blocks to reach y=72');
  assert.equal(Math.floor(bot.entity.position.y), 64, 'Bot should be back on ground level after pillar teardown');

  const jumpEvents = controlHistory.filter(([k]) => k === 'jump');
  assert.ok(jumpEvents.length >= 2);
  assert.equal(jumpEvents[jumpEvents.length - 1][1], false, 'jump control state must be released');
});

test('fancy oak tree with oak_wood bark and gap-2 canopy branch is chopped completely without touching nearby 2nd oak tree', async () => {
  const blocks = [
    // Tree 1 trunk + bark + high branch separated by leaves (dx=2, dy=2)
    ['2,64,0', { name: 'oak_log' }],
    ['2,65,0', { name: 'oak_log' }],
    ['2,66,0', { name: 'oak_log' }],
    ['2,67,0', { name: 'oak_log' }],
    ['2,68,0', { name: 'oak_log' }],
    ['2,69,0', { name: 'oak_wood' }],
    ['3,70,0', { name: 'oak_leaves' }],
    ['4,71,0', { name: 'oak_wood' }],
    ['4,72,0', { name: 'oak_wood' }],
    ['4,73,0', { name: 'oak_leaves' }],
    ['5,71,0', { name: 'oak_leaves' }],
    // Tree 2 nearby at x=6 (only dx=+2 horizontally from Tree 1 branch at x=4, y=71, with its own ground stump)
    ['6,64,0', { name: 'oak_log' }],
    ['6,65,0', { name: 'oak_log' }],
    ['6,66,0', { name: 'oak_log' }],
    ['6,67,0', { name: 'oak_log' }],
    ['6,68,0', { name: 'oak_log' }],
    ['6,69,0', { name: 'oak_log' }],
  ];

  const { survival, world, placedBlocks } = createTreeHarness({
    blocks,
    startPos: pos(1.5, 64, 0.5),
    inventoryItems: [{ name: 'cobblestone', count: 16 }],
  });

  const got = await survival.gather('gỗ sồi', 2);
  assert.equal(got, 8, 'Should fell all 8 blocks of Tree 1 (6 oak_log + 2 oak_wood)');

  // Tree 1 completely gone
  for (const k of ['2,64,0', '2,65,0', '2,66,0', '2,67,0', '2,68,0', '2,69,0', '4,71,0', '4,72,0']) {
    assert.equal(world.has(k), false, `Tree 1 block ${k} should be gone`);
  }
  // No leftover cobblestone pillar blocks
  const remainingCobble = [...world.values()].filter(b => b.name === 'cobblestone');
  assert.equal(remainingCobble.length, 0, 'Temporary cobblestone pillar must be completely removed');
  assert.ok(placedBlocks.length >= 1, 'Should have pillared up using cobblestone');

  // Tree 2 must be untouched
  for (let y = 64; y <= 69; y++) {
    assert.equal(world.get(`6,${y},0`)?.name, 'oak_log', `Nearby Tree 2 block at 6,${y},0 must remain untouched`);
  }
});

test('low leaf skirt blocking initial pathfinder approach is cleared so bot steps under tree and fells it', async () => {
  const blocks = [
    ['6,64,0', { name: 'oak_log' }],
    ['6,65,0', { name: 'oak_log' }],
    ['6,66,0', { name: 'oak_log' }],
    ['6,67,0', { name: 'oak_log' }],
    ['3,65,0', { name: 'oak_leaves' }],
    ['3,64,0', { name: 'oak_leaves' }],
    ['4,65,0', { name: 'oak_leaves' }],
  ];

  const { survival, world, dugBlocks } = createTreeHarness({
    blocks,
    startPos: pos(1.5, 64, 0.5),
    inventoryItems: [],
    lowLeafBlockXRange: [2, 5],
  });

  const got = await survival.gather('gỗ', 2);
  assert.equal(got, 4);
  assert.ok(dugBlocks.some(b => b.name === 'oak_leaves'));
  assert.equal([...world.values()].filter(b => b.name === 'oak_log').length, 0);
});

test('aborts cleanly mid-pillar and releases jump control without hanging', async () => {
  const blocks = [];
  for (let y = 64; y <= 73; y++) {
    blocks.push([`2,${y},0`, { name: 'spruce_log' }]);
  }
  const { bot, survival, controlHistory } = createTreeHarness({
    blocks,
    startPos: pos(1.5, 64, 0.5),
    inventoryItems: [{ name: 'dirt', count: 16 }],
  });

  const controller = new AbortController();
  const origPlace = bot.placeBlock;
  bot.placeBlock = async (...args) => {
    await origPlace(...args);
    controller.abort();
  };

  await assert.rejects(survival.gather('gỗ thông', 10, controller.signal), /hủy/i);
  const jumpEvents = controlHistory.filter(([k]) => k === 'jump');
  assert.ok(jumpEvents.length >= 1);
  assert.equal(jumpEvents[jumpEvents.length - 1][1], false);
});

test('tree constants, Vietnamese wood aliases, đốn/chop command verbs, and safe pillar selection work as expected', () => {
  const router = new CommandRouter();
  assert.deepEqual(router.parse('đốn cây'), { type: 'gather', count: 16, target: 'cay' });
  assert.deepEqual(router.parse('chặt 8 gỗ sồi'), { type: 'gather', count: 8, target: 'go soi' });
  assert.deepEqual(router.parse('chặt gỗ anh đào'), { type: 'gather', count: 16, target: 'go anh dao' });
  assert.deepEqual(router.parse('chop wood'), { type: 'gather', count: 16, target: 'wood' });

  assert.deepEqual(resolveCandidateNames('go soi'), ['oak_log', 'oak_wood']);
  assert.deepEqual(resolveCandidateNames('go anh dao'), ['cherry_log', 'cherry_wood']);

  assert.equal(getTreeWoodFamily('cherry_wood'), 'cherry');
  assert.equal(getTreeWoodFamily('stripped_oak_log'), null);
  assert.equal(getTreeWoodFamily('mushroom_stem'), null);

  assert.equal(isMatchingTreeBlock({ type: 100, name: 'oak_wood' }, { type: 17, name: 'oak_log' }), true);
  assert.equal(isMatchingTreeBlock({ type: 101, name: 'spruce_log' }, { type: 17, name: 'oak_log' }), false);

  const unsafeOnlyBot = {
    inventory: {
      items: () => [
        { name: 'sand', count: 64 },
        { name: 'gravel', count: 64 },
        { name: 'diamond_ore', count: 10 },
      ],
    },
  };
  assert.equal(pickTreePillarItem(unsafeOnlyBot), null);

  const mixedBot = {
    inventory: {
      items: () => [
        { name: 'sand', count: 64 },
        { name: 'oak_log', count: 5 },
        { name: 'oak_planks', count: 12 },
        { name: 'dirt', count: 4 },
      ],
    },
  };
  assert.equal(pickTreePillarItem(mixedBot)?.name, 'dirt');
});
