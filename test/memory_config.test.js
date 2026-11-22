import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../src/memory.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';

test('Memory persists set and delete to disk on flush', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-mem-'));
  const file = path.join(dir, 'memory.json');
  try {
    const mem1 = new Memory({ path: file, autoSaveMs: 50 });
    await mem1.load();
    mem1.set('home', { x: 1, y: 64, z: 2 });
    await mem1.flush();

    const mem2 = new Memory({ path: file, autoSaveMs: 0 });
    await mem2.load();
    assert.deepEqual(mem2.get('home'), { x: 1, y: 64, z: 2 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig deep-merges partial overrides without dropping nested defaults', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-cfg-'));
  const file = path.join(dir, 'config.json');
  try {
    await fs.writeFile(file, JSON.stringify({
      minecraft: { port: 12345 },
      llm: { jevIntervalMs: 2500 },
    }));
    const cfg = loadConfig(file);
    assert.equal(cfg.minecraft.port, 12345);
    assert.equal(cfg.minecraft.host, 'localhost');
    assert.equal(cfg.minecraft.version, '1.21.1');
    assert.equal(cfg.llm.model, 'jev-latest');
    assert.equal(cfg.combat.jevIntervalMs, 2500);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('DEFAULT_CONFIG uses crowllm particle-1:free with grok-4.7-fast:free fallback for chat and keeps typesafe for llm', () => {
  assert.equal(DEFAULT_CONFIG.llm.provider, 'typesafe');
  assert.equal(DEFAULT_CONFIG.llm.model, 'jev-latest');
  assert.equal(DEFAULT_CONFIG.chat.provider, 'crowllm');
  assert.equal(DEFAULT_CONFIG.chat.model, 'particle-1:free');
  assert.deepEqual(DEFAULT_CONFIG.chat.fallbackModels, ['grok-4.7-fast:free']);
  assert.equal(DEFAULT_CONFIG.chat.baseUrl, 'https://crowllm.com/v1');
  assert.equal(DEFAULT_CONFIG.chat.apiKeyEnv, 'CROWLLM_API_KEY');
});

test('loadConfig clears inherited crowllm defaults when chat.provider is overridden', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-cfg-provider-'));
  const file = path.join(dir, 'config.json');
  try {
    await fs.writeFile(file, JSON.stringify({
      chat: {
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    }));
    const cfg = loadConfig(file);
    assert.equal(cfg.chat.provider, 'deepseek');
    assert.equal(cfg.chat.model, 'deepseek-chat');
    assert.deepEqual(cfg.chat.fallbackModels, []);
    assert.equal(cfg.chat.baseUrl, undefined);
    assert.equal(cfg.chat.apiKeyEnv, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Memory persists kv_store to SQLite dbPath across restarts and migrates legacy memory.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-sqlite-'));
  const dbPath = path.join(dir, 'bot_memory.db');
  const legacyJsonPath = path.join(dir, 'memory.json');
  let mem1 = null;
  let mem2 = null;
  let mem3 = null;
  try {
    await fs.writeFile(legacyJsonPath, JSON.stringify({
      home: { x: 10, y: 64, z: -5, dimension: 'overworld' },
      waypoints: { mo: { x: 50, y: 12, z: 30 } },
      chestIndex: { '12,64,-4': { x: 12, y: 64, z: -4, items: { iron_ingot: 16 } } },
    }));

    mem1 = new Memory({ dbPath, legacyJsonPath });
    await mem1.load();
    assert.deepEqual(mem1.get('home'), { x: 10, y: 64, z: -5, dimension: 'overworld' });
    assert.equal(mem1.listChestIndexTotals().iron_ingot, 16);
    assert.equal(mem1.queryPois({ category: 'waypoint' }).length, 2);

    mem1.set('customKey', { ok: true });
    mem1.close();
    mem1 = null;

    mem2 = new Memory({ dbPath });
    await mem2.load();
    assert.deepEqual(mem2.get('customKey'), { ok: true });
    assert.equal(mem2.delete('customKey'), true);
    mem2.close();
    mem2 = null;

    mem3 = new Memory({ dbPath });
    await mem3.load();
    assert.equal(mem3.get('customKey'), undefined);
    mem3.close();
    mem3 = null;
  } finally {
    mem1?.close();
    mem2?.close();
    mem3?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Memory SQLite structured tables support spatial_pois, chest_index, player_profiles, and episodic_events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-sqlite-tables-'));
  const dbPath = path.join(dir, 'tables.db');
  const mem = new Memory({ dbPath });
  try {
    await mem.load();

    mem.upsertPoi({ category: 'ore_vein', label: 'diamond_1', x: 5, y: -58, z: 5, metadata: { count: 4 } });
    mem.upsertPoi({ category: 'ore_vein', label: 'iron_1', x: 40, y: 30, z: 40 });
    const nearPois = mem.queryPois({ category: 'ore_vein', near: { x: 0, y: -58, z: 0 }, maxDistance: 15 });
    assert.equal(nearPois.length, 1);
    assert.equal(nearPois[0].label, 'diamond_1');
    assert.deepEqual(nearPois[0].metadata, { count: 4 });
    assert.equal(mem.deletePoi({ category: 'ore_vein', label: 'iron_1' }), 1);

    mem.replaceChestIndex('overworld:10:64:10', { oak_log: 12, bread: 5 });
    mem.replaceChestIndex('overworld:14:64:10', { oak_log: 8 });
    const logs = mem.findChestItems('oak_log');
    assert.equal(logs.length, 2);
    assert.equal(mem.listChestIndexTotals().oak_log, 20);

    mem.upsertPlayerProfile('araslime', { role: 'owner', trustScore: 100 });
    assert.equal(mem.getPlayerProfile('araslime').role, 'owner');
    const guest = mem.adjustPlayerTrust('guest1', 30, { summary: 'gave food' });
    assert.equal(guest.trustScore, 80);
    assert.equal(guest.role, 'trusted');
    const hostile = mem.adjustPlayerTrust('guest1', -70);
    assert.equal(hostile.trustScore, 10);
    assert.equal(hostile.role, 'hostile');

    mem.recordEvent({ eventType: 'task_completed', summary: 'Đào xong 16 sắt', x: 5, y: 30, z: -2 });
    const events = mem.recentEvents({ limit: 5 });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'task_completed');
  } finally {
    mem.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig applies DASHBOARD_ENABLED, DASHBOARD_HOST, DASHBOARD_PORT, and DASHBOARD_TOKEN env overrides', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-cfg-dash-env-'));
  const file = path.join(dir, 'config.json');
  try {
    await fs.writeFile(file, JSON.stringify({
      dashboard: { enabled: false, host: '127.0.0.1', port: 3000 },
    }));
    const cfg = loadConfig(file, {
      env: {
        DASHBOARD_ENABLED: 'true',
        DASHBOARD_HOST: '0.0.0.0',
        DASHBOARD_PORT: '8080',
        DASHBOARD_TOKEN: 'my-secret-token',
      },
    });
    assert.equal(cfg.dashboard.enabled, true);
    assert.equal(cfg.dashboard.host, '0.0.0.0');
    assert.equal(cfg.dashboard.port, 8080);
    assert.equal(cfg.dashboard.token, 'my-secret-token');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
