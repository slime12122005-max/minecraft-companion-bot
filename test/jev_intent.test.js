import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '../src/jev_intent.js';
import { LLMClient } from '../src/llm.js';

test('classifyIntent translates high-confidence Vietnamese natural chat into CommandRouter commands', async () => {
  const mockLlm = {
    ask: async () => ({
      answers: {
        intent: { choice: 'give', confidence: 0.99 },
        resource: { choice: 'banh_mi', confidence: 1 },
      },
    }),
  };
  const res = await classifyIntent(mockLlm, 'ê đói quá vứt cho tao 5 ổ bánh mì coi');
  assert.deepEqual(res.command, { type: 'give', count: 5, target: 'banh mi' });
  assert.equal(res.confidence, 0.99);

  const gatherDeliverLlm = {
    ask: async () => ({
      answers: {
        intent: { choice: 'gather', confidence: 0.96 },
        resource: { choice: 'go', confidence: 0.95 },
      },
    }),
  };
  const deliverRes = await classifyIntent(gatherDeliverLlm, 'bạn đi chặt cây cho tôi với');
  assert.deepEqual(deliverRes.command, {
    type: 'chain',
    steps: [
      { type: 'gather', count: 16, target: 'go' },
      { type: 'give', count: 'all', target: 'go' },
    ],
  });
});

test('classifyIntent rejects low-confidence or unknown intents safely', async () => {
  const lowConf = {
    ask: async () => ({
      answers: {
        intent: { choice: 'gather', confidence: 0.32 },
        resource: { choice: 'go', confidence: 0.8 },
      },
    }),
  };
  assert.equal(await classifyIntent(lowConf, 'hôm nay trời đẹp quá'), null);

  const unknown = {
    ask: async () => ({
      answers: {
        intent: { choice: 'unknown', confidence: 0.95 },
        resource: { choice: 'none', confidence: 1 },
      },
    }),
  };
  assert.equal(await classifyIntent(unknown, 'haha vui quá'), null);

  let called = false;
  const shouldNotCall = {
    ask: async () => {
      called = true;
      return { answers: { intent: { choice: 'gather', confidence: 0.99 } } };
    },
  };
  assert.equal(await classifyIntent(shouldNotCall, 'đừng đào đá nữa chạy lại đây đưa sắt cho mk'), null);
  assert.equal(await classifyIntent(shouldNotCall, 'lấy 4 gỗ ; về nhà'), null);
  assert.equal(called, false);
});

test('live Jev intent classification smoke test (enabled when RUN_LIVE_JEV=1)', {
  skip: process.env.RUN_LIVE_JEV !== '1' || !process.env.TYPESAFE_API_KEY,
}, async () => {
  const client = new LLMClient({ apiKey: process.env.TYPESAFE_API_KEY, timeoutMs: 10000 });
  const res = await classifyIntent(client, 'ê đói quá vứt cho tao 5 ổ bánh mì coi');
  assert.deepEqual(res?.command, { type: 'give', count: 5, target: 'banh mi' });
});
