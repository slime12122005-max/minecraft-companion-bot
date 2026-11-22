import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient } from '../src/llm.js';
import { resolvePlanOrder } from '../src/llm_prompts.js';

test('LLMClient.ask sends POST /v1/systemone with auth header and parses JSON response', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return new Response(JSON.stringify({
      model: 'jev-1.14.0',
      answers: {
        tactic: { type: 'choice', choice: 'shield' },
        targetId: { type: 'noul', noul: 0.9 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const client = new LLMClient({ model: 'jev-latest', baseUrl: 'https://api.typesafe.ai', apiKey: 'test-key' });
    const res = await client.ask({ state: { health: 20 }, questions: {} });
    assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers.Authorization, 'Bearer test-key');
    assert.equal(res.answers.tactic.choice, 'shield');
    assert.equal(res.answers.targetId.noul, 0.9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLMClient.ask throws descriptive error on HTTP failure and aborts on timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  try {
    const client = new LLMClient({ apiKey: 'bad' });
    await assert.rejects(client.ask({ state: {}, questions: {} }), /LLM 401: unauthorized/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')));
  });
  try {
    const client = new LLMClient({ timeoutMs: 20 });
    await assert.rejects(client.ask({ state: {}, questions: {} }), /timeout/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live Jev API smoke test across tactical cases (enabled when RUN_LIVE_JEV=1)', {
  skip: process.env.RUN_LIVE_JEV !== '1' || !process.env.TYPESAFE_API_KEY,
}, async () => {
  const client = new LLMClient({ apiKey: process.env.TYPESAFE_API_KEY, timeoutMs: 10000 });
  const questions = {
    tactic: {
      type: 'choice',
      instructions: 'Chọn chiến thuật combat phù hợp nhất hiện tại.',
      criteria: {
        melee: 'Tấn công cận chiến bằng kiếm/rìu khi ở gần.',
        shield: 'Giơ khiên chặn nguy hiểm, đặc biệt creeper ở gần (< 4 block).',
        bow: 'Bắn cung từ khoảng cách xa (> 4 block) khi có cung.',
        retreat: 'Rút lui khi máu thấp hoặc quá nguy hiểm.',
        idle: 'Không hành động, quan sát.',
      },
    },
    targetId: {
      type: 'noul',
      instructions: 'Có mục tiêu cụ thể cần đánh ngay không?',
      criteria: { true: 'Có mục tiêu.', false: 'Không có mục tiêu.' },
    },
  };

  const cases = [
    { name: 'creeper close with shield', state: { health: 20, target: { id: 1, name: 'creeper', distance: 2.5 }, shield: true, canBow: false } },
    { name: 'skeleton far with bow', state: { health: 20, target: { id: 2, name: 'skeleton', distance: 14 }, shield: false, canBow: true } },
    { name: 'critical health zombie', state: { health: 4, target: { id: 3, name: 'zombie', distance: 3 }, shield: false, canBow: false } },
  ];

  for (const c of cases) {
    const res = await client.ask({ state: c.state, questions });
    assert.ok(typeof res.answers?.tactic?.choice === 'string', `${c.name}: expected choice`);
    assert.ok(typeof res.answers?.targetId?.noul === 'number', `${c.name}: expected noul`);
  }
});

test('LLMClient supports openai, deepseek, and gemini chat-completion JSON adapters', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const sampleQuestions = {
    tactic: { type: 'choice', instructions: 'Pick', criteria: { melee: 'a', shield: 'b' } },
    danger: { type: 'score', instructions: 'Danger', criteria: ['low', 'medium', 'high', 'critical'] },
    urgentRetreat: { type: 'noul', instructions: 'Retreat?', criteria: { true: 'yes', false: 'no' } },
  };
  const payload = JSON.stringify({
    answers: {
      tactic: { type: 'choice', choice: 'shield', confidence: 0.92 },
      danger: { type: 'score', score: 2, confidence: 0.85 },
      urgentRetreat: { type: 'noul', noul: 0.15 },
    },
  });

  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: payload }] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const content = calls.length === 2 ? `\`\`\`json\n${payload}\n\`\`\`` : payload;
    return new Response(JSON.stringify({
      model: 'mock-chat',
      choices: [{ message: { content } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const openai = new LLMClient({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'oa-key' });
    const rOpenai = await openai.ask({ state: { health: 18 }, questions: sampleQuestions });
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer oa-key');
    assert.equal(rOpenai.answers.tactic.choice, 'shield');
    assert.equal(rOpenai.answers.danger.score, 2);
    assert.equal(rOpenai.answers.urgentRetreat.noul, 0.15);

    const deepseek = new LLMClient({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.typesafe.ai',
      apiKey: 'ds-key',
    });
    const rDeepseek = await deepseek.ask({ state: { health: 18 }, questions: sampleQuestions });
    assert.equal(calls[1].url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(rDeepseek.answers.tactic.confidence, 0.92);

    const gemini = new LLMClient({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'gm-key',
    });
    const rGemini = await gemini.ask({ state: { health: 18 }, questions: sampleQuestions });
    assert.equal(
      calls[2].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gm-key'
    );
    assert.equal(rGemini.answers.tactic.choice, 'shield');
    assert.equal(rGemini.answers.danger.score, 2);
    assert.equal(rGemini.answers.urgentRetreat.noul, 0.15);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLMClient.interpretChat rejects typesafe Jev and supports System 2 deepseek/ollama JSON plans', async () => {
  const jev = new LLMClient({ provider: 'typesafe', apiKey: 'jev-key' });
  await assert.rejects(jev.interpretChat({ message: 'chào bạn' }), /System 1/);

  const ollamaNoKey = new LLMClient({ provider: 'ollama', model: 'qwen2.5:7b' });
  assert.equal(ollamaNoKey.isAvailable(), true);
  assert.equal(new LLMClient({ provider: 'deepseek', model: 'deepseek-chat' }).isAvailable(), false);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return new Response(JSON.stringify({
      model: 'mock-chat-v2',
      choices: [{
        message: {
          content: JSON.stringify({
            reply: 'Rõ, mình chế tạo khiên rồi đào hầm ngay.',
            commands: ['chế tạo 1 khiên', 'đào hầm 16'],
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const deepseek = new LLMClient({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'ds-key' });
    const res = await deepseek.interpretChat({
      message: 'làm cho tôi 1 cái khiên xong đào hầm 16 block nhé',
      botState: { health: 20, food: 20 },
    });
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(res.reply, 'Rõ, mình chế tạo khiên rồi đào hầm ngay.');
    assert.deepEqual(res.commands, ['chế tạo 1 khiên', 'đào hầm 16']);

    await ollamaNoKey.interpretChat({ message: 'hi', botState: {} });
    assert.equal(calls[1].url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(calls[1].opts.headers.Authorization, undefined);

    const openrouter = new LLMClient({ provider: 'openrouter', model: 'openrouter/free', apiKey: 'or-key' });
    await openrouter.interpretChat({
      message: 'làm thêm cái nữa',
      botState: {},
      history: [
        { role: 'user', text: 'làm cho tôi 1 cái khiên' },
        { role: 'assistant', text: 'Rõ, mình chế tạo khiên ngay.' },
      ],
    });
    assert.equal(calls[2].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[2].opts.headers.Authorization, 'Bearer or-key');
    const body2 = JSON.parse(calls[2].opts.body);
    assert.equal(body2.response_format, undefined);
    assert.equal(body2.temperature, 0.7);
    assert.match(body2.messages[0].content, /Lịch sử hội thoại gần đây:\nChủ nhân: làm cho tôi 1 cái khiên\nBot: Rõ, mình chế tạo khiên ngay\./);
    assert.match(body2.messages[0].content, /Quy tắc phân chia nhiệm vụ/);
    assert.match(body2.messages[0].content, /"đưa tôi hết gỗ"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLMClient.humanizeReply cleans quotes/markdown/labels for OpenRouter and Gemini and rejects typesafe', async () => {
  const jev = new LLMClient({ provider: 'typesafe', apiKey: 'jev-key' });
  await assert.rejects(jev.humanizeReply({ rawEvent: 'Đã về tới nhà.' }), /System 1/);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '"Xong rồi nè, mình vừa chặt hết gỗ rồi đưa bạn 5 oak_log luôn rồi đó!"' }] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      model: 'mock-or',
      choices: [{ message: { content: 'Bot: **Ok nè**, mình về tới nhà rồi nha!' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const openrouter = new LLMClient({ provider: 'openrouter', model: 'openrouter/free', apiKey: 'or-key' });
    const rOr = await openrouter.humanizeReply({
      userMessage: 'về nhà đi',
      rawEvent: 'Đã về tới nhà.',
      botState: { health: 20, food: 18, task: 'rảnh' },
      history: [{ role: 'user', text: 'về nhà đi' }],
    });
    assert.equal(rOr.reply, 'Ok nè, mình về tới nhà rồi nha!');
    const orBody = JSON.parse(calls[0].opts.body);
    assert.equal(orBody.response_format, undefined);
    assert.equal(orBody.temperature, 0.75);

    const gemini = new LLMClient({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'gm-key' });
    const rGm = await gemini.humanizeReply({
      userMessage: 'bạn chặt cây cho tôi',
      rawEvent: 'Đã lấy xong 5 cay.; Đã đưa bạn 5 oak_log.',
      botState: { health: 20, food: 20, task: 'rảnh' },
    });
    assert.equal(rGm.reply, 'Xong rồi nè, mình vừa chặt hết gỗ rồi đưa bạn 5 oak_log luôn rồi đó!');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLMClient._fetchJson enforces timeoutMs when res.json() body stalls and interpretChat grounds suggestions/waypoints', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = opts?.body ? JSON.parse(opts.body) : null;
    return {
      ok: true,
      status: 200,
      json: () => new Promise(() => {}), // stalled body stream after headers arrived
    };
  };

  try {
    const client = new LLMClient({ provider: 'openrouter', model: 'openrouter/free', apiKey: 'or-key', timeoutMs: 40 });
    const started = Date.now();
    await assert.rejects(
      client.interpretChat({
        message: 'đề xuất cho tôi đi',
        botState: { home: null, waypoints: [], inventory: [] },
        timeoutMs: 40,
      }),
      /LLM timeout/
    );
    assert.ok(Date.now() - started < 400);
    const promptText = capturedBody?.messages?.[0]?.content ?? '';
    assert.match(promptText, /TUYỆT ĐỐI KHÔNG tự bịa điểm đến\/nhà\/rương/);
    assert.match(promptText, /"đề xuất cho tôi đi"/);
    assert.match(promptText, /"commands": \[\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLMClient supports crowllm, strips <think> blocks, and bumps humanize max_tokens', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), headers: opts.headers, body });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        model: 'particle-1:free',
        choices: [{
          message: {
            content: '<think>suy nghĩ nội bộ</think>\n{"reply":"Ok để mình đi chặt gỗ nhé.","commands":["lấy 8 gỗ"]}',
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      model: 'particle-1:free',
      choices: [{
        message: {
          content: '<think>reasoning</think>\nMình về tới nhà rồi nè!',
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const crow = new LLMClient({
      provider: 'crowllm',
      model: 'particle-1:free',
      fallbackModels: ['grok-4.7-fast:free'],
      apiKey: 'crow-key',
    });

    const chatRes = await crow.interpretChat({ message: 'chặt giùm ít gỗ', botState: {} });
    assert.equal(calls[0].url, 'https://crowllm.com/v1/chat/completions');
    assert.equal(calls[0].headers.Authorization, 'Bearer crow-key');
    assert.equal(calls[0].body.model, 'particle-1:free');
    assert.equal(calls[0].body.response_format, undefined);
    assert.equal(chatRes.reply, 'Ok để mình đi chặt gỗ nhé.');
    assert.deepEqual(chatRes.commands, ['lấy 8 gỗ']);

    const humanRes = await crow.humanizeReply({
      userMessage: 'về nhà đi',
      rawEvent: 'Đã về tới nhà.',
      botState: { health: 20, food: 20, task: 'rảnh' },
    });
    assert.equal(calls[1].url, 'https://crowllm.com/v1/chat/completions');
    assert.equal(calls[1].body.model, 'particle-1:free');
    assert.ok(calls[1].body.max_tokens >= 512);
    assert.equal(humanRes.reply, 'Mình về tới nhà rồi nè!');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLMClient falls back from particle-1:free to grok-4.7-fast:free on HTTP error or empty content, and respects AbortSignal', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let mode = 'json-http-fail';
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), model: body.model });
    if (mode === 'json-http-fail') {
      if (body.model === 'particle-1:free') {
        return new Response('rate limit', { status: 429 });
      }
      return new Response(JSON.stringify({
        model: 'grok-4.7-fast:free',
        choices: [{ message: { content: JSON.stringify({ reply: 'Chuyển sang Grok trả lời nè.', commands: ['về nhà'] }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (mode === 'json-empty-fail') {
      if (body.model === 'particle-1:free') {
        return new Response(JSON.stringify({
          model: 'particle-1:free',
          choices: [{ message: { content: '   ' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        model: 'grok-4.7-fast:free',
        choices: [{ message: { content: JSON.stringify({ reply: 'OK luôn.', commands: [] }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (mode === 'text-empty-fail') {
      if (body.model === 'particle-1:free') {
        return new Response(JSON.stringify({
          model: 'particle-1:free',
          choices: [{ message: { content: '' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        model: 'grok-4.7-fast:free',
        choices: [{ message: { content: 'Xong rồi nha!' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('aborted');
  };

  try {
    const client = new LLMClient({
      provider: 'crowllm',
      model: 'particle-1:free',
      fallbackModels: ['particle-1:free', 'grok-4.7-fast:free', 'grok-4.7-fast:free', ''],
      apiKey: 'crow-key',
    });
    assert.deepEqual(client.fallbackModels, ['grok-4.7-fast:free']);

    mode = 'json-http-fail';
    const r1 = await client.interpretChat({ message: 'về nhà', botState: {} });
    assert.equal(r1.model, 'grok-4.7-fast:free');
    assert.equal(r1.reply, 'Chuyển sang Grok trả lời nè.');
    assert.deepEqual(r1.commands, ['về nhà']);
    assert.deepEqual(calls.map(c => c.model), ['particle-1:free', 'grok-4.7-fast:free']);

    calls.length = 0;
    mode = 'json-empty-fail';
    const r2 = await client.interpretChat({ message: 'chào', botState: {} });
    assert.equal(r2.model, 'grok-4.7-fast:free');
    assert.equal(r2.reply, 'OK luôn.');
    assert.deepEqual(calls.map(c => c.model), ['particle-1:free', 'grok-4.7-fast:free']);

    calls.length = 0;
    mode = 'text-empty-fail';
    const r3 = await client.humanizeReply({ rawEvent: 'Xong.' });
    assert.equal(r3.model, 'grok-4.7-fast:free');
    assert.equal(r3.reply, 'Xong rồi nha!');
    assert.deepEqual(calls.map(c => c.model), ['particle-1:free', 'grok-4.7-fast:free']);

    calls.length = 0;
    const ac = new AbortController();
    ac.abort(new Error('caller cancelled'));
    await assert.rejects(
      client.interpretChat({ message: 'hi', botState: {}, signal: ac.signal }),
      /caller cancelled/
    );
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolvePlanOrder sorts multi-step DAGs topologically and rejects cycles', () => {
  const ordered = resolvePlanOrder([
    { id: 'mine', command: 'lấy 8 sắt', dependsOn: ['pickaxe'] },
    { id: 'pickaxe', command: 'chế tạo 1 cuốc đá', dependsOn: ['wood'] },
    { id: 'wood', command: 'lấy 4 gỗ', dependsOn: [] },
  ]);
  assert.deepEqual(ordered.map(s => s.command), ['lấy 4 gỗ', 'chế tạo 1 cuốc đá', 'lấy 8 sắt']);

  assert.throws(() => resolvePlanOrder([
    { id: 'a', command: 'lấy 4 gỗ', dependsOn: ['b'] },
    { id: 'b', command: 'chế tạo 1 cuốc gỗ', dependsOn: ['a'] },
  ]), /Cyclic task plan detected/);
});

test('LLMClient.planGoal validates DAG JSON, interpretChat flattens plan DAG, and rate limiter caps requests/min', async () => {
  const originalFetch = globalThis.fetch;
  let mode = 'plan';
  globalThis.fetch = async () => {
    if (mode === 'plan') {
      return new Response(JSON.stringify({
        model: 'particle-1:free',
        choices: [{
          message: {
            content: JSON.stringify({
              goal: 'Chuẩn bị đào sắt',
              reply: 'Để mình chặt gỗ chế tạo cuốc rồi đi đào sắt nha.',
              plan: [
                { id: 's3', command: 'lấy 8 sắt', dependsOn: ['s2'] },
                { id: 's2', command: 'chế tạo 1 cuốc đá', dependsOn: ['s1'] },
                { id: 's1', command: 'lấy 4 gỗ', dependsOn: [] },
              ],
            }),
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      model: 'particle-1:free',
      choices: [{
        message: {
          content: JSON.stringify({
            reply: 'Mình chạy theo thứ tự nhé.',
            plan: [
              { id: 'b', command: 'về nhà', dependsOn: ['a'] },
              { id: 'a', command: 'làm ruộng', dependsOn: [] },
            ],
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const client = new LLMClient({
      provider: 'crowllm',
      model: 'particle-1:free',
      apiKey: 'crow-key',
      maxRequestsPerMin: 2,
    });

    const planned = await client.planGoal({ goal: 'đào sắt', botState: {} });
    assert.deepEqual(planned.commands, ['lấy 4 gỗ', 'chế tạo 1 cuốc đá', 'lấy 8 sắt']);
    assert.equal(planned.reply, 'Để mình chặt gỗ chế tạo cuốc rồi đi đào sắt nha.');

    mode = 'chat-dag';
    const chatRes = await client.interpretChat({ message: 'làm ruộng rồi về nhà', botState: {} });
    assert.deepEqual(chatRes.commands, ['làm ruộng', 'về nhà']);

    await assert.rejects(
      client.interpretChat({ message: 'hi', botState: {} }),
      /rate limit exceeded/i
    );
    assert.equal(client.stats().requests, 2);
    assert.equal(client.stats().rateLimited, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
