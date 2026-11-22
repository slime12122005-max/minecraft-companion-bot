import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JevClient,
  LLMClient,
  COMBAT_QUESTIONS,
  SURVIVAL_REACTION_QUESTIONS,
  plannerPrompt,
} from '../src/llm.js';

function mockJevResponseForQuestions(questions = {}) {
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q?.type === 'choice') {
      const firstChoice = q.choices?.[0] ?? 'retreat';
      answers[key] = {
        type: 'choice',
        choice: firstChoice,
        confidence: 0.9,
        probabilities: { [firstChoice]: 0.9 },
      };
    } else if (q?.type === 'score') {
      answers[key] = { type: 'score', score: 3, confidence: 0.85 };
    } else if (q?.type === 'noul') {
      answers[key] = { type: 'noul', noul: 0.85 };
    }
  }
  return answers;
}

test('JevClient is aliased as LLMClient and reports availability from apiKey', () => {
  assert.equal(LLMClient, JevClient);
  assert.equal(new JevClient().isAvailable(), false);
  assert.equal(new JevClient({ apiKey: 'ts-key' }).isAvailable(), true);
  assert.ok(COMBAT_QUESTIONS && typeof COMBAT_QUESTIONS === 'object');
  assert.ok(SURVIVAL_REACTION_QUESTIONS && typeof SURVIVAL_REACTION_QUESTIONS === 'object');
  assert.ok(plannerPrompt);
});

test('JevClient.ask calls TypeSafe System 1 endpoint and parses probability answers', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const sampleQuestions = {
    tactic: {
      type: 'choice',
      question: 'Best tactic?',
      choices: ['shield', 'attack_melee', 'retreat'],
    },
    danger: {
      type: 'score',
      question: 'Danger level?',
      scale: '1-5',
    },
    urgentRetreat: {
      type: 'noul',
      question: 'Retreat immediately?',
    },
  };

  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return new Response(JSON.stringify({
      model: 'jev-latest',
      answers: {
        tactic: { type: 'choice', choice: 'shield', confidence: 0.92, probabilities: { shield: 0.92 } },
        danger: { type: 'score', score: 2, confidence: 0.85 },
        urgentRetreat: { type: 'noul', noul: 0.15 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const client = new JevClient({ apiKey: 'ts-key', baseUrl: 'https://api.typesafe.ai/' });
    const res = await client.ask({ state: { health: 18 }, questions: sampleQuestions });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer ts-key');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.state.health, 18);
    assert.equal(res.answers.tactic.choice, 'shield');
    assert.equal(res.answers.danger.score, 2);
    assert.equal(res.answers.urgentRetreat.noul, 0.15);
    assert.equal(client.stats().requests, 1);
    assert.equal(client.stats().errors, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JevClient.ask throws contextual Jev HTTP errors and aborts cleanly on timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });

  try {
    const client = new JevClient({ apiKey: 'bad-key', timeoutMs: 200 });
    await assert.rejects(
      client.ask({ state: {}, questions: { q: { type: 'noul', question: 'ok?' } } }),
      /Jev 401: unauthorized/
    );
    assert.equal(client.stats().errors, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });

  try {
    const client = new JevClient({ apiKey: 'ts-key', timeoutMs: 25 });
    await assert.rejects(
      client.ask({ state: {}, questions: { q: { type: 'noul', question: 'ok?' } } }),
      (err) => err?.name === 'AbortError' || /timeout/i.test(err?.message || '')
    );
    assert.equal(client.stats().errors, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JevClient chooseCombat and chooseSurvivalAction extract structured decisions', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      model: 'jev-latest',
      answers: mockJevResponseForQuestions(body.questions),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const client = new JevClient({ apiKey: 'ts-key' });
    const combat = await client.chooseCombat({ health: 10, nearbyHostiles: ['creeper'] });
    assert.ok(combat.action);
    assert.equal(typeof combat.confidence, 'number');
    assert.equal(typeof combat.danger, 'number');
    assert.equal(typeof combat.urgentRetreat, 'number');

    const survival = await client.chooseSurvivalAction({ health: 6, lavaNearby: true });
    assert.ok(survival.action);
    assert.equal(typeof survival.confidence, 'number');
    assert.equal(typeof survival.urgency, 'number');
    assert.equal(typeof survival.abortTask, 'number');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JevClient enforces per-minute rate limit and records rateLimited in stats', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'jev-latest',
    answers: { ok: { type: 'noul', noul: 0.9 } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const client = new JevClient({ apiKey: 'ts-key', maxRequestsPerMin: 2 });
    const q = { ok: { type: 'noul', question: 'Safe?' } };
    await client.ask({ state: { health: 20 }, questions: q });
    await client.ask({ state: { health: 19 }, questions: q });

    await assert.rejects(
      client.ask({ state: { health: 18 }, questions: q }),
      /rate limit exceeded/i
    );
    const stats = client.stats();
    assert.equal(stats.requests, 2);
    assert.equal(stats.rateLimited, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test(
  'live Jev smoke test (runs only when RUN_LIVE_JEV=1 and TYPESAFE_API_KEY are set)',
  { skip: !(process.env.RUN_LIVE_JEV === '1' && process.env.TYPESAFE_API_KEY) },
  async () => {
    const client = new JevClient({
      apiKey: process.env.TYPESAFE_API_KEY,
      timeoutMs: 10000,
    });
    const res = await client.chooseCombat({
      health: 8,
      food: 16,
      nearbyHostiles: [{ name: 'creeper', distance: 3 }],
    });
    assert.ok(res.action);
    assert.equal(typeof res.confidence, 'number');
  }
);
