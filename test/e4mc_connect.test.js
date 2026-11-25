import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createRequire } from 'node:module';
import {
  explainConnectionIssue,
  formatMinecraftReason,
  isE4mcHost,
  isLocalHostAddress,
  parseConsoleConnectInput,
  parseServerAddress,
} from '../src/session/lan_discovery.js';
import {
  applyFabricRegistrySync,
  attachFabricModCompat,
  decodeDirectRegistrySync,
  encodeDirectRegistrySync,
} from '../src/session/fabric_compat.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { createBotSession } from '../src/session.js';
import { Memory } from '../src/memory.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';
import { parseCliAuth, parseCliHost } from '../src/index.js';
import { DashboardServer } from '../src/dashboard.js';
import { createMcpHandler } from '../src/mcp/server.js';

function makeMinimalFakeBot() {
  const bot = new EventEmitter();
  bot.username = 'bot_dong_hanh';
  bot.version = '1.21.1';
  bot.health = 20;
  bot.food = 20;
  bot.isAlive = true;
  bot.isSleeping = false;
  bot.game = { dimension: 'overworld' };
  bot.entity = { position: new Vec3(0, 64, 0), onGround: true, velocity: { y: 0 }, yaw: 0, metadata: { 0: 0 } };
  bot.entities = {};
  bot.players = {};
  bot.inventory = { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 20 };
  bot.chat = () => {};
  bot.whisper = () => {};
  bot.pathfinder = { setMovements: () => {}, setGoal: () => {}, goto: async () => {}, isMoving: () => false };
  bot.findBlocks = () => [];
  bot.blockAt = () => null;
  bot.quit = () => {};
  return bot;
}

test('parseServerAddress and parseConsoleConnectInput handle e4mc domains, pasted chat lines, ports, and never hijack commands', () => {
  assert.equal(isE4mcHost('happy-panda.sg.e4mc.link'), true);
  assert.equal(isE4mcHost('[brave-tiger.na.e4mc.link]'), true);
  assert.equal(isE4mcHost('evil-e4mc.link'), false);
  assert.equal(isE4mcHost('127.0.0.1'), false);

  assert.equal(isLocalHostAddress('127.0.0.1'), true);
  assert.equal(isLocalHostAddress('localhost'), true);
  assert.equal(isLocalHostAddress('192.168.1.42'), true);
  assert.equal(isLocalHostAddress('10.0.0.5'), true);
  assert.equal(isLocalHostAddress('172.16.4.2'), true);
  assert.equal(isLocalHostAddress('::1'), true);
  assert.equal(isLocalHostAddress('happy-panda.sg.e4mc.link'), false);
  assert.equal(isLocalHostAddress('8.8.8.8'), false);

  assert.deepEqual(parseServerAddress('happy-panda.sg.e4mc.link'), {
    host: 'happy-panda.sg.e4mc.link',
    port: 25565,
    explicitPort: false,
    isE4mc: true,
    isRemote: true,
  });

  assert.deepEqual(parseServerAddress('[happy-panda.sg.e4mc.link]'), {
    host: 'happy-panda.sg.e4mc.link',
    port: 25565,
    explicitPort: false,
    isE4mc: true,
    isRemote: true,
  });

  assert.deepEqual(parseServerAddress('happy-panda.sg.e4mc.link:25566'), {
    host: 'happy-panda.sg.e4mc.link',
    port: 25566,
    explicitPort: true,
    isE4mc: true,
    isRemote: true,
  });

  assert.deepEqual(parseServerAddress('Local game hosted on domain [brave-tiger.na.e4mc.link]'), {
    host: 'brave-tiger.na.e4mc.link',
    port: 25565,
    explicitPort: false,
    isE4mc: true,
    isRemote: true,
  });

  assert.deepEqual(parseServerAddress('Trò chơi cục bộ được tổ chức tại tên miền [sunny-fox.eu.e4mc.link]'), {
    host: 'sunny-fox.eu.e4mc.link',
    port: 25565,
    explicitPort: false,
    isE4mc: true,
    isRemote: true,
  });

  assert.deepEqual(parseServerAddress('Trò chơi cục bộ được tổ chức tại cổng [59251]'), {
    host: null,
    port: 59251,
    explicitPort: true,
    isE4mc: false,
    isRemote: false,
  });

  assert.equal(parseServerAddress('99999'), null);
  assert.equal(parseServerAddress('evil host'), null);

  assert.deepEqual(parseConsoleConnectInput('59251'), {
    host: null,
    port: 59251,
    explicitPort: true,
    isE4mc: false,
    isRemote: false,
  });
  assert.deepEqual(parseConsoleConnectInput('connect happy-panda.sg.e4mc.link')?.host, 'happy-panda.sg.e4mc.link');
  assert.deepEqual(parseConsoleConnectInput('e4mc brave-tiger.na.e4mc.link')?.host, 'brave-tiger.na.e4mc.link');
  assert.deepEqual(parseConsoleConnectInput('happy-panda.sg.e4mc.link')?.port, 25565);

  for (const cmd of ['theo tôi', 'ngủ', '!stop', 'chặt ít gỗ đi', 'tải mẫu https://example.com/a.schem']) {
    assert.equal(parseConsoleConnectInput(cmd), null, `Unexpected connect parse for command: ${cmd}`);
  }
});

test('explainConnectionIssue detects online-mode e4mc kick and inactive e4mc domains', () => {
  const kickDiag = explainConnectionIssue(
    { translate: 'multiplayer.disconnect.unverified_username' },
    { minecraft: { host: 'happy-panda.sg.e4mc.link', auth: 'offline' } }
  );
  assert.equal(kickDiag?.code, 'online_mode_required');
  assert.match(kickDiag?.hint, /Online Mode/i);
  assert.match(kickDiag?.hint, /microsoft/i);

  assert.equal(
    explainConnectionIssue('Failed to verify username!', { minecraft: { host: 'happy-panda.sg.e4mc.link', auth: 'microsoft' } }),
    null
  );

  const deadErr = Object.assign(new Error('getaddrinfo ENOTFOUND dead.sg.e4mc.link'), { code: 'ENOTFOUND' });
  const deadDiag = explainConnectionIssue(deadErr, { minecraft: { host: 'dead.sg.e4mc.link' } });
  assert.equal(deadDiag?.code, 'e4mc_domain_inactive');
  assert.match(deadDiag?.hint, /dead\.sg\.e4mc\.link/);
});

test('loadConfig normalizes e4mc domain/port and supports microsoft auth & CLI flags', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-e4mc-cfg-'));
  const fileA = path.join(dir, 'a.json');
  const fileB = path.join(dir, 'b.json');
  try {
    await fs.writeFile(fileA, JSON.stringify({ minecraft: { host: 'happy-panda.sg.e4mc.link' } }));
    const cfgA = loadConfig(fileA, { env: {} });
    assert.equal(cfgA.minecraft.host, 'happy-panda.sg.e4mc.link');
    assert.equal(cfgA.minecraft.port, 25565);

    await fs.writeFile(fileB, JSON.stringify({ minecraft: { host: 'brave-tiger.na.e4mc.link:25567' } }));
    const cfgB = loadConfig(fileB, { env: {} });
    assert.equal(cfgB.minecraft.host, 'brave-tiger.na.e4mc.link');
    assert.equal(cfgB.minecraft.port, 25567);

    const cfgMs = loadConfig(fileA, {
      env: {
        MINECRAFT_AUTH: 'microsoft',
        MINECRAFT_USERNAME: 'very_long_microsoft_account_email@example.com',
      },
    });
    assert.equal(cfgMs.minecraft.auth, 'microsoft');
    assert.equal(cfgMs.minecraft.username, 'very_long_microsoft_account_email@example.com');

    assert.equal(parseCliHost(['node', 'src/index.js', '--host', 'happy-panda.sg.e4mc.link']), 'happy-panda.sg.e4mc.link');
    assert.equal(parseCliHost(['node', 'src/index.js', '--e4mc=brave-tiger.na.e4mc.link']), 'brave-tiger.na.e4mc.link');
    assert.equal(parseCliHost(['node', 'src/index.js', '--connect', 'mc.example.com:25566']), 'mc.example.com:25566');
    assert.equal(parseCliAuth(['node', 'src/index.js', '--auth', 'microsoft']), 'microsoft');
    assert.equal(parseCliAuth(['node', 'src/index.js', '--auth=offline']), 'offline');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createBotSession forwards microsoft auth options when enabled and keeps offline payload clean by default', async () => {
  const memory = new Memory({ path: ':memory:' });
  await memory.load();

  let offlineOpts = null;
  const s1 = createBotSession(DEFAULT_CONFIG, {
    memory,
    tasks: new TaskCoordinator(),
    router: new CommandRouter(),
    loadPlugins: false,
    createBotFn: (opts) => {
      offlineOpts = opts;
      return makeMinimalFakeBot();
    },
  });
  assert.equal(offlineOpts.auth, undefined);
  await s1.cleanup();

  let msOpts = null;
  const s2 = createBotSession(
    {
      ...DEFAULT_CONFIG,
      minecraft: {
        ...DEFAULT_CONFIG.minecraft,
        host: 'happy-panda.sg.e4mc.link',
        port: 25565,
        auth: 'microsoft',
        username: 'companion@example.com',
      },
    },
    {
      memory,
      tasks: new TaskCoordinator(),
      router: new CommandRouter(),
      loadPlugins: false,
      createBotFn: (opts) => {
        msOpts = opts;
        return makeMinimalFakeBot();
      },
    }
  );
  assert.equal(msOpts.auth, 'microsoft');
  assert.equal(msOpts.profilesFolder, 'data/auth-cache');
  assert.equal(msOpts.username, 'companion@example.com');
  assert.equal(typeof msOpts.onMsaCode, 'function');
  await s2.cleanup();
  memory.close();
});

test('DashboardServer /api/connect and MCP mc_connect accept portless e4mc domains and default port to 25565', async () => {
  const connects = [];
  const dash = new DashboardServer({
    host: '127.0.0.1',
    port: 0,
    getState: () => ({ connected: false }),
    onCommand: async () => {},
    onConnect: async (cfg) => { connects.push(cfg); },
    log: () => {},
  });

  const addr = await dash.start();
  try {
    const base = `http://${addr.host}:${addr.port}`;

    const e4mcRes = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'happy-panda.sg.e4mc.link', owner: 'araslime' }),
    });
    assert.equal(e4mcRes.status, 200);
    assert.deepEqual(connects.at(-1), {
      host: 'happy-panda.sg.e4mc.link',
      port: 25565,
      owner: 'araslime',
    });

    const pastedRes = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'Local game hosted on domain [brave-tiger.na.e4mc.link]' }),
    });
    assert.equal(pastedRes.status, 200);
    assert.deepEqual(connects.at(-1), {
      host: 'brave-tiger.na.e4mc.link',
      port: 25565,
      owner: '',
    });

    const mcpHandle = createMcpHandler({ baseUrl: base, pollIntervalMs: 15 });
    const mcpRes = await mcpHandle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'mc_connect',
        arguments: { host: 'sunny-fox.eu.e4mc.link', auth: 'microsoft' },
      },
    });
    assert.notEqual(mcpRes.result.isError, true);
    const mcpPayload = JSON.parse(mcpRes.result.content[0].text);
    assert.equal(mcpPayload.host, 'sunny-fox.eu.e4mc.link');
    assert.equal(mcpPayload.port, 25565);
    assert.deepEqual(connects.at(-1), {
      host: 'sunny-fox.eu.e4mc.link',
      port: 25565,
      owner: '',
      auth: 'microsoft',
    });

    const missingBoth = await mcpHandle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'mc_connect', arguments: {} },
    });
    assert.equal(missingBoth.result.isError, true);
  } finally {
    await dash.stop();
  }
});

const req = createRequire(import.meta.url);
const mfReq = createRequire(req.resolve('mineflayer/package.json'));
const prismarineRegistry = mfReq('prismarine-registry');

test('formatMinecraftReason unwraps Prismarine NBT compound kick messages and explainConnectionIssue detects modded server mismatch', () => {
  const realNbtKick = {
    type: 'compound',
    value: {
      extra: {
        type: 'list',
        value: {
          type: 'compound',
          value: [
            { color: { type: 'string', value: 'green' }, text: { type: 'string', value: 'Fabric Loader and Fabric API' } },
            { '': { type: 'string', value: ' installed on your client!' } },
            { '': { type: 'string', value: '\n' } },
            {
              extra: {
                type: 'list',
                value: {
                  type: 'compound',
                  value: [
                    { color: { type: 'string', value: 'yellow' }, text: { type: 'string', value: 'backpacksog' } },
                    { '': { type: 'string', value: '\n' } },
                    { color: { type: 'string', value: 'yellow' }, text: { type: 'string', value: 'comforts' } },
                    { '': { type: 'string', value: '\n' } },
                    { color: { type: 'string', value: 'yellow' }, text: { type: 'string', value: 'ftblibrary' } },
                    { '': { type: 'string', value: '\n' } },
                    { color: { type: 'string', value: 'yellow' }, text: { type: 'string', value: 'ftbultimine' } },
                    { '': { type: 'string', value: '\n' } },
                    { '': { type: 'string', value: 'And 4 more...' } },
                  ],
                },
              },
              text: { type: 'string', value: 'The following registry entry namespaces may be related:\n\n' },
            },
            { '': { type: 'string', value: '\n\n' } },
            { color: { type: 'string', value: 'gold' }, text: { type: 'string', value: "Contact the server's administrator for more information!" } },
          ],
        },
      },
      text: { type: 'string', value: 'This server requires ' },
    },
  };

  const formatted = formatMinecraftReason(realNbtKick);
  assert.match(formatted, /^This server requires Fabric Loader and Fabric API installed on your client!/);
  assert.match(formatted, /backpacksog/);
  assert.match(formatted, /comforts/);
  assert.match(formatted, /ftblibrary/);
  assert.match(formatted, /ftbultimine/);
  assert.match(formatted, /Contact the server's administrator for more information!$/);

  const diag = explainConnectionIssue(realNbtKick, { minecraft: { host: 'hastiness-situated.ap.e4mc.link' } });
  assert.equal(diag?.code, 'modded_client_required');
  assert.match(diag?.hint, /Fabric Registry Sync/);
});

test('DirectRegistrySync codec round-trips and applyFabricRegistrySync updates items, blocks, entities, and blocksByStateId safely', () => {
  const sampleInput = new Map([
    ['minecraft:item', new Map([
      ['minecraft:stone', 1],
      ['backpacksog:backpack', 2001],
      ['comforts:sleeping_bag_white', 2002],
    ])],
    ['minecraft:block', new Map([
      ['minecraft:stone', 1],
      ['comforts:sleeping_bag_white', 2002],
      ['ftbultimine:marker', 2003],
    ])],
    ['minecraft:entity_type', new Map([
      ['ftbultimine:fake', 1500],
    ])],
  ]);

  const encoded = encodeDirectRegistrySync(sampleInput);
  const decoded = decodeDirectRegistrySync(encoded);
  assert.equal(decoded.get('minecraft:item')?.get('backpacksog:backpack'), 2001);
  assert.equal(decoded.get('minecraft:item')?.get('comforts:sleeping_bag_white'), 2002);
  assert.equal(decoded.get('minecraft:block')?.get('ftbultimine:marker'), 2003);
  assert.equal(decoded.get('minecraft:entity_type')?.get('ftbultimine:fake'), 1500);

  const reg = prismarineRegistry('1.21.1');
  const beforeMaxStateId = Object.values(reg.blocks).reduce((m, b) => Math.max(m, b.maxStateId ?? 0), 0);

  const summary = applyFabricRegistrySync(reg, decoded);
  assert.deepEqual(summary.namespaces, ['backpacksog', 'comforts', 'ftbultimine']);
  assert.equal(summary.itemsAdded, 2);
  assert.equal(summary.blocksAdded, 2);
  assert.equal(summary.entitiesAdded, 1);
  assert.equal(reg.items[2001]?.name, 'backpacksog:backpack');
  assert.equal(reg.blocks[2002]?.name, 'comforts:sleeping_bag_white');
  assert.equal(reg.entities[1500]?.internalId, 1500);

  const afterMaxStateId = Object.values(reg.blocks).reduce((m, b) => Math.max(m, b.maxStateId ?? 0), 0);
  assert.equal(afterMaxStateId, beforeMaxStateId);

  assert.equal(reg.blocksByStateId[1]?.name, 'stone');
  const moddedState = reg.blocksByStateId[beforeMaxStateId + 42];
  assert.equal(moddedState?.name, 'modded_block');
  assert.equal(moddedState?.boundingBox, 'empty');
  assert.equal(moddedState?.diggable, false);
});

test('attachFabricModCompat ignores vanilla channels and completes chunked Fabric Registry Sync handshake', () => {
  const vanillaBot = new EventEmitter();
  const vanillaWrites = [];
  vanillaBot._client = new EventEmitter();
  vanillaBot._client.state = 'configuration';
  vanillaBot._client.write = (name, payload) => vanillaWrites.push({ name, payload });

  const vCompat = attachFabricModCompat(vanillaBot);
  vanillaBot._client.emit('custom_payload', {
    channel: 'minecraft:register',
    data: ['minecraft:brand', 'custom:ping'],
  });
  assert.equal(Boolean(vanillaBot._fabricModded), false);
  assert.equal(vanillaWrites.length, 0);
  vCompat.detach();

  const fabricBot = new EventEmitter();
  const fabricLogs = [];
  const fabricWrites = [];
  fabricBot.registry = prismarineRegistry('1.21.1');
  fabricBot._client = new EventEmitter();
  fabricBot._client.state = 'configuration';
  fabricBot._client.write = (name, payload) => fabricWrites.push({ name, payload });

  const fCompat = attachFabricModCompat(fabricBot, { log: (m) => fabricLogs.push(m) });

  fabricBot._client.emit('custom_payload', {
    channel: 'minecraft:register',
    data: Buffer.from('minecraft:brand\0fabric:registry/sync/complete', 'ascii'),
  });
  assert.equal(fabricBot._fabricModded, true);
  assert.equal(fabricWrites[0].name, 'custom_payload');
  assert.equal(fabricWrites[0].payload.channel, 'minecraft:brand');
  assert.equal(fabricWrites[1].payload.channel, 'minecraft:register');
  assert.match(fabricWrites[1].payload.data.toString('ascii'), /fabric:registry\/sync\/direct/);

  const encoded = encodeDirectRegistrySync(new Map([
    ['minecraft:block', new Map([['backpacksog:backpack_block', 2500]])],
    ['minecraft:item', new Map([['ftblibrary:icon', 2501]])],
  ]));
  const splitPoint = Math.floor(encoded.length / 2);
  fabricBot._client.emit('custom_payload', { channel: 'fabric:registry/sync/direct', data: encoded.subarray(0, splitPoint) });
  fabricBot._client.emit('custom_payload', { channel: 'fabric:registry/sync/direct', data: encoded.subarray(splitPoint) });
  assert.equal(fabricWrites.length, 2);

  fabricBot._client.emit('custom_payload', { channel: 'fabric:registry/sync/direct', data: Buffer.alloc(0) });
  assert.equal(fabricWrites.length, 3);
  assert.equal(fabricWrites[2].payload.channel, 'fabric:registry/sync/complete');
  assert.equal(fabricWrites[2].payload.data.length, 0);
  assert.equal(fabricBot.registry.blocks[2500]?.name, 'backpacksog:backpack_block');
  assert.equal(fabricBot.registry.items[2501]?.name, 'ftblibrary:icon');
  assert.ok(fabricLogs.some((l) => l.includes('backpacksog') && l.includes('ftblibrary')));

  fCompat.detach();
});
