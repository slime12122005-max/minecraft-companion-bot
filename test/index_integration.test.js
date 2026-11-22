import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveApiKeyEnv, parseCliPort, persistLanConfig } from '../src/index.js';

test('index helpers resolve TYPESAFE_API_KEY env, parse CLI ports, and persist LAN config safely', async () => {
  assert.equal(resolveApiKeyEnv(), 'TYPESAFE_API_KEY');
  assert.equal(resolveApiKeyEnv({ provider: 'typesafe' }), 'TYPESAFE_API_KEY');
  assert.equal(resolveApiKeyEnv({ apiKeyEnv: 'CUSTOM_JEV_KEY' }), 'CUSTOM_JEV_KEY');

  assert.equal(parseCliPort(['node', 'src/index.js', '--port', '55123']), 55123);
  assert.equal(parseCliPort(['node', 'src/index.js', '--port=55124']), 55124);
  assert.equal(parseCliPort(['node', 'src/index.js', '--port=99999']), null);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-idx-cfg-'));
  const file = path.join(dir, 'config.json');
  try {
    await fs.writeFile(file, JSON.stringify({ llm: { provider: 'typesafe', model: 'jev-latest' } }));
    persistLanConfig({
      minecraft: { host: '127.0.0.1', port: 25565, username: 'b1', version: '1.21.1' },
      owner: 'araslime',
    }, file);

    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.minecraft.port, 25565);
    assert.equal(saved.minecraft.host, '127.0.0.1');
    assert.equal(saved.owner, 'araslime');
    assert.equal(saved.llm.model, 'jev-latest');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('src/index.js --doctor integration check runs cleanly and reports Antigravity MCP & Jev', () => {
  const output = execFileSync(process.execPath, ['src/index.js', '--doctor'], {
    encoding: 'utf8',
  });
  assert.match(output, /=== KIỂM TRA HỆ THỐNG BOT ===/);
  assert.match(output, /System 1 \(Jev hỗ trợ phản ứng nhanh\)/);
  assert.match(output, /System 2 \(Não chính Antigravity MCP\)/);
});
