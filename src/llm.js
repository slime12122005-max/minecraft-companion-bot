const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';

export const COMBAT_QUESTIONS = Object.freeze({
  tactic: {
    type: 'choice',
    instructions: 'Chọn chiến thuật combat phù hợp nhất hiện tại.',
    criteria: {
      melee: 'Tấn công cận chiến bằng kiếm/rìu khi ở gần và an toàn.',
      shield: 'Giơ khiên chặn nguy hiểm, đặc biệt creeper ở gần (< 4 block) hoặc bị bắn xa.',
      bow: 'Bắn cung từ khoảng cách xa (> 4 block) khi có cung và tên.',
      retreat: 'Rút lui khi máu thấp hoặc bị đông quái bao vây.',
      idle: 'Không hành động, quan sát.',
    },
  },
  focus: {
    type: 'choice',
    instructions: 'Nên ưu tiên xử lý mối đe dọa nào trước?',
    criteria: {
      creeper: 'Creeper ở gần sắp nổ.',
      ranged: 'Quái bắn xa như skeleton, pillager, blaze.',
      hurting_owner: 'Quái đang đứng gần hoặc tấn công chủ nhân.',
      closest: 'Quái đứng gần bot nhất.',
    },
  },
  danger: {
    type: 'score',
    instructions: 'Đánh giá mức độ nguy hiểm hiện tại của bot.',
    criteria: ['low', 'medium', 'high', 'critical'],
  },
  urgentRetreat: {
    type: 'noul',
    instructions: 'Tình huống có quá nguy hiểm đến mức phải rút lui ngay lập tức không?',
    criteria: { true: 'Rất nguy hiểm, cần rút lui.', false: 'Vẫn kiểm soát được.' },
  },
});

export const SURVIVAL_REACTION_QUESTIONS = Object.freeze({
  action: {
    type: 'choice',
    instructions: 'Bot đang gặp nguy hiểm trong lúc làm việc, nên xử lý nhanh thế nào?',
    criteria: {
      continue: 'Tiếp tục tác vụ sau khi tự vệ xong.',
      return_home: 'Hủy tác vụ hiện tại và rút về nhà an toàn.',
      escalate_antigravity: 'Báo động khẩn để Antigravity lập kế hoạch lại.',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'Mức độ khẩn cấp của tình huống hiện tại.',
    criteria: ['low', 'medium', 'high', 'critical'],
  },
  abortTask: {
    type: 'noul',
    instructions: 'Có cần hủy ngay tác vụ hiện tại để ưu tiên sinh tồn không?',
    criteria: { true: 'Cần hủy tác vụ để bảo toàn mạng.', false: 'Không cần hủy.' },
  },
});

export class JevClient {
  constructor({
    model = 'jev-latest',
    baseUrl = DEFAULT_JEV_BASE_URL,
    apiKey,
    timeoutMs = 6000,
    maxRequestsPerMin = 0,
  } = {}) {
    this.provider = 'typesafe';
    this.model = model || 'jev-latest';
    this.baseUrl = String(baseUrl || DEFAULT_JEV_BASE_URL).trim() || DEFAULT_JEV_BASE_URL;
    this.apiKey = apiKey;
    this.timeoutMs = Math.max(10, Number(timeoutMs) || 6000);
    this.maxRequestsPerMin = Math.max(0, Number(maxRequestsPerMin) || 0);
    this._requestTimestamps = [];
    this._stats = { requests: 0, rateLimited: 0, errors: 0, totalLatencyMs: 0 };
  }

  isAvailable() {
    return Boolean(this.apiKey);
  }

  stats() {
    const completed = Math.max(1, this._stats.requests - this._stats.errors);
    return {
      requests: this._stats.requests,
      rateLimited: this._stats.rateLimited,
      errors: this._stats.errors,
      avgLatencyMs: this._stats.requests > 0 ? Math.round(this._stats.totalLatencyMs / completed) : 0,
    };
  }

  _checkRateLimit() {
    const now = Date.now();
    const cutoff = now - 60000;
    while (this._requestTimestamps.length > 0 && this._requestTimestamps[0] <= cutoff) {
      this._requestTimestamps.shift();
    }
    if (this.maxRequestsPerMin > 0 && this._requestTimestamps.length >= this.maxRequestsPerMin) {
      this._stats.rateLimited += 1;
      throw new Error('Jev rate limit exceeded');
    }
    this._requestTimestamps.push(now);
    this._stats.requests += 1;
  }

  async _fetchJson(url, options, signal, timeoutMs) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('Jev timeout')), timeoutMs) : null;
    timer?.unref?.();

    let onControllerAbort = null;
    const abortRace = new Promise((_, reject) => {
      onControllerAbort = () => reject(controller.signal.reason ?? new Error('Jev timeout'));
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
        throw new Error(`Jev ${res.status}: ${text}`);
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

  async ask({ state, questions, signal, timeoutMs = this.timeoutMs } = {}) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Jev aborted');
    }
    this._checkRateLimit();
    const startedAt = Date.now();
    const url = new URL('/v1/systemone', this.baseUrl).toString();
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    try {
      const data = await this._fetchJson(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: this.model, state, questions }),
        },
        signal,
        timeoutMs
      );
      this._stats.totalLatencyMs += Date.now() - startedAt;
      return data;
    } catch (err) {
      this._stats.errors += 1;
      throw err;
    }
  }

  async chooseCombat(jevState, { signal, timeoutMs } = {}) {
    const res = await this.ask({
      state: jevState,
      questions: COMBAT_QUESTIONS,
      signal,
      timeoutMs,
    });
    return {
      action: res?.answers?.tactic?.choice ?? 'melee',
      confidence: res?.answers?.tactic?.confidence ?? null,
      probabilities: res?.answers?.tactic?.probabilities ?? null,
      focus: res?.answers?.focus?.choice ?? null,
      danger: res?.answers?.danger?.score ?? null,
      urgentRetreat: res?.answers?.urgentRetreat?.noul ?? null,
    };
  }

  async chooseSurvivalAction(situation, { signal, timeoutMs } = {}) {
    const res = await this.ask({
      state: situation,
      questions: SURVIVAL_REACTION_QUESTIONS,
      signal,
      timeoutMs,
    });
    return {
      action: res?.answers?.action?.choice ?? 'continue',
      confidence: res?.answers?.action?.confidence ?? null,
      urgency: res?.answers?.urgency?.score ?? null,
      abortTask: res?.answers?.abortTask?.noul ?? null,
    };
  }
}

export { JevClient as LLMClient };

export function plannerPrompt(state, questions) {
  return {
    model: 'jev-latest',
    state: JSON.stringify(state),
    questions,
  };
}

export default JevClient;
