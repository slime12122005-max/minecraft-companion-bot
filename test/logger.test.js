import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../src/logger.js';

test('Logger appends formatted lines to file and rotates when maxBytes exceeded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-log-'));
  const file = path.join(dir, 'bot.log');
  try {
    const logger = new Logger({ file, maxBytes: 80, consoleOutput: false });
    logger.scoped('bot')('first line message that is fairly long');
    logger.warn('combat', 'second line triggers rotation on third');
    logger.error('fatal', new Error('boom'));

    const current = await fs.readFile(file, 'utf8');
    const rotated = await fs.readFile(`${file}.1`, 'utf8');
    assert.match(current, /\[ERR\] \[fatal\]/);
    assert.match(rotated, /\[INFO\] \[bot\]/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Logger supports multi-file rotation up to maxFiles', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-log-multi-'));
  const file = path.join(dir, 'bot.log');
  try {
    const logger = new Logger({ file, maxBytes: 40, maxFiles: 3, consoleOutput: false });
    for (let i = 1; i <= 5; i++) {
      logger.scoped('bot')(`line-${i}-payload-that-triggers-rotation`);
    }

    const exists = async (p) => {
      try { await fs.access(p); return true; } catch { return false; }
    };
    assert.equal(await exists(file), true);
    assert.equal(await exists(`${file}.1`), true);
    assert.equal(await exists(`${file}.2`), true);
    assert.equal(await exists(`${file}.3`), true);
    assert.equal(await exists(`${file}.4`), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Logger supports ndjson disk format and structured recentEntries()', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-log-ndjson-'));
  const file = path.join(dir, 'bot.log');
  try {
    const logger = new Logger({ file, format: 'ndjson', consoleOutput: false });
    logger.scoped('ai')('started');
    logger.warn('net', 'slow ping');

    const raw = (await fs.readFile(file, 'utf8')).trim().split('\n');
    assert.equal(raw.length, 2);
    const parsed0 = JSON.parse(raw[0]);
    const parsed1 = JSON.parse(raw[1]);
    assert.equal(parsed0.level, 'INFO');
    assert.equal(parsed0.tag, 'ai');
    assert.equal(parsed0.msg, 'started');
    assert.equal(parsed1.level, 'WARN');
    assert.equal(parsed1.tag, 'net');
    assert.equal(parsed1.msg, 'slow ping');

    const entries = logger.recentEntries(5);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].tag, 'ai');
    assert.match(entries[1].line, /\[WARN\] \[net\] slow ping/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Logger stdioMode writes all console output to stderr without touching stdout', () => {
  const stderrOut = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  const origConsoleLog = console.log;
  const stdoutCalls = [];
  process.stderr.write = (chunk) => {
    stderrOut.push(String(chunk));
    return true;
  };
  console.log = (...a) => stdoutCalls.push(a);

  try {
    const logger = new Logger({ file: null, consoleOutput: true, stdioMode: true });
    logger.scoped('mcp')('hello stderr');
    logger.warn('mcp', 'warn stderr');
    logger.error('mcp', 'err stderr');
    assert.equal(stdoutCalls.length, 0);
    assert.equal(stderrOut.length, 3);
    assert.match(stderrOut[0], /\[mcp\] hello stderr/);
  } finally {
    process.stderr.write = origWrite;
    console.log = origConsoleLog;
  }
});
