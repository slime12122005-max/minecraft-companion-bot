import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardServer } from '../src/dashboard.js';
import { createDashboardBridge } from '../src/session/dashboard_bridge.js';
import { TaskCoordinator } from '../src/tasks.js';
import { BotStateMachine } from '../src/session/state_machine.js';
import { HealthWatchdog } from '../src/session/health_watchdog.js';

test('DashboardServer serves HTML, JSON state, and dispatches commands', async () => {
  const received = [];
  let reconnected = null;
  const dash = new DashboardServer({
    host: '127.0.0.1',
    port: 0,
    getState: () => ({ health: 18, food: 20, task: 'theo_chu', jev: { action: 'melee', confidence: 0.9 } }),
    onCommand: async (cmd) => received.push(cmd),
    onConnect: async (cfg) => { reconnected = cfg; },
    log: () => {},
  });

  const addr = await dash.start();
  try {
    const base = `http://${addr.host}:${addr.port}`;
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Jev System-1 Telemetry/);
    assert.match(html, /lanPort/);
    assert.match(html, /function esc\(/);
    assert.equal(htmlRes.headers.get('x-frame-options'), 'DENY');
    assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');

    const stateRes = await fetch(`${base}/api/state`);
    const state = await stateRes.json();
    assert.equal(state.health, 18);
    assert.equal(state.jev.action, 'melee');

    const crossOriginCmd = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ command: 'theo tôi' }),
    });
    assert.equal(crossOriginCmd.status, 403);

    const formCsrf = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'port=54321',
    });
    assert.equal(formCsrf.status, 415);

    const badHost = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'evil host', port: 54321 }),
    });
    assert.equal(badHost.status, 400);

    const badConnect = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 99999 }),
    });
    assert.equal(badConnect.status, 400);

    const goodConnect = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', port: 54321, owner: 'araslime' }),
    });
    assert.equal(goodConnect.status, 200);
    assert.deepEqual(reconnected, { host: '127.0.0.1', port: 54321, owner: 'araslime' });

    const cmdRes = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'theo tôi' }),
    });
    assert.equal(cmdRes.status, 200);
    assert.deepEqual(received, ['theo tôi']);
  } finally {
    await dash.stop();
  }
});

test('DashboardServer serves static assets, SSE stream, health, control, and inventory endpoints', async () => {
  const controls = [];
  const invActions = [];
  let hp = 19;
  const dash = new DashboardServer({
    host: '127.0.0.1',
    port: 0,
    sseIntervalMs: 60,
    getState: () => ({
      connected: true,
      state: 'WORKING',
      aiPaused: false,
      health: hp,
      food: 20,
      watchdog: { healthy: true, ticks: 10 },
      jev: { action: 'melee', confidence: 0.9 },
    }),
    onCommand: async () => {},
    onControl: async (payload) => {
      controls.push(payload);
      return { ok: true, action: payload.action };
    },
    onInventoryAction: async (payload) => {
      invActions.push(payload);
      return { ok: true, ...payload };
    },
    log: () => {},
  });

  const addr = await dash.start();
  try {
    const base = `http://${addr.host}:${addr.port}`;

    const cssRes = await fetch(`${base}/style.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type'), /text\/css/);
    assert.match(await cssRes.text(), /progress::-moz-progress-bar/);

    const jsRes = await fetch(`${base}/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type'), /javascript/);
    assert.match(await jsRes.text(), /EventSource\('\/api\/stream'\)/);

    const healthRes = await fetch(`${base}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.connected, true);
    assert.equal(health.state, 'WORKING');

    // Verify SSE /api/stream delivers JSON frames promptly and aborts cleanly
    const ac = new AbortController();
    const sseRes = await fetch(`${base}/api/stream`, { signal: ac.signal });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type'), /text\/event-stream/);
    const reader = sseRes.body.getReader();
    const firstRead = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('SSE timeout')), 500)),
    ]);
    assert.equal(firstRead.done, false);
    const chunkText = Buffer.from(firstRead.value).toString('utf8');
    assert.match(chunkText, /^data: /);
    const parsedFrame = JSON.parse(chunkText.split('\n')[0].slice(6));
    assert.equal(parsedFrame.health, 19);
    await reader.cancel().catch(() => {});
    ac.abort();

    // POST /api/control security + action dispatch
    const evilCtrl = await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ action: 'toggle_ai' }),
    });
    assert.equal(evilCtrl.status, 403);

    const badCtrl = await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'self_destruct' }),
    });
    assert.equal(badCtrl.status, 400);

    for (const action of ['toggle_ai', 'recall_home', 'safe_disconnect']) {
      const res = await fetch(`${base}/api/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      assert.equal(res.status, 200);
    }
    assert.deepEqual(controls.map(c => c.action), ['toggle_ai', 'recall_home', 'safe_disconnect']);

    // POST /api/inventory/action validation + dispatch
    const badInv = await fetch(`${base}/api/inventory/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'eat', itemName: 'apple' }),
    });
    assert.equal(badInv.status, 400);

    const equipRes = await fetch(`${base}/api/inventory/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'equip', itemName: 'iron_sword', slot: 36 }),
    });
    assert.equal(equipRes.status, 200);

    const dropRes = await fetch(`${base}/api/inventory/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'drop', itemName: 'cobblestone', slot: 10 }),
    });
    assert.equal(dropRes.status, 200);

    assert.deepEqual(invActions, [
      { action: 'equip', itemName: 'iron_sword', slot: 36 },
      { action: 'drop', itemName: 'cobblestone', slot: 10 },
    ]);
  } finally {
    await dash.stop();
  }
});

test('createDashboardBridge enriches state and executes emergency controls and inventory actions', async () => {
  const tasks = new TaskCoordinator({ log: () => {} });
  const stateMachine = new BotStateMachine();
  const watchdog = new HealthWatchdog();
  watchdog.recordTick(Date.now(), { pos: { x: 10, y: 64, z: -5 } });

  const events = [];
  const sword = { name: 'iron_sword', count: 1, slot: 36, type: 267, maxDurability: 250, durabilityUsed: 20 };
  const helm = { name: 'diamond_helmet', count: 1, slot: 5, type: 310, maxDurability: 363, durabilityUsed: 350 };
  const cobble = { name: 'cobblestone', count: 32, slot: 12, type: 4 };
  const slots = [];
  slots[5] = helm;
  slots[36] = sword;

  const state = { connected: true, aiPaused: false };
  let pausedCalled = false;
  tasks.run({ name: 'mine_iron' }, () => new Promise(() => {}), {
    onPause: () => { pausedCalled = true; },
  });

  const ctx = {
    bot: {
      username: 'bot_1',
      health: 17,
      food: 18,
      experience: { level: 5, progress: 0.4, points: 55 },
      time: { timeOfDay: 3000, isDay: true },
      entity: { position: { x: 10, y: 64, z: -5 } },
      heldItem: sword,
      inventory: {
        slots,
        items: () => [sword, cobble],
      },
      pathfinder: { setGoal: () => {} },
      equip: async (item, dest) => events.push(['equip', item.name, dest]),
      tossStack: async (item) => events.push(['drop', item.name, item.count]),
      chat: (m) => events.push(['chat', m]),
      quit: (r) => events.push(['quit', r]),
    },
    config: { minecraft: { host: 'localhost', port: 25565 }, owner: 'araslime', llm: { model: 'jev-latest' } },
    llm: {
      isAvailable: () => true,
      apiKey: 'k',
      provider: 'typesafe',
      model: 'jev-latest',
      stats: () => ({ requests: 2, errors: 0, rateLimited: 0, avgLatencyMs: 12 }),
    },
    memory: {
      queryPois: () => [{ id: 1, category: 'home', label: 'nha', x: 0, y: 64, z: 0 }],
      flush: async () => events.push(['flush']),
    },
    tasks,
    equipment: {
      status: () => ({ equipped: { head: 'diamond_helmet', hand: 'iron_sword' } }),
      armorMitigation: () => 0.18,
      getLowDurabilityItems: () => [{ name: 'diamond_helmet', slot: 'head', ratio: 0.036 }],
    },
    home: { listChestInventory: () => ({ '1,64,1': '64x cobblestone' }) },
    combat: {
      start: () => events.push(['combat_start']),
      stop: () => events.push(['combat_stop']),
      lastJevTelemetry: { action: 'melee', confidence: 0.85 },
      lastThreatAssessment: { score: 0.32, posture: 'aggressive', mobCount: 1 },
    },
    stateMachine,
    watchdog,
    logger: { recent: () => ['[bot] ready'] },
    logFor: () => () => {},
    state,
    handleCommand: async () => {},
    startGoHomeTask: () => { events.push(['go_home']); return true; },
    stopCurrentTask: (r) => events.push(['stop_task', r]),
  };

  const bridge = createDashboardBridge(ctx);
  const snap = bridge.getDashboardState();
  assert.equal(snap.xp.level, 5);
  assert.equal(snap.isDay, true);
  assert.equal(snap.armorMitigation, 0.18);
  assert.equal(snap.equipmentSlots.head.name, 'diamond_helmet');
  assert.equal(snap.equipmentSlots.hand.name, 'iron_sword');
  assert.equal(snap.pois.length, 1);
  assert.equal(snap.threat.posture, 'aggressive');
  assert.equal(snap.taskQueue.active.name, 'mine_iron');
  assert.equal(snap.aiStats.requests, 2);
  assert.equal(snap.brains.planner, 'Antigravity (MCP)');
  assert.equal(snap.brains.tacticalSupport, 'Jev (jev-latest)');

  const toggleRes = await bridge.onControl({ action: 'toggle_ai' });
  assert.equal(toggleRes.aiPaused, true);
  assert.equal(state.aiPaused, true);
  assert.equal(tasks.paused, true);
  assert.equal(pausedCalled, true);

  const resumeRes = await bridge.onControl({ action: 'resume_ai' });
  assert.equal(resumeRes.aiPaused, false);
  assert.equal(tasks.paused, false);

  await bridge.onControl({ action: 'recall_home' });
  await bridge.onControl({ action: 'safe_disconnect' });
  await bridge.onInventoryAction({ action: 'equip', itemName: 'iron_sword', slot: 36 });
  await bridge.onInventoryAction({ action: 'drop', itemName: 'cobblestone', slot: 12 });

  assert.ok(events.some(e => e[0] === 'combat_stop'));
  assert.ok(events.some(e => e[0] === 'combat_start'));
  assert.ok(events.some(e => e[0] === 'go_home'));
  assert.ok(events.some(e => e[0] === 'flush'));
  assert.ok(events.some(e => e[0] === 'quit' && e[1] === 'Safe disconnect'));
  assert.ok(events.some(e => e[0] === 'equip' && e[1] === 'iron_sword' && e[2] === 'hand'));
  assert.ok(events.some(e => e[0] === 'drop' && e[1] === 'cobblestone' && e[2] === 32));
});

test('DashboardServer authToken protects state, stream, and POST endpoints while leaving /api/health open', async () => {
  const received = [];
  const dash = new DashboardServer({
    host: '127.0.0.1',
    port: 0,
    authToken: 'secret-token-123',
    getState: () => ({ connected: true, state: 'IDLE', health: 20 }),
    onCommand: async (cmd) => received.push(cmd),
    log: () => {},
  });

  const addr = await dash.start();
  try {
    const base = `http://${addr.host}:${addr.port}`;

    // /api/health remains accessible without token for Docker HEALTHCHECK
    const healthRes = await fetch(`${base}/api/health`);
    assert.equal(healthRes.status, 200);

    // /api/state, /api/stream, and POST /api/command reject missing or wrong token
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/api/stream`)).status, 401);
    assert.equal((await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'theo tôi' }),
    })).status, 401);

    // Accepted via Bearer, X-Dashboard-Token, and ?token=
    const stateBearer = await fetch(`${base}/api/state`, {
      headers: { Authorization: 'Bearer secret-token-123' },
    });
    assert.equal(stateBearer.status, 200);

    const cmdHeader = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-Token': 'secret-token-123',
      },
      body: JSON.stringify({ command: 'theo tôi' }),
    });
    assert.equal(cmdHeader.status, 200);
    assert.deepEqual(received, ['theo tôi']);

    const ac = new AbortController();
    const sseQuery = await fetch(`${base}/api/stream?token=secret-token-123`, { signal: ac.signal });
    assert.equal(sseQuery.status, 200);
    await sseQuery.body.cancel().catch(() => {});
    ac.abort();
  } finally {
    await dash.stop();
  }
});

test('DashboardServer serves /api/nearby, /api/inbox, /api/say, and enriched /api/command with auth guards', async () => {
  const nearbyCalls = [];
  const inboxCalls = [];
  const sayCalls = [];
  const dash = new DashboardServer({
    host: '127.0.0.1',
    port: 0,
    authToken: 'mcp-secret',
    getState: () => ({ connected: true, health: 20 }),
    onCommand: async (cmd) => ({ parsedType: 'follow', tier: 'exact', cmd }),
    onGetNearby: async ({ radius }) => {
      nearbyCalls.push(radius);
      return { connected: true, position: { x: 1, y: 64, z: 2 }, players: [], mobs: [], items: [], blocks: {} };
    },
    getInbox: async ({ sinceId, limit }) => {
      inboxCalls.push({ sinceId, limit });
      return { latestId: 3, messages: [{ id: 3, kind: 'chat', username: 'araslime', message: 'hi' }] };
    },
    onSay: async ({ message, whisperTo }) => {
      sayCalls.push({ message, whisperTo });
      if (message === 'offline') return { ok: false, status: 409, error: 'Bot offline' };
      return { ok: true, sent: [message], whisperTo };
    },
    log: () => {},
  });

  const addr = await dash.start();
  try {
    const base = `http://${addr.host}:${addr.port}`;
    const authHeaders = { Authorization: 'Bearer mcp-secret' };

    assert.equal((await fetch(`${base}/api/nearby`)).status, 401);
    assert.equal((await fetch(`${base}/api/inbox`)).status, 401);
    assert.equal((await fetch(`${base}/api/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })).status, 401);

    const nearbyRes = await fetch(`${base}/api/nearby?radius=999`, { headers: authHeaders });
    assert.equal(nearbyRes.status, 200);
    assert.deepEqual(nearbyCalls, [64]);
    assert.equal((await nearbyRes.json()).position.x, 1);

    const inboxRes = await fetch(`${base}/api/inbox?sinceId=2&limit=5`, { headers: authHeaders });
    assert.equal(inboxRes.status, 200);
    assert.deepEqual(inboxCalls, [{ sinceId: 2, limit: 5 }]);
    assert.equal((await inboxRes.json()).latestId, 3);

    const csrfSay = await fetch(`${base}/api/say`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(csrfSay.status, 403);

    const emptySay = await fetch(`${base}/api/say`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    assert.equal(emptySay.status, 400);

    const offlineSay = await fetch(`${base}/api/say`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'offline' }),
    });
    assert.equal(offlineSay.status, 409);

    const okSay = await fetch(`${base}/api/say`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Xin chào', whisperTo: 'araslime' }),
    });
    assert.equal(okSay.status, 200);
    const okSayJson = await okSay.json();
    assert.equal(okSayJson.ok, true);
    assert.equal(okSayJson.whisperTo, 'araslime');
    assert.deepEqual(sayCalls.at(-1), { message: 'Xin chào', whisperTo: 'araslime' });

    const cmdRes = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'theo tôi' }),
    });
    assert.equal(cmdRes.status, 200);
    const cmdJson = await cmdRes.json();
    assert.equal(cmdJson.ok, true);
    assert.equal(cmdJson.result.parsedType, 'follow');
    assert.equal(cmdJson.result.tier, 'exact');
  } finally {
    await dash.stop();
  }
});

test('createDashboardBridge provides nearby scan, inbox filtering, chunked say, and command metadata', async () => {
  const tasks = new TaskCoordinator({ log: () => {} });
  const stateMachine = new BotStateMachine();
  const watchdog = new HealthWatchdog();
  const chats = [];
  const whispers = [];
  const history = [];
  const state = { connected: true, disconnected: false, aiPaused: false };

  const botPos = { x: 10, y: 64, z: 10 };
  const botEntity = { position: botPos, username: 'bot_1' };
  const blockMap = new Map([
    ['12,64,10', { name: 'iron_ore' }],
    ['14,64,10', { name: 'iron_ore' }],
    ['11,64,12', { name: 'crafting_table' }],
    ['15,65,10', { name: 'oak_log' }],
    ['13,64,11', { name: 'white_bed' }],
    ['12,63,10', { name: 'stone' }],
  ]);

  const ctx = {
    bot: {
      username: 'bot_1',
      health: 20,
      food: 20,
      game: { dimension: 'overworld' },
      entity: botEntity,
      entities: {
        self: botEntity,
        owner: { type: 'player', username: 'araslime', position: { x: 13, y: 64, z: 10 } },
        farPlayer: { type: 'player', username: 'stranger', position: { x: 100, y: 64, z: 100 } },
        mob1: { type: 'mob', name: 'zombie', kind: 'Hostile mobs', position: { x: 16, y: 64, z: 10 } },
        drop1: { type: 'object', name: 'item', displayName: 'item', position: { x: 11, y: 64, z: 11 } },
      },
      findBlocks: ({ matching, maxDistance }) => {
        assert.ok(maxDistance <= 32);
        const out = [];
        for (const [key, blk] of blockMap.entries()) {
          if (matching(blk)) {
            const [x, y, z] = key.split(',').map(Number);
            out.push({ x, y, z });
          }
        }
        return out;
      },
      blockAt: ({ x, y, z }) => blockMap.get(`${x},${y},${z}`) ?? null,
      inventory: { slots: [], items: () => [] },
      chat: (m) => chats.push(m),
      whisper: (u, m) => whispers.push([u, m]),
    },
    config: { minecraft: { host: 'localhost', port: 25565 }, owner: 'araslime' },
    llm: {},
    memory: { queryPois: () => [] },
    tasks,
    router: { route: () => ({ command: { type: 'follow' }, tier: 'exact' }) },
    equipment: { status: () => ({ equipped: {} }) },
    home: { listChestInventory: () => ({}) },
    combat: {},
    stateMachine,
    watchdog,
    logger: { recent: () => [] },
    logFor: () => () => {},
    state,
    inboxState: {
      seq: 3,
      items: [
        { id: 1, kind: 'spawn', message: 'joined' },
        { id: 2, kind: 'chat', username: 'araslime', message: 'di dao sat' },
        { id: 3, kind: 'whisper', username: 'araslime', message: 'nhanh len' },
      ],
    },
    pushChatHistory: (role, text) => history.push([role, text]),
    handleCommand: async () => {},
  };

  const bridge = createDashboardBridge(ctx);
  const nearby = bridge.getNearby({ radius: 20 });
  assert.equal(nearby.connected, true);
  assert.equal(nearby.dimension, 'overworld');
  assert.deepEqual(nearby.ownerPosition, { x: 13, y: 64, z: 10 });
  assert.equal(nearby.players.length, 1);
  assert.equal(nearby.mobs.length, 1);
  assert.equal(nearby.mobs[0].name, 'zombie');
  assert.equal(nearby.items.length, 1);
  assert.equal(nearby.blocks.iron_ore.count, 2);
  assert.deepEqual(nearby.blocks.iron_ore.nearest, { x: 12, y: 64, z: 10, distance: 2 });
  assert.equal(nearby.blocks.crafting_table.count, 1);
  assert.equal(nearby.blocks.oak_log.count, 1);
  assert.equal(nearby.blocks.white_bed.count, 1);
  assert.equal(nearby.blocks.stone, undefined);

  const inboxAll = bridge.getInbox({ sinceId: 1, limit: 10 });
  assert.equal(inboxAll.latestId, 3);
  assert.deepEqual(inboxAll.messages.map(m => m.id), [2, 3]);

  const inboxLatest = bridge.getInbox({ sinceId: 1, limit: 1 });
  assert.deepEqual(inboxLatest.messages.map(m => m.id), [3]);

  const longMsg = `${'a'.repeat(200)} ${'b'.repeat(120)}`;
  const sayRes = await bridge.onSay({ message: longMsg });
  assert.equal(sayRes.ok, true);
  assert.equal(sayRes.sent.length, 2);
  assert.equal(chats.length, 2);
  assert.equal(history.length, 1);

  const whisperRes = await bridge.onSay({ message: 'Đã xong', whisperTo: 'araslime' });
  assert.equal(whisperRes.ok, true);
  assert.deepEqual(whispers, [['araslime', 'Đã xong']]);

  state.connected = false;
  state.disconnected = true;
  const offlineRes = await bridge.onSay({ message: 'test' });
  assert.equal(offlineRes.ok, false);
  assert.equal(offlineRes.status, 409);

  const cmdMeta = await bridge.onCommand('theo tôi');
  assert.equal(cmdMeta.parsedType, 'follow');
  assert.equal(cmdMeta.tier, 'exact');
  assert.equal(cmdMeta.activeTask, 'rảnh');
});
