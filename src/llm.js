import {
  GoalPlanResponseSchema,
  InterpretChatResponseSchema,
  buildGoalPlanPrompt,
  buildHumanizePrompt,
  buildInterpretChatPrompt,
  cleanChatText,
  normalizeAnswers,
  parseJsonResponse,
  resolvePlanOrder,
} from './llm_prompts.js';

const DEFAULT_BASE_URLS = {
  typesafe: 'https://api.typesafe.ai',
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  crowllm: 'https://crowllm.com/v1',
  chatfree: 'https://api.xingchiapi.com',
  ollama: 'http://127.0.0.1:11434',
};

const OPENAI_COMPAT_PROVIDERS = new Set(['openai', 'deepseek', 'openrouter', 'crowllm', 'chatfree', 'ollama']);

function resolveBaseUrl(provider, baseUrl) {
  const fallback = DEFAULT_BASE_URLS[provider] ?? DEFAULT_BASE_URLS.typesafe;
  if (!baseUrl) return fallback;
  if (provider !== 'typesafe' && baseUrl === DEFAULT_BASE_URLS.typesafe) {
    return fallback;
  }
  return baseUrl;
}

export class LLMClient {
  constructor({
    provider = 'typesafe',
    model = 'jev-latest',
    fallbackModels = [],
    baseUrl,
    apiKey,
    timeoutMs = 6000,
    maxRequestsPerMin = 0,
    cacheTtlMs = 0,
  } = {}) {
    this.provider = String(provider || 'typesafe').toLowerCase();
    this.model = model;
    this.fallbackModels = Array.isArray(fallbackModels)
      ? [...new Set(fallbackModels.map(m => String(m ?? '').trim()).filter(m => m && m !== model))]
      : [];
    this.baseUrl = resolveBaseUrl(this.provider, baseUrl);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.maxRequestsPerMin = Math.max(0, Number(maxRequestsPerMin) || 0);
    this.cacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0);
    this._requestTimestamps = [];
    this._responseCache = new Map();
    this._stats = { requests: 0, cacheHits: 0, rateLimited: 0, fallbacks: 0, errors: 0 };
  }

  stats() {
    return { ...this._stats };
  }

  _checkRateLimit() {
    const now = Date.now();
    const cutoff = now - 60000;
    while (this._requestTimestamps.length > 0 && this._requestTimestamps[0] <= cutoff) {
      this._requestTimestamps.shift();
    }
    if (this.maxRequestsPerMin > 0 && this._requestTimestamps.length >= this.maxRequestsPerMin) {
      this._stats.rateLimited += 1;
      throw new Error('LLM rate limit exceeded');
    }
    this._requestTimestamps.push(now);
    this._stats.requests += 1;
  }

  async _withCache(cacheKey, fn) {
    if (!(this.cacheTtlMs > 0)) return fn();
    const now = Date.now();
    const hit = this._responseCache.get(cacheKey);
    if (hit && now - hit.at < this.cacheTtlMs) {
      this._stats.cacheHits += 1;
      return hit.value;
    }
    const value = await fn();
    if (this._responseCache.size >= 64) {
      const oldestKey = this._responseCache.keys().next().value;
      this._responseCache.delete(oldestKey);
    }
    this._responseCache.set(cacheKey, { value, at: Date.now() });
    return value;
  }

  _candidateModels() {
    return [this.model, ...this.fallbackModels].filter(Boolean);
  }

  async _withModelFallback(signal, runForModel) {
    const candidates = this._candidateModels();
    if (signal?.aborted) {
      throw signal.reason ?? new Error('LLM aborted');
    }
    this._checkRateLimit();
    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('LLM aborted');
      }
      if (i > 0) this._stats.fallbacks += 1;
      try {
        return await runForModel(candidates[i]);
      } catch (err) {
        lastErr = err;
        if (signal?.aborted || i === candidates.length - 1) {
          this._stats.errors += 1;
          throw err;
        }
      }
    }
    throw lastErr ?? new Error('No LLM model configured');
  }

  isAvailable() {
    return this.provider === 'ollama' || Boolean(this.apiKey);
  }

  async _fetchJson(url, options, signal, timeoutMs) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('LLM timeout')), timeoutMs) : null;
    timer?.unref?.();

    let onControllerAbort = null;
    const abortRace = new Promise((_, reject) => {
      onControllerAbort = () => reject(controller.signal.reason ?? new Error('LLM timeout'));
      if (controller.signal.aborted) {
        onControllerAbort();
      } else {
        controller.signal.addEventListener('abort', onControllerAbort, { once: true });
      }
    });
    abortRace.catch(() => {});

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!res.ok) {
        const text = await Promise.race([res.text(), abortRace]).catch(() => '');
        throw new Error(`LLM ${res.status}: ${text}`);
      }
      const jsonPromise = res.json();
      jsonPromise.catch(() => {});
      return await Promise.race([jsonPromise, abortRace]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (onControllerAbort) controller.signal.removeEventListener('abort', onControllerAbort);
    }
  }

  async ask({ state, questions, signal, timeoutMs = this.timeoutMs }) {
    if (this.provider === 'typesafe') {
      const url = new URL('/v1/systemone', this.baseUrl).toString();
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      return this._withModelFallback(signal, (candidateModel) =>
        this._fetchJson(
          url,
          { method: 'POST', headers, body: JSON.stringify({ model: candidateModel, state, questions }) },
          signal,
          timeoutMs
        )
      );
    }
    return this._askViaChatCompletion({ state, questions, signal, timeoutMs });
  }

  async _completeJsonPrompt(prompt, signal, timeoutMs = this.timeoutMs, { temperature = 0 } = {}) {
    const base = this.baseUrl.replace(/\/+$/, '');

    if (this.provider === 'gemini') {
      return this._withModelFallback(signal, async (candidateModel) => {
        const url = `${base}/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent?key=${encodeURIComponent(this.apiKey ?? '')}`;
        const data = await this._fetchJson(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', temperature },
            }),
          },
          signal,
          timeoutMs
        );
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof rawText !== 'string' || !rawText.trim()) {
          throw new SyntaxError('Empty JSON response from LLM');
        }
        return { model: candidateModel, parsed: parseJsonResponse(rawText) };
      });
    }

    if (OPENAI_COMPAT_PROVIDERS.has(this.provider)) {
      const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      return this._withModelFallback(signal, async (candidateModel) => {
        const bodyObj = {
          model: candidateModel,
          messages: [{ role: 'user', content: prompt }],
          temperature,
        };
        if (this.provider !== 'openrouter' && this.provider !== 'crowllm') {
          bodyObj.response_format = { type: 'json_object' };
        }
        const data = await this._fetchJson(
          url,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyObj),
          },
          signal,
          timeoutMs
        );
        const rawText = data?.choices?.[0]?.message?.content;
        if (typeof rawText !== 'string' || !rawText.trim()) {
          throw new SyntaxError('Empty JSON response from LLM');
        }
        return { model: data?.model ?? candidateModel, parsed: parseJsonResponse(rawText) };
      });
    }

    throw new Error(`Unsupported LLM provider: ${this.provider}`);
  }

  async _completeTextPrompt(prompt, signal, timeoutMs = this.timeoutMs, { temperature = 0.75, maxTokens = 140 } = {}) {
    const base = this.baseUrl.replace(/\/+$/, '');

    if (this.provider === 'gemini') {
      return this._withModelFallback(signal, async (candidateModel) => {
        const url = `${base}/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent?key=${encodeURIComponent(this.apiKey ?? '')}`;
        const data = await this._fetchJson(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { temperature, maxOutputTokens: maxTokens },
            }),
          },
          signal,
          timeoutMs
        );
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (!String(text).trim()) {
          throw new Error('Empty text response from LLM');
        }
        return { model: candidateModel, text };
      });
    }

    if (OPENAI_COMPAT_PROVIDERS.has(this.provider)) {
      const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const effectiveMaxTokens = this.provider === 'crowllm' ? Math.max(maxTokens, 512) : maxTokens;
      return this._withModelFallback(signal, async (candidateModel) => {
        const data = await this._fetchJson(
          url,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: candidateModel,
              messages: [{ role: 'user', content: prompt }],
              temperature,
              max_tokens: effectiveMaxTokens,
            }),
          },
          signal,
          timeoutMs
        );
        const text = data?.choices?.[0]?.message?.content ?? '';
        if (!String(text).trim()) {
          throw new Error('Empty text response from LLM');
        }
        return { model: data?.model ?? candidateModel, text };
      });
    }

    throw new Error(`Unsupported LLM provider: ${this.provider}`);
  }

  async _askViaChatCompletion({ state, questions, signal, timeoutMs }) {
    const prompt = [
      'You are a fast Minecraft companion decision engine. Evaluate the given state and answer every question.',
      'Return ONLY a valid JSON object with shape {"answers": {<key>: ...}}:',
      '- For type "choice": {"type":"choice","choice":"<exact criteria key>","confidence":0.0..1.0}',
      '- For type "score": {"type":"score","score":0..<criteria.length-1>,"confidence":0.0..1.0}',
      '- For type "noul": {"type":"noul","noul":0.0..1.0}',
      `State: ${JSON.stringify(state)}`,
      `Questions: ${JSON.stringify(questions)}`,
    ].join('\n');

    const { model, parsed } = await this._completeJsonPrompt(prompt, signal, timeoutMs);
    return { model, answers: normalizeAnswers(parsed, questions) };
  }

  async interpretChat({ message, botState = {}, history = [], signal, timeoutMs = Math.max(this.timeoutMs, 12000) }) {
    if (this.provider === 'typesafe') {
      throw new Error('Jev (typesafe) là model so sánh xác suất System 1, không dùng để sinh ngôn ngữ tự nhiên System 2.');
    }

    const prompt = buildInterpretChatPrompt({ message, botState, history });
    return this._withCache(`chat:${prompt}`, async () => {
      const { model, parsed } = await this._completeJsonPrompt(prompt, signal, timeoutMs, { temperature: 0.7 });
      const checked = InterpretChatResponseSchema.safeParse(parsed);
      const data = checked.success ? checked.data : (parsed && typeof parsed === 'object' ? parsed : {});
      const reply = typeof data?.reply === 'string'
        ? cleanChatText(data.reply, 480)
        : '';
      let commands = Array.isArray(data?.commands)
        ? data.commands.map(c => String(c ?? '').trim()).filter(c => c && !/[<>]/.test(c)).slice(0, 5)
        : [];
      if (commands.length === 0 && Array.isArray(data?.plan) && data.plan.length > 0) {
        commands = resolvePlanOrder(data.plan, { maxSteps: 5 }).map(s => s.command);
      }
      return { model, reply, commands };
    });
  }

  async planGoal({ goal, botState = {}, memoryContext = {}, signal, timeoutMs = Math.max(this.timeoutMs, 12000) } = {}) {
    if (this.provider === 'typesafe') {
      throw new Error('Jev (typesafe) là model so sánh xác suất System 1, không dùng để lập kế hoạch System 2.');
    }
    const prompt = buildGoalPlanPrompt({ goal, botState, memoryContext });
    const { model, parsed } = await this._completeJsonPrompt(prompt, signal, timeoutMs, { temperature: 0.2 });
    const validated = GoalPlanResponseSchema.parse(parsed);
    const steps = resolvePlanOrder(validated.plan, { maxSteps: 8 });
    return {
      model,
      reply: cleanChatText(validated.reply ?? '', 220),
      steps,
      commands: steps.map(s => s.command),
    };
  }

  async humanizeReply({ userMessage = '', rawEvent = '', botState = {}, history = [], signal, timeoutMs } = {}) {
    if (this.provider === 'typesafe') {
      throw new Error('Jev (typesafe) là model so sánh xác suất System 1, không dùng để sinh ngôn ngữ tự nhiên System 2.');
    }

    const effectiveTimeoutMs = timeoutMs ?? (this.provider === 'crowllm' ? Math.max(this.timeoutMs, 10000) : 6000);
    const prompt = buildHumanizePrompt({ userMessage, rawEvent, botState, history });
    return this._withCache(`human:${prompt}`, async () => {
      const { model, text } = await this._completeTextPrompt(prompt, signal, effectiveTimeoutMs, {
        temperature: 0.75,
        maxTokens: 140,
      });
      return { model, reply: cleanChatText(text, 220) };
    });
  }
}

export function plannerPrompt(state, questions) {
  return {
    model: 'jev-latest',
    state: JSON.stringify(state),
    questions,
  };
}
