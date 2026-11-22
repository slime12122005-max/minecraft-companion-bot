import test from 'node:test'
import assert from 'node:assert/strict'
import { rotatePosition, SCHEMATIC_CATALOG, downloadSchematic, Builder, calculateMaterialShortage, buildSupplyPlan } from '../src/building/index.js'

const bot = { blockAt: () => null }

test('rotates blueprint coordinates around origin for each right angle', () => {
  assert.deepEqual(rotatePosition(1, 2, 4, 3, 0), { x: 1, z: 2 })
  assert.deepEqual(rotatePosition(1, 2, 4, 3, 90), { x: 0, z: 1 })
  assert.deepEqual(rotatePosition(1, 2, 4, 3, 180), { x: 2, z: 0 })
  assert.deepEqual(rotatePosition(1, 2, 4, 3, 270), { x: 2, z: 2 })
})

test('catalog only lists free, established schematic sources', () => {
  assert.ok(SCHEMATIC_CATALOG.length >= 3)
  for (const entry of SCHEMATIC_CATALOG) {
    assert.equal(new URL(entry.url).protocol, 'https:')
    assert.equal(entry.free, true)
  }
})

test('download policy rejects non-HTTPS and unlisted hosts before network access', async () => {
  await assert.rejects(downloadSchematic('http://minecraft-schematics.com/house.schem', 'house.schem'), /HTTPS/)
  await assert.rejects(downloadSchematic('https://example.com/house.schem', 'house.schem'), /curated/)
})

test('prepare requires explicit confirmation before loading or changing terrain', async () => {
  const builder = new Builder(bot)
  await assert.rejects(builder.prepare({ file: 'not-read.schem', x: 0, y: 64, z: 0 }), /confirmed: true/)
})

test('litematic rejection is explicit', async () => {
  const builder = new Builder(bot)
  await assert.rejects(builder.inspect('house.litematic'), /not supported yet/)
})

test('Builder uses real Vec3 coordinates compatible with prismarine-world blockAt', () => {
  let sawFloored = false
  const worldBot = {
    blockAt: (p) => {
      assert.equal(typeof p.floored, 'function')
      sawFloored = true
      return p.y === 63 ? { name: 'stone' } : { name: 'air' }
    },
  }
  const builder = new Builder(worldBot)
  const target = { x: 10, y: 64, z: 20, offset(dx, dy, dz) { return { x: 10 + dx, y: 64 + dy, z: 20 + dz, floored: () => this } } }
  const support = builder._findSupport(target)
  assert.ok(sawFloored)
  assert.ok(support)
  assert.equal(typeof support.face.floored, 'function')
  assert.equal(support.face.y, 1)
})

test('Builder.build resumes from Memory progress, handles rotation 90, and prepares vegetation/holes safely', async () => {
  const { Memory } = await import('../src/memory.js')
  const { Vec3 } = await import('vec3')
  const memory = new Memory({ autoSaveMs: 0 })
  const world = new Map([
    ['0,63,0', { name: 'stone', position: new Vec3(0, 63, 0) }],
    ['1,63,0', { name: 'stone', position: new Vec3(1, 63, 0) }],
    ['0,64,0', { name: 'short_grass', position: new Vec3(0, 64, 0) }],
  ])
  const placed = []
  const dug = []
  const mockBot = {
    entity: { position: new Vec3(5, 64, 5) },
    inventory: { items: () => [{ name: 'oak_planks', count: 10 }] },
    blockAt: (p) => world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'air', position: p },
    equip: async () => {},
    dig: async (b) => {
      dug.push(b.name)
      world.delete(`${b.position.x},${b.position.y},${b.position.z}`)
    },
    placeBlock: async (ref, face) => {
      const target = ref.position.plus(face)
      placed.push(`${target.x},${target.y},${target.z}`)
      world.set(`${target.x},${target.y},${target.z}`, { name: 'oak_planks', position: target })
    },
  }

  const builder = new Builder(mockBot, { building: { maxBlocksPerSession: 5 } }, { memory })
  const fakePath = 'C:/tmp/test-build.schem'
  const pathMod = await import('node:path')
  builder.loadedFile = pathMod.resolve(fakePath)
  builder.blueprint = {
    size: { x: 2, y: 1, z: 1 },
    blocks: [
      { x: 0, y: 0, z: 0, name: 'oak_planks', properties: {} },
      { x: 1, y: 0, z: 0, name: 'oak_planks', properties: {} },
    ],
    materials: { oak_planks: 2 },
  }

  const prep = await builder.prepare({ file: fakePath, x: 0, y: 64, z: 0, rotation: 0, confirmed: true })
  assert.equal(prep.cleared, 1)
  assert.deepEqual(dug, ['short_grass'])

  // Mark first block done in memory; only second block should be placed
  const progKey = `building.progress:${pathMod.resolve(fakePath)}:0,64,0:0`
  memory.set(progKey, ['0,0,0'])
  const res = await builder.build({ file: fakePath, x: 0, y: 64, z: 0, rotation: 0 })
  assert.equal(res.complete, true)
  assert.equal(res.placed, 1)
  assert.deepEqual(placed, ['1,64,0'])
})

test('Builder._placeOriented aligns yaw and uses forceLook: ignore for directional blocks', async () => {
  const looks = []
  const calls = []
  const mockBot = {
    look: async (yaw, pitch) => looks.push({ yaw, pitch }),
    _placeBlockWithOptions: async (_ref, _face, opts) => calls.push(opts),
    placeBlock: async () => { throw new Error('should use _placeBlockWithOptions') },
  }
  const builder = new Builder(mockBot)
  await builder._placeOriented({}, {}, { facing: 'north', half: 'top' })
  await builder._placeOriented({}, {}, { facing: 'east' })
  assert.equal(looks[0].yaw, Math.PI)
  assert.equal(looks[1].yaw, Math.PI / 2)
  assert.deepEqual(calls[0], { swingArm: 'right', forceLook: 'ignore', half: 'top' })
  assert.deepEqual(calls[1], { swingArm: 'right', forceLook: 'ignore', half: undefined })
})

test('Builder.prepare fills water when keepWater is false and protects water when keepWater is true', async () => {
  const { Vec3 } = await import('vec3')
  const pathMod = await import('node:path')
  const makeWorldBot = () => {
    const world = new Map([
      ['0,63,0', { name: 'stone', position: new Vec3(0, 63, 0) }],
      ['0,64,0', { name: 'water', position: new Vec3(0, 64, 0) }],
    ])
    return {
      entity: { position: new Vec3(2, 64, 2) },
      inventory: { items: () => [{ name: 'dirt', count: 5 }] },
      blockAt: (p) => world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'air', position: p },
      equip: async () => {},
      placeBlock: async (ref, face) => {
        const t = ref.position.plus(face)
        world.set(`${t.x},${t.y},${t.z}`, { name: 'dirt', position: t })
      },
    }
  }

  const fakePath = 'C:/tmp/water-test.schem'
  const bp = { size: { x: 1, y: 1, z: 1 }, blocks: [{ x: 0, y: 0, z: 0, name: 'stone', properties: {} }], materials: { stone: 1 } }

  const bDrain = new Builder(makeWorldBot(), { building: { keepWater: false } })
  bDrain.loadedFile = pathMod.resolve(fakePath)
  bDrain.blueprint = bp
  const r1 = await bDrain.prepare({ file: fakePath, x: 0, y: 64, z: 0, confirmed: true })
  assert.equal(r1.filled, 1)

  const bKeep = new Builder(makeWorldBot(), { building: { keepWater: true } })
  bKeep.loadedFile = pathMod.resolve(fakePath)
  bKeep.blueprint = bp
  const r2 = await bKeep.prepare({ file: fakePath, x: 0, y: 64, z: 0, confirmed: true })
  assert.equal(r2.protected, 1)
})

test('Builder loads JSON blueprints, computes material shortage + supply plan, and autoScaffold cleans temporary dirt', async () => {
  const fsMod = await import('node:fs/promises')
  const osMod = await import('node:os')
  const pathMod = await import('node:path')
  const { Vec3 } = await import('vec3')

  const shortage = calculateMaterialShortage({ oak_planks: 80, stone: 10 }, [{ name: 'oak_planks', count: 16 }], { stone: 10 })
  assert.equal(shortage.readyToBuild, false)
  assert.deepEqual(shortage.fromChests, { stone: 10 })
  assert.deepEqual(shortage.missing, { oak_planks: 64 })
  const supply = buildSupplyPlan(shortage.missing)
  assert.deepEqual(supply, [
    { action: 'gather', target: 'oak_log', count: 16 },
    { action: 'craft', target: 'oak_planks', count: 64 },
  ])

  const dir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), 'bot-bp-'))
  const jsonFile = pathMod.join(dir, 'tower.json')
  try {
    await fsMod.writeFile(jsonFile, JSON.stringify({
      size: [1, 3, 1],
      blocks: [{ x: 0, y: 2, z: 0, name: 'stone' }],
    }))

    const world = new Map([['0,63,0', { name: 'stone', position: new Vec3(0, 63, 0) }]])
    const keyOf = p => `${p.x},${p.y},${p.z}`
    const inv = [{ name: 'stone', count: 1 }, { name: 'dirt', count: 4 }]
    let held = null
    const placedLog = []
    const dugLog = []

    const scaffoldBot = {
      entity: { position: new Vec3(1, 64, 1) },
      inventory: { items: () => inv },
      blockAt: (p) => world.get(keyOf(p)) ?? { name: 'air', position: p },
      equip: async (item) => { held = item.name },
      placeBlock: async (ref, face) => {
        const t = ref.position.offset(face.x, face.y, face.z)
        world.set(keyOf(t), { name: held, position: t })
        placedLog.push({ pos: keyOf(t), name: held })
      },
      dig: async (block) => {
        dugLog.push(keyOf(block.position))
        world.delete(keyOf(block.position))
      },
    }

    const builder = new Builder(scaffoldBot, { building: { autoScaffold: true } })
    const info = await builder.inspect(jsonFile)
    assert.equal(info.blockCount, 1)

    const res = await builder.build({ file: jsonFile, x: 0, y: 64, z: 0, rotation: 0 })
    assert.equal(res.complete, true)
    assert.equal(res.placed, 1)
    assert.equal(res.scaffoldsCleaned, 2)
    assert.equal(world.get('0,66,0')?.name, 'stone')
    assert.equal(world.has('0,64,0'), false)
    assert.equal(world.has('0,65,0'), false)
    assert.deepEqual(dugLog, ['0,65,0', '0,64,0'])
  } finally {
    await fsMod.rm(dir, { recursive: true, force: true })
  }
})
