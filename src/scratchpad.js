export const SCRATCHPAD_KEY = 'temp_work_scratchpad';

const PRETTY_TARGET_LABELS = Object.freeze({
  go: 'gỗ',
  da: 'đá',
  sat: 'sắt',
  than: 'than',
  vang: 'vàng',
  'kim cuong': 'kim cương',
  'ban che tao': 'bàn chế tạo',
  'lo nung': 'lò nung',
  duoc: 'đuốc',
  ruong: 'rương',
  giuong: 'giường',
  'banh mi': 'bánh mì',
});

function formatTargetLabel(target) {
  const raw = String(target ?? '').trim();
  if (!raw) return '';
  return PRETTY_TARGET_LABELS[raw.toLowerCase()] || raw;
}

export function describeParsedCommand(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const targetLabel = formatTargetLabel(parsed.target);
  switch (parsed.type) {
    case 'gather':
      return {
        label: `Lấy ${parsed.count} ${targetLabel}`,
        command: `lấy ${parsed.count} ${parsed.target}`,
      };
    case 'craft':
      return {
        label: `Chế tạo ${parsed.count} ${targetLabel}`,
        command: `chế tạo ${parsed.count} ${parsed.target}`,
      };
    case 'smelt':
      return {
        label: `Nung ${parsed.count} ${targetLabel}`,
        command: `nung ${parsed.count} ${parsed.target}`,
      };
    case 'tunnel':
      return {
        label: `Đào hầm ${parsed.length} block`,
        command: `đào hầm ${parsed.length}`,
      };
    case 'farm':
      return {
        label: 'Thu hoạch và gieo lại ruộng',
        command: 'làm ruộng',
      };
    case 'store':
      return {
        label: 'Cất đồ vào rương nhà',
        command: 'cất đồ',
      };
    case 'take_from_chest':
      return {
        label: `Lấy ${parsed.count} ${targetLabel} từ rương`,
        command: `lấy từ rương ${parsed.count} ${parsed.target}`,
      };
    case 'go_home':
      return {
        label: 'Về nhà',
        command: 'về nhà',
      };
    case 'goto':
      return {
        label: `Đi tới ${parsed.x}, ${parsed.y}, ${parsed.z}`,
        command: `đi tới ${parsed.x} ${parsed.y} ${parsed.z}`,
      };
    case 'goto_waypoint':
      return {
        label: `Đi tới điểm "${parsed.name}"`,
        command: `đi tới ${parsed.name}`,
      };
    case 'give': {
      const cntStr = parsed.count === 'all' ? 'hết' : parsed.count;
      return {
        label: `Đưa ${cntStr} ${targetLabel}`,
        command: `đưa tôi ${cntStr} ${parsed.target}`,
      };
    }
    case 'prepare': {
      const rot = parsed.rotation ? ` ${parsed.rotation}` : '';
      return {
        label: `Dọn mặt bằng ${parsed.file}`,
        command: `dọn mặt bằng ${parsed.file}${rot}`,
      };
    }
    case 'build': {
      const rot = parsed.rotation ? ` ${parsed.rotation}` : '';
      return {
        label: `Xây ${parsed.file}`,
        command: `xây ${parsed.file}${rot}`,
      };
    }
    case 'recover_death':
      return {
        label: 'Nhặt lại đồ rơi',
        command: 'nhặt đồ chết',
      };
    case 'farm_enderman':
      return {
        label: `Dựng mái che farm ${parsed.count ?? 8} Enderman`,
        command: `farm ${parsed.count ?? 8} enderman`,
      };
    default:
      return null;
  }
}

function describePlanStep(step) {
  if (!step || typeof step !== 'object') return 'Bước kế hoạch';
  if (step.type === 'command') {
    return String(step.command ?? '').trim() || 'Lệnh';
  }
  if (step.type === 'macro') {
    return `Chạy macro ${step.macro}`;
  }
  if (step.type === 'smelt') {
    return step.action === 'collect'
      ? 'Thu đồ từ lò nung'
      : `Nung ${step.count ?? 1} ${step.target ?? ''}`.trim();
  }
  if (step.type === 'say') {
    return `Nhắn "${String(step.message ?? '').slice(0, 30)}"`;
  }
  return String(step.type);
}

function hasRemainingWork(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return Boolean(
    (Array.isArray(entry.remainingSteps) && entry.remainingSteps.length > 0) ||
    entry.resumeCommand ||
    entry.buildSpec ||
    entry.macroName ||
    (Array.isArray(entry.planSteps) && entry.planSteps.length > 0)
  );
}

export class WorkScratchpad {
  constructor(memory, { sessionId = null } = {}) {
    this.memory = memory ?? null;
    this.sessionId = sessionId ? String(sessionId) : null;
  }

  _loadState() {
    const raw = this.memory?.get?.(SCRATCHPAD_KEY, null);
    if (!raw || typeof raw !== 'object') {
      return { active: null, recovery: null, manualNote: null, updatedAt: 0 };
    }
    return {
      active: raw.active ?? null,
      recovery: raw.recovery ?? null,
      manualNote: raw.manualNote ? String(raw.manualNote).trim() || null : null,
      updatedAt: Number(raw.updatedAt ?? 0),
    };
  }

  _saveState(next) {
    const clean = {
      active: next?.active ?? null,
      recovery: next?.recovery ?? null,
      manualNote: next?.manualNote ? String(next.manualNote).trim() || null : null,
      updatedAt: Date.now(),
    };
    if (!clean.active && !clean.recovery && !clean.manualNote) {
      if (typeof this.memory?.deleteDurable === 'function') {
        this.memory.deleteDurable(SCRATCHPAD_KEY);
      } else {
        this.memory?.delete?.(SCRATCHPAD_KEY);
      }
      return { active: null, recovery: null, manualNote: null, updatedAt: 0 };
    }
    if (typeof this.memory?.setDurable === 'function') {
      this.memory.setDurable(SCRATCHPAD_KEY, clean);
    } else {
      this.memory?.set?.(SCRATCHPAD_KEY, clean);
    }
    return clean;
  }

  adoptCrashState(newSessionId = this.sessionId) {
    if (newSessionId) this.sessionId = String(newSessionId);
    const data = this._loadState();
    if (data.active && data.active.sessionId !== this.sessionId) {
      if (hasRemainingWork(data.active)) {
        data.recovery = {
          ...data.active,
          crashedAt: Date.now(),
        };
      }
      data.active = null;
      this._saveState(data);
    }
    return this._loadState().recovery;
  }

  startSingleCommand(parsed, { buildSpec = null, resumingRecovery = false } = {}) {
    const desc = describeParsedCommand(parsed);
    if (!desc && !buildSpec) return null;
    const goal = desc?.label || (buildSpec?.mode === 'prepare' ? `Dọn mặt bằng ${buildSpec.file}` : `Xây ${buildSpec?.file ?? ''}`).trim();
    const data = this._loadState();
    data.active = {
      sessionId: this.sessionId,
      kind: 'single',
      goal,
      resumeCommand: desc?.command || null,
      buildSpec: buildSpec ? { ...buildSpec } : null,
      macroName: null,
      planSteps: null,
      completedSteps: [],
      remainingSteps: [goal],
      wasResumingRecovery: Boolean(resumingRecovery),
      startedAt: Date.now(),
    };
    this._saveState(data);
    return data.active;
  }

  startChain(steps, { userMessage = '', resumingRecovery = false } = {}) {
    const list = Array.isArray(steps) ? steps : [];
    const described = list.map((s) => describeParsedCommand(s));
    const labels = described.filter(Boolean).map((d) => d.label);
    const cmds = described.filter((d) => d?.command).map((d) => d.command);
    if (labels.length === 0 && cmds.length === 0) return null;

    const goal = String(userMessage || labels.join(' -> ') || 'Chuỗi công việc').trim();
    const data = this._loadState();
    data.active = {
      sessionId: this.sessionId,
      kind: 'chain',
      goal,
      resumeCommand: cmds.join(' ; ') || null,
      buildSpec: null,
      macroName: null,
      planSteps: null,
      chainDescribed: described,
      completedSteps: [],
      remainingSteps: labels,
      wasResumingRecovery: Boolean(resumingRecovery),
      startedAt: Date.now(),
    };
    this._saveState(data);
    return data.active;
  }

  markChainStepDone(stepIndex) {
    const data = this._loadState();
    if (!data.active || data.active.kind !== 'chain') return null;
    const described = Array.isArray(data.active.chainDescribed) ? data.active.chainDescribed : [];
    const doneIdx = Math.max(0, Number(stepIndex) || 0);
    const completed = described.slice(0, doneIdx + 1).filter(Boolean).map((d) => d.label);
    const rest = described.slice(doneIdx + 1).filter(Boolean);
    data.active.completedSteps = completed;
    data.active.remainingSteps = rest.map((d) => d.label);
    data.active.resumeCommand = rest.filter((d) => d.command).map((d) => d.command).join(' ; ') || null;
    this._saveState(data);
    return data.active;
  }

  startPlan({ goal = '', steps = [], resumingRecovery = false } = {}) {
    const list = Array.isArray(steps) ? steps.map((s) => ({ ...s })) : [];
    if (list.length === 0) return null;
    const allLabels = list.map((s) => describePlanStep(s));
    const data = this._loadState();
    data.active = {
      sessionId: this.sessionId,
      kind: 'plan',
      goal: String(goal || allLabels[0] || 'Kế hoạch Antigravity').trim(),
      resumeCommand: null,
      buildSpec: null,
      macroName: null,
      planSteps: list,
      originalPlanSteps: list,
      originalPlanLabels: allLabels,
      completedSteps: [],
      remainingSteps: allLabels,
      wasResumingRecovery: Boolean(resumingRecovery),
      startedAt: Date.now(),
    };
    this._saveState(data);
    return data.active;
  }

  markPlanStepDone(stepIndex) {
    const data = this._loadState();
    if (!data.active || data.active.kind !== 'plan') return null;
    const allSteps = Array.isArray(data.active.originalPlanSteps) ? data.active.originalPlanSteps : [];
    const allLabels = Array.isArray(data.active.originalPlanLabels) ? data.active.originalPlanLabels : [];
    const doneIdx = Math.max(0, Number(stepIndex) || 0);
    data.active.completedSteps = allLabels.slice(0, doneIdx + 1);
    data.active.planSteps = allSteps.slice(doneIdx + 1);
    data.active.remainingSteps = allLabels.slice(doneIdx + 1);
    this._saveState(data);
    return data.active;
  }

  startMacro({ macro, resumingRecovery = false } = {}) {
    const name = String(macro ?? '').trim();
    if (!name) return null;
    const label = `Chạy macro ${name}`;
    const data = this._loadState();
    data.active = {
      sessionId: this.sessionId,
      kind: 'macro',
      goal: label,
      resumeCommand: null,
      buildSpec: null,
      macroName: name,
      planSteps: null,
      completedSteps: [],
      remainingSteps: [label],
      wasResumingRecovery: Boolean(resumingRecovery),
      startedAt: Date.now(),
    };
    this._saveState(data);
    return data.active;
  }

  setManualTask({ goal = '', steps = [], note = null } = {}) {
    const data = this._loadState();
    const cleanNote = note != null ? String(note).trim() || null : null;
    const cleanGoal = String(goal || cleanNote || '').trim();
    const stepList = Array.isArray(steps) ? steps.map((s) => String(s).trim()).filter(Boolean) : [];
    if (cleanNote !== null) {
      data.manualNote = cleanNote;
    }
    if (cleanGoal || stepList.length > 0) {
      data.recovery = {
        sessionId: this.sessionId,
        kind: 'manual',
        goal: cleanGoal || stepList[0] || 'Việc cần nhớ',
        resumeCommand: null,
        buildSpec: null,
        macroName: null,
        planSteps: null,
        completedSteps: [],
        remainingSteps: stepList.length > 0 ? stepList : [cleanGoal],
        wasResumingRecovery: false,
        startedAt: Date.now(),
      };
    }
    this._saveState(data);
    return this.snapshot();
  }

  completeActive() {
    const data = this._loadState();
    const wasRecovery = Boolean(data.active?.wasResumingRecovery);
    if (!data.active && !wasRecovery) return this.snapshot();
    data.active = null;
    if (wasRecovery) {
      data.recovery = null;
      data.manualNote = null;
    }
    this._saveState(data);
    return this.snapshot();
  }

  clearRecovery() {
    const data = this._loadState();
    data.recovery = null;
    data.manualNote = null;
    if (data.active?.wasResumingRecovery) {
      data.active.wasResumingRecovery = false;
    }
    this._saveState(data);
    return this.snapshot();
  }

  clearAll() {
    this._saveState({ active: null, recovery: null, manualNote: null });
    return this.snapshot();
  }

  getActive() {
    return this._loadState().active;
  }

  getRecovery() {
    return this._loadState().recovery;
  }

  getManualNote() {
    return this._loadState().manualNote;
  }

  hasRecovery() {
    const data = this._loadState();
    return Boolean(data.recovery || data.manualNote);
  }

  hasPending() {
    const data = this._loadState();
    return Boolean(data.active || data.recovery || data.manualNote);
  }

  snapshot() {
    const data = this._loadState();
    return {
      active: data.active,
      recovery: data.recovery,
      manualNote: data.manualNote,
      updatedAt: data.updatedAt,
    };
  }

  formatRecoverySummary({ ownerName = '', pronouns = { self: 'tui', you: 'ông' } } = {}) {
    const data = this._loadState();
    const rec = data.recovery;
    const note = data.manualNote;
    if (!rec && !note) return null;

    const doneStr = rec?.completedSteps?.length
      ? `đã xong: ${rec.completedSteps.join(' -> ')}`
      : '';
    const goalPrefix = rec?.goal && rec.goal !== rec?.remainingSteps?.[0] ? `${rec.goal}: ` : '';
    const todoStr = rec?.remainingSteps?.length
      ? `cần làm lại: ${rec.remainingSteps.join(' -> ')}`
      : (rec?.goal ? `cần làm lại: ${rec.goal}` : '');
    const noteStr = note && note !== rec?.goal ? `ghi chú: ${note}` : '';

    const detail = [doneStr, todoStr, noteStr].filter(Boolean).join('; ');
    const body = `${goalPrefix}${detail}`;
    const who = ownerName ? ` ${ownerName} ơi` : '';
    const selfPronoun = pronouns?.self || 'tui';

    if (rec?.kind === 'manual' && !rec?.resumeCommand && !rec?.buildSpec && !rec?.planSteps?.length) {
      return `Trong bộ nhớ tạm vẫn đang ghi nhớ${who}: ${body}. Khi nào làm xong hoặc không cần nữa nhắn "bỏ việc cũ" để ${selfPronoun} xóa nha!`;
    }

    return `Lần trước máy tắt đột xuất nên còn việc dở${who}: ${body}. Nhắn "làm tiếp" để ${selfPronoun} chạy nốt hoặc "bỏ việc cũ" để xóa nha!`;
  }
}

export default WorkScratchpad;
