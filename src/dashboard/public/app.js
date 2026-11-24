const safeEsc = typeof window.esc === 'function'
  ? window.esc
  : (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getDashboardToken() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    if (fromQuery) {
      sessionStorage.setItem('dashboard_token', fromQuery);
      return fromQuery;
    }
    return sessionStorage.getItem('dashboard_token') || '';
  } catch {
    return '';
  }
}

const DASHBOARD_TOKEN = getDashboardToken();

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  if (DASHBOARD_TOKEN) {
    headers['X-Dashboard-Token'] = DASHBOARD_TOKEN;
  }
  return headers;
}

const POI_COLORS = {
  home: '#4ade80',
  chest: '#facc15',
  waypoint: '#38bdf8',
  ore: '#c084fc',
  danger_zone: '#f87171',
};

const SLOT_LABELS = [
  ['head', 'Mũ'],
  ['torso', 'Áo giáp'],
  ['legs', 'Quần'],
  ['feet', 'Giày'],
  ['offHand', 'Tay phụ'],
  ['hand', 'Tay chính'],
];

function setActionStatus(text) {
  const el = document.getElementById('actionStatus');
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

function durClass(ratio) {
  if (ratio == null || ratio >= 0.35) return 'progress-accent';
  if (ratio >= 0.15) return 'progress-warn';
  return 'progress-danger';
}

function drawRadar(position, pois) {
  const canvas = document.getElementById('radarCanvas');
  const caption = document.getElementById('radarCaption');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const maxRange = 64;
  const scale = (Math.min(w, h) / 2 - 14) / maxRange;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  for (const r of [16, 32, 64]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx, 6);
  ctx.lineTo(cx, h - 6);
  ctx.moveTo(6, cy);
  ctx.lineTo(w - 6, cy);
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('N', cx - 4, 14);
  ctx.fillText('S', cx - 3, h - 6);
  ctx.fillText('E', w - 14, cy - 4);
  ctx.fillText('W', 6, cy - 4);

  const list = Array.isArray(pois) ? pois : [];
  if (position) {
    for (const poi of list) {
      const dx = Number(poi.x ?? 0) - Number(position.x ?? 0);
      const dz = Number(poi.z ?? 0) - Number(position.z ?? 0);
      const dist = Math.hypot(dx, dz);
      const clampedDist = Math.min(dist, maxRange - 2);
      const angle = Math.atan2(dz, dx);
      const px = cx + (dist > 0 ? Math.cos(angle) * clampedDist * scale : 0);
      const py = cy + (dist > 0 ? Math.sin(angle) * clampedDist * scale : 0);
      const color = POI_COLORS[poi.category] || '#94a3b8';

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, dist <= maxRange ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();

      if (poi.label) {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(String(poi.label).slice(0, 12), px + 6, py + 3);
      }
    }
  }

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();

  if (caption) {
    caption.textContent = position
      ? `Bot tại (${position.x}, ${position.y}, ${position.z}) — ${list.length} POI đã lưu (bán kính 64 block)`
      : `Chưa có tọa độ bot — ${list.length} POI trong bộ nhớ SQLite`;
  }
}

let lastAutoLanPort = '';
let lanPortUserEdited = false;

function isRemoteHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return Boolean(h) && h !== 'localhost' && h !== '127.0.0.1' && h !== '::1';
}

function formatEndpointText(lan) {
  if (!lan) return '';
  if (lan.host && isRemoteHost(lan.host)) {
    return lan.port && lan.port !== 25565 ? `${lan.host}:${lan.port}` : lan.host;
  }
  return lan.port ? `port ${lan.port}` : '';
}

function renderState(s) {
  const connEl = document.getElementById('connStatus');
  const endpointText = formatEndpointText(s.lan);
  if (connEl) {
    connEl.textContent = s.connected
      ? '🟢 Đã vào thế giới (' + endpointText + ')'
      : '🟡 Đang chờ kết nối (' + endpointText + ')';
  }

  if (s.lan) {
    const hEl = document.getElementById('lanHost');
    const pEl = document.getElementById('lanPort');
    const oEl = document.getElementById('lanOwner');
    if (hEl && document.activeElement !== hEl && !hEl.value && s.lan.host) hEl.value = s.lan.host;
    if (pEl && document.activeElement !== pEl && !pEl.value && s.lan.port) {
      pEl.value = s.lan.port;
      lastAutoLanPort = String(s.lan.port);
    }
    if (oEl && document.activeElement !== oEl && !oEl.value && s.lan.owner) oEl.value = s.lan.owner;
  }

  const fsmEl = document.getElementById('fsmState');
  if (fsmEl) fsmEl.textContent = s.state || (s.connected ? 'IDLE' : 'OFFLINE');
  const taskEl = document.getElementById('task');
  if (taskEl) taskEl.textContent = s.task || 'rảnh';

  const clockEl = document.getElementById('worldClock');
  if (clockEl) {
    if (s.timeOfDay != null) {
      clockEl.textContent = (s.isDay === false ? '🌙 Đêm (' : '☀️ Ngày (') + s.timeOfDay + ')';
    } else {
      clockEl.textContent = '🕒 --';
    }
  }
  const xpEl = document.getElementById('xpLevel');
  if (xpEl) xpEl.textContent = 'XP Lv ' + (s.xp?.level ?? 0);

  const threatBadge = document.getElementById('threatBadge');
  if (threatBadge) {
    const score = s.threat?.score;
    threatBadge.textContent = score != null ? `Đe dọa: ${Number(score).toFixed(2)} (${s.threat.posture || '-'})` : 'An toàn';
    threatBadge.className = score >= 0.8 ? 'pill pill-danger' : (score >= 0.4 ? 'pill pill-warn' : 'pill');
  }

  const toggleBtn = document.getElementById('btnToggleAi');
  if (toggleBtn) {
    const paused = Boolean(s.aiPaused);
    toggleBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    toggleBtn.textContent = paused ? '▶ Tiếp tục AI' : '⏸ Tạm dừng AI';
  }

  const hp = Math.max(0, Math.min(20, Number(s.health ?? 0)));
  const food = Math.max(0, Math.min(20, Number(s.food ?? 0)));
  document.getElementById('hp').textContent = Math.round(hp) + '/20';
  document.getElementById('hpBar').value = hp;
  document.getElementById('food').textContent = Math.round(food) + '/20';
  document.getElementById('foodBar').value = food;
  document.getElementById('pos').textContent = s.position ? `${s.position.x}, ${s.position.y}, ${s.position.z}` : '-';
  document.getElementById('armorMit').textContent = s.armorMitigation != null ? `${Math.round(Number(s.armorMitigation) * 100)}%` : '0%';

  const wdEl = document.getElementById('watchdogInfo');
  if (wdEl) {
    if (s.watchdog) {
      wdEl.textContent = s.watchdog.healthy ? `Ổn (${s.watchdog.ticks ?? 0} tick)` : `Cảnh báo: ${s.watchdog.reason || 'kẹt'}`;
    } else {
      wdEl.textContent = '-';
    }
  }

  const lowDurEl = document.getElementById('lowDurAlerts');
  if (lowDurEl) {
    const low = Array.isArray(s.lowDurability) ? s.lowDurability : [];
    lowDurEl.innerHTML = low.length
      ? low.map(i => `<span class="pill pill-danger">${safeEsc(i.name)} (${Math.round(Number(i.ratio) * 100)}%)</span>`).join('')
      : '<span class="muted">Độ bền ổn định</span>';
  }

  const eqGrid = document.getElementById('eqGrid');
  if (eqGrid) {
    const slots = s.equipmentSlots || {};
    const fallbackEq = s.equipped || {};
    eqGrid.innerHTML = SLOT_LABELS.map(([key, label]) => {
      const entry = slots[key];
      const name = entry?.name || fallbackEq[key] || null;
      const ratio = entry?.durabilityRatio ?? 1;
      const pct = Math.round(ratio * 100);
      return `<div class="slot-box"><span class="slot-label">${safeEsc(label)}</span><strong>${name ? safeEsc(name) : '-'}</strong>` +
        (name ? `<progress class="dur-mini ${durClass(ratio)}" max="100" value="${pct}" aria-label="Độ bền ${safeEsc(name)}"></progress>` : '') + '</div>';
    }).join('');
  }

  const invEl = document.getElementById('inv');
  if (invEl) {
    const items = Array.isArray(s.inventory) ? s.inventory : [];
    invEl.innerHTML = items.length
      ? items.map((i) => {
          const ratio = i.durabilityRatio ?? 1;
          const pct = Math.round(ratio * 100);
          return `<div class="inv-row"><div class="inv-meta"><span class="inv-name">${safeEsc(i.name)} x${safeEsc(i.count)}</span>` +
            `<progress class="dur-mini ${durClass(ratio)}" max="100" value="${pct}" aria-label="Độ bền ${safeEsc(i.name)}"></progress></div>` +
            `<div class="inv-actions">` +
            `<button type="button" class="btn-secondary btn-mini" data-inv-action="equip" data-item="${safeEsc(i.name)}" data-slot="${safeEsc(i.slot ?? '')}">Đeo</button>` +
            `<button type="button" class="btn-danger btn-mini" data-inv-action="drop" data-item="${safeEsc(i.name)}" data-slot="${safeEsc(i.slot ?? '')}">Vứt</button>` +
            `</div></div>`;
        }).join('')
      : '<span class="muted">Túi đồ trống</span>';
  }

  const chestEntries = Object.entries(s.chests || {});
  document.getElementById('chests').innerHTML = chestEntries.length
    ? chestEntries.map(([k, v]) => `<span class="pill">${safeEsc(k)}: ${safeEsc(v)}</span>`).join('')
    : '<span class="muted">Chưa có dữ liệu rương</span>';

  const qEl = document.getElementById('taskQueue');
  if (qEl) {
    const tq = s.taskQueue || {};
    const activeTxt = tq.active ? `${tq.active.name} (P${tq.active.priority ?? 60}${tq.paused ? ', tạm dừng' : ''})` : 'Không có';
    const suspendedTxt = (tq.suspended || []).map(x => x.name).join(', ') || 'Không';
    const queuedTxt = (tq.queued || []).map(x => x.name).join(', ') || 'Không';
    qEl.innerHTML =
      `<div class="stat"><span>Đang chạy</span><strong>${safeEsc(activeTxt)}</strong></div>` +
      `<div class="stat"><span>Tạm hoãn</span><span>${safeEsc(suspendedTxt)}</span></div>` +
      `<div class="stat"><span>Hàng đợi</span><span>${safeEsc(queuedTxt)}</span></div>`;
  }

  if (s.brains) {
    document.getElementById('brains').innerHTML =
      `<div class="stat"><span>Não chính (System 2)</span><strong>${safeEsc(s.brains.planner || s.brains.system2 || 'Antigravity (MCP)')}</strong></div>` +
      `<div class="stat"><span>Hỗ trợ nhanh (System 1)</span><strong>${safeEsc(s.brains.tacticalSupport || s.brains.system1 || '-')}</strong></div>`;
  }

  const statsEl = document.getElementById('aiStats');
  if (statsEl && s.aiStats) {
    statsEl.textContent = `Jev Calls: ${s.aiStats.requests ?? 0} | Lỗi: ${s.aiStats.errors ?? 0} | Rate-limit: ${s.aiStats.rateLimited ?? 0}`;
  }

  if (s.jev) {
    let probsHtml = '';
    if (s.jev.probabilities) {
      probsHtml = Object.entries(s.jev.probabilities).map(([k, v]) => {
        const pct = Math.max(0, Math.min(100, Math.round(Number(v || 0) * 100)));
        return `<div class="stat"><span>${safeEsc(k)}</span><span>${pct}%</span></div>` +
          `<progress class="progress-accent" max="100" value="${pct}" aria-label="Xác suất ${safeEsc(k)}"></progress>`;
      }).join('');
    }
    document.getElementById('jev').innerHTML =
      `<div class="stat"><span>Chiến thuật</span><strong>${safeEsc(s.jev.action)} (${Math.round((s.jev.confidence ?? 0) * 100)}%)</strong></div>` +
      `<div class="stat"><span>Mục tiêu</span><span>${safeEsc(s.jev.focus || '-')}</span></div>` +
      `<div class="stat"><span>Nguy hiểm</span><span>${s.jev.danger != null ? Number(s.jev.danger).toFixed(2) : '-'}</span></div>` + probsHtml;
  }

  const threatEl = document.getElementById('threatDetails');
  if (threatEl) {
    threatEl.innerHTML = s.threat
      ? `<div class="stat"><span>Threat Score (T)</span><strong>${Number(s.threat.score ?? 0).toFixed(3)}</strong></div>` +
        `<div class="stat"><span>Tư thế</span><span>${safeEsc(s.threat.posture || '-')} (${s.threat.mobCount ?? 0} quái)</span></div>`
      : 'Không có đe dọa gần';
  }

  document.getElementById('logs').textContent = (s.logs || []).join('\n');
  drawRadar(s.position, s.pois);
}

async function refresh() {
  try {
    const r = await fetch('/api/state', { headers: apiHeaders() });
    if (r.ok) renderState(await r.json());
  } catch {}
}

async function sendControl(action, label) {
  try {
    const res = await fetch('/api/control', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    setActionStatus(res.ok ? `Đã thực hiện: ${label}` : (data.error || 'Lỗi điều khiển'));
    refresh();
  } catch (err) {
    setActionStatus('Lỗi kết nối dashboard: ' + err.message);
  }
}

function parseDashboardConnectTarget(rawHostInput, rawPortInput) {
  let host = String(rawHostInput || '').trim() || 'localhost';
  const bracketChatMatch =
    host.match(/hosted on domain\s*\[([^\]]+)\]/i) ||
    host.match(/(?:tên miền|ten mien)\s*\[([^\]]+)\]/i);
  if (bracketChatMatch) {
    host = bracketChatMatch[1].trim();
  } else {
    const portChatMatch =
      host.match(/hosted on port\s*\[?(\d{1,5})\]?/i) ||
      host.match(/(?:tại cổng|tai cong)\s*\[?(\d{1,5})\]?/i);
    if (portChatMatch) {
      host = 'localhost';
      if (!rawPortInput) rawPortInput = portChatMatch[1].trim();
    }
  }
  host = host.replace(/^(?:tcp|minecraft):\/\//i, '').replace(/\/+$/, '').trim();
  if (/^\[[^\]]+\]$/.test(host) && host.indexOf(':') === -1) {
    host = host.slice(1, -1).trim();
  }

  let inlinePort = null;
  const hostPortMatch = host.match(/^([^:\[\]]+):(\d{1,5})$/);
  if (hostPortMatch) {
    host = hostPortMatch[1].trim();
    inlinePort = Number(hostPortMatch[2]);
  }

  const isE4mc = /(?:^|\.)e4mc\.link$/i.test(host);
  const rawPortStr = String(rawPortInput || '').trim();
  let port;
  if (inlinePort != null) {
    port = inlinePort;
  } else if (!rawPortStr) {
    port = 25565;
  } else if (isE4mc && !lanPortUserEdited && rawPortStr === lastAutoLanPort && rawPortStr !== '25565') {
    port = 25565;
  } else {
    port = Number(rawPortStr);
  }
  return { host, port, isE4mc };
}

const lanHostInput = document.getElementById('lanHost');
const lanPortInput = document.getElementById('lanPort');
if (lanPortInput) {
  lanPortInput.addEventListener('input', () => {
    lanPortUserEdited = true;
  });
}
if (lanHostInput && lanPortInput) {
  lanHostInput.addEventListener('input', () => {
    const val = lanHostInput.value.trim();
    const e4mcMatch = val.match(/(?:.*\[)?([a-zA-Z0-9._-]+\.e4mc\.link)(?:\])?(?::(\d{1,5}))?$/i);
    if (e4mcMatch) {
      if (e4mcMatch[2]) {
        lanPortInput.value = e4mcMatch[2];
        lanPortUserEdited = false;
      } else if (!lanPortUserEdited) {
        lanPortInput.value = '25565';
      }
    }
  });
}

document.getElementById('lanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hEl = document.getElementById('lanHost');
  const pEl = document.getElementById('lanPort');
  const { host, port } = parseDashboardConnectTarget(hEl.value, pEl.value);
  const owner = document.getElementById('lanOwner').value.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    setActionStatus('Cổng LAN không hợp lệ (1-65535)');
    return;
  }
  hEl.value = host;
  pEl.value = String(port);
  lastAutoLanPort = String(port);
  lanPortUserEdited = false;
  const res = await fetch('/api/connect', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ host, port, owner }),
  });
  const data = await res.json().catch(() => ({}));
  setActionStatus(res.ok ? `Đang kết nối ${host}:${port}...` : (data.error || 'Không thể kết nối'));
  setTimeout(refresh, 300);
});

document.getElementById('cmdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('cmdInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  const res = await fetch('/api/command', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ command: cmd }),
  });
  setActionStatus(res.ok ? `Đã gửi lệnh: "${cmd}"` : 'Gửi lệnh thất bại');
  setTimeout(refresh, 200);
});

document.getElementById('btnToggleAi').addEventListener('click', () => sendControl('toggle_ai', 'Chuyển trạng thái AI'));
document.getElementById('btnRecallHome').addEventListener('click', () => sendControl('recall_home', 'Gọi bot về nhà khẩn'));
document.getElementById('btnDisconnect').addEventListener('click', () => sendControl('safe_disconnect', 'Ngắt kết nối an toàn'));

document.getElementById('inv').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-inv-action]');
  if (!btn) return;
  const action = btn.dataset.invAction;
  const itemName = btn.dataset.item;
  const slot = btn.dataset.slot ? Number(btn.dataset.slot) : null;
  const res = await fetch('/api/inventory/action', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action, itemName, slot }),
  });
  const data = await res.json().catch(() => ({}));
  setActionStatus(res.ok ? `Thao tác túi đồ (${action}): ${itemName}` : (data.error || 'Thao tác thất bại'));
  setTimeout(refresh, 200);
});

function startStream() {
  const sseEl = document.getElementById('sseStatus');
  if (typeof EventSource === 'undefined') {
    if (sseEl) sseEl.textContent = 'Polling';
    refresh();
    setInterval(refresh, 1000);
    return;
  }
  const es = DASHBOARD_TOKEN
    ? new EventSource(`/api/stream?token=${encodeURIComponent(DASHBOARD_TOKEN)}`)
    : new EventSource('/api/stream');
  es.onopen = () => { if (sseEl) sseEl.textContent = 'SSE Live'; };
  es.onmessage = (ev) => {
    try { renderState(JSON.parse(ev.data)); } catch {}
  };
  es.onerror = () => {
    if (sseEl) sseEl.textContent = 'SSE Retry...';
  };
}

refresh();
startStream();
