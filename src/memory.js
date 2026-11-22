import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const parseJsonSafe = (raw, fallback = null) => {
  try { return JSON.parse(raw); } catch { return fallback; }
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS spatial_pois (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, label TEXT NOT NULL, dimension TEXT DEFAULT 'overworld', x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, metadata_json TEXT, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pois_category_dim ON spatial_pois(category, dimension);
CREATE TABLE IF NOT EXISTS chest_index (chest_pos_key TEXT NOT NULL, item_name TEXT NOT NULL, item_count INTEGER NOT NULL, last_scanned_at INTEGER NOT NULL, PRIMARY KEY (chest_pos_key, item_name));
CREATE TABLE IF NOT EXISTS player_profiles (username TEXT PRIMARY KEY, trust_score REAL DEFAULT 50.0, role TEXT DEFAULT 'neutral', interaction_summary TEXT, last_seen_at INTEGER);
CREATE TABLE IF NOT EXISTS episodic_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, summary TEXT NOT NULL, x INTEGER, y INTEGER, z INTEGER, created_at INTEGER NOT NULL);
`;

export class Memory {
  constructor({ path: file = null, dbPath = null, legacyJsonPath = null, autoSaveMs = 300 } = {}) {
    const fileStr = file ? String(file) : '';
    const sqlitePrimary = Boolean(dbPath) || fileStr === ':memory:' || fileStr.endsWith('.db');
    this.dbPath = dbPath ?? (sqlitePrimary ? fileStr : ':memory:');
    this.jsonFile = sqlitePrimary ? null : (file ?? null);
    this.legacyJsonPath = legacyJsonPath ?? null;
    this.file = this.jsonFile ?? this.dbPath;
    this.autoSaveMs = autoSaveMs;
    this.cache = new Map();
    this.loaded = false;
    this.db = null;
    this._saveTimer = null;
    this._saving = Promise.resolve();
    this._dirty = false;
    if (this.dbPath === ':memory:') this._ensureDb();
  }

  _ensureDb() {
    if (this.db) return this.db;
    if (this.dbPath !== ':memory:') fsSync.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    if (this.dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA_SQL);
    return this.db;
  }

  _importJsonObj(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    for (const [key, value] of Object.entries(parsed)) {
      this.cache.set(key, value);
      this._upsertKvRow(key, value);
    }
    const h = parsed.home;
    if (h && Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.z)) {
      this.upsertPoi({ category: 'waypoint', label: 'home', dimension: String(h.dimension ?? 'overworld'), x: h.x, y: h.y, z: h.z, metadata: { isHome: true } });
    }
    if (parsed.waypoints && typeof parsed.waypoints === 'object') {
      for (const [label, pt] of Object.entries(parsed.waypoints)) {
        if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z)) {
          this.upsertPoi({ category: 'waypoint', label, dimension: 'overworld', x: pt.x, y: pt.y, z: pt.z });
        }
      }
    }
    if (parsed.chestIndex && typeof parsed.chestIndex === 'object') {
      for (const [key, entry] of Object.entries(parsed.chestIndex)) {
        if (entry?.items && typeof entry.items === 'object') {
          this.replaceChestIndex(key, entry.items);
          if (Number.isFinite(entry.x) && Number.isFinite(entry.y) && Number.isFinite(entry.z)) {
            this.upsertPoi({ category: 'chest', label: key, dimension: 'overworld', x: entry.x, y: entry.y, z: entry.z, metadata: { itemKinds: Object.keys(entry.items).length } });
          }
        }
      }
    }
  }

  _upsertKvRow(key, value) {
    const json = JSON.stringify(value === undefined ? null : value);
    this._ensureDb().prepare(
      'INSERT INTO kv_store (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at'
    ).run(String(key), json, Date.now());
  }

  async _tryReadJson(filePath) {
    try {
      return JSON.parse((await fs.readFile(filePath, 'utf8')) || '{}');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return null;
    }
  }

  async load() {
    const db = this._ensureDb();
    this.cache.clear();
    if (this.jsonFile) {
      this._importJsonObj(await this._tryReadJson(this.jsonFile));
      this.loaded = true;
      return;
    }
    for (const row of db.prepare('SELECT key, value_json FROM kv_store').all()) {
      this.cache.set(row.key, parseJsonSafe(row.value_json, null));
    }
    if (this.cache.size === 0 && this.legacyJsonPath) {
      this._importJsonObj(await this._tryReadJson(this.legacyJsonPath));
    }
    this.loaded = true;
  }

  get(key, defaultValue = undefined) {
    return this.cache.has(key) ? this.cache.get(key) : defaultValue;
  }

  set(key, value) {
    this.cache.set(key, value);
    this._upsertKvRow(key, value);
    if (this.jsonFile) {
      this._dirty = true;
      this._scheduleSave();
    }
    return value;
  }

  delete(key) {
    const removed = this.cache.delete(key);
    this._ensureDb().prepare('DELETE FROM kv_store WHERE key = ?').run(String(key));
    if (removed && this.jsonFile) {
      this._dirty = true;
      this._scheduleSave();
    }
    return removed;
  }

  upsertPoi({ category, label, dimension = 'overworld', x, y, z, metadata = null }) {
    const db = this._ensureDb();
    const cat = String(category);
    const lbl = String(label);
    const dim = String(dimension ?? 'overworld');
    const ix = Math.round(Number(x));
    const iy = Math.round(Number(y));
    const iz = Math.round(Number(z));
    const metaJson = metadata == null ? null : JSON.stringify(metadata);
    const now = Date.now();
    const existing = db.prepare('SELECT id FROM spatial_pois WHERE category = ? AND label = ? AND dimension = ?').get(cat, lbl, dim);
    let id;
    if (existing) {
      id = Number(existing.id);
      db.prepare('UPDATE spatial_pois SET x = ?, y = ?, z = ?, metadata_json = ?, updated_at = ? WHERE id = ?').run(ix, iy, iz, metaJson, now, id);
    } else {
      const res = db.prepare('INSERT INTO spatial_pois (category, label, dimension, x, y, z, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(cat, lbl, dim, ix, iy, iz, metaJson, now);
      id = Number(res.lastInsertRowid);
    }
    return { id, category: cat, label: lbl, dimension: dim, x: ix, y: iy, z: iz, metadata, updatedAt: now };
  }

  queryPois({ category = null, dimension = null, near = null, maxDistance = null, limit = 50 } = {}) {
    const db = this._ensureDb();
    const clauses = [];
    const params = [];
    if (category != null) { clauses.push('category = ?'); params.push(String(category)); }
    if (dimension != null) { clauses.push('dimension = ?'); params.push(String(dimension)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const maxRows = Math.max(1, Number(limit) || 50);
    const rows = near
      ? db.prepare(`SELECT * FROM spatial_pois ${where}`).all(...params)
      : db.prepare(`SELECT * FROM spatial_pois ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params, maxRows);

    let mapped = rows.map(r => {
      const item = {
        id: Number(r.id),
        category: r.category,
        label: r.label,
        dimension: r.dimension,
        x: Number(r.x),
        y: Number(r.y),
        z: Number(r.z),
        metadata: r.metadata_json ? parseJsonSafe(r.metadata_json, null) : null,
        updatedAt: Number(r.updated_at),
      };
      if (near && near.x != null && near.y != null && near.z != null) {
        item.distance = Math.hypot(item.x - near.x, item.y - near.y, item.z - near.z);
      }
      return item;
    });
    if (near) {
      if (maxDistance != null) mapped = mapped.filter(p => p.distance <= Number(maxDistance));
      mapped.sort((a, b) => a.distance - b.distance);
      mapped = mapped.slice(0, maxRows);
    }
    return mapped;
  }

  deletePoi({ id = null, category = null, label = null, dimension = null } = {}) {
    const clauses = [];
    const params = [];
    if (id != null) { clauses.push('id = ?'); params.push(Number(id)); }
    if (category != null) { clauses.push('category = ?'); params.push(String(category)); }
    if (label != null) { clauses.push('label = ?'); params.push(String(label)); }
    if (dimension != null) { clauses.push('dimension = ?'); params.push(String(dimension)); }
    if (!clauses.length) return 0;
    return Number(this._ensureDb().prepare(`DELETE FROM spatial_pois WHERE ${clauses.join(' AND ')}`).run(...params).changes ?? 0);
  }

  replaceChestIndex(chestPosKey, itemsObj = {}) {
    const db = this._ensureDb();
    const key = String(chestPosKey);
    const now = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM chest_index WHERE chest_pos_key = ?').run(key);
      const stmt = db.prepare('INSERT INTO chest_index (chest_pos_key, item_name, item_count, last_scanned_at) VALUES (?, ?, ?, ?)');
      for (const [itemName, rawCount] of Object.entries(itemsObj ?? {})) {
        const cnt = Math.floor(Number(rawCount ?? 0));
        if (cnt > 0) stmt.run(key, String(itemName), cnt, now);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  findChestItems(itemName) {
    const q = String(itemName ?? '').trim().toLowerCase();
    if (!q) return [];
    return this._ensureDb().prepare(
      "SELECT chest_pos_key, item_name, item_count, last_scanned_at FROM chest_index WHERE item_count > 0 AND (LOWER(item_name) = ? OR LOWER(item_name) LIKE '%' || ? || '%') ORDER BY item_count DESC"
    ).all(q, q).map(r => ({
      chestPosKey: r.chest_pos_key,
      itemName: r.item_name,
      itemCount: Number(r.item_count),
      lastScannedAt: Number(r.last_scanned_at),
    }));
  }

  listChestIndexTotals() {
    const totals = {};
    for (const r of this._ensureDb().prepare('SELECT item_name, SUM(item_count) AS total FROM chest_index WHERE item_count > 0 GROUP BY item_name').all()) {
      totals[r.item_name] = Number(r.total);
    }
    return totals;
  }

  upsertPlayerProfile(username, { trustScore, role, interactionSummary, lastSeenAt } = {}) {
    const name = String(username);
    const cur = this.getPlayerProfile(name);
    const nextTrust = trustScore !== undefined ? Number(trustScore) : (cur?.trustScore ?? 50.0);
    const nextRole = role !== undefined ? String(role) : (cur?.role ?? 'neutral');
    const nextSummary = interactionSummary !== undefined ? interactionSummary : (cur?.interactionSummary ?? null);
    const nextSeen = lastSeenAt !== undefined ? Number(lastSeenAt) : (cur?.lastSeenAt ?? Date.now());
    this._ensureDb().prepare(
      'INSERT INTO player_profiles (username, trust_score, role, interaction_summary, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET trust_score = excluded.trust_score, role = excluded.role, interaction_summary = excluded.interaction_summary, last_seen_at = excluded.last_seen_at'
    ).run(name, nextTrust, nextRole, nextSummary ?? null, nextSeen);
    return { username: name, trustScore: nextTrust, role: nextRole, interactionSummary: nextSummary, lastSeenAt: nextSeen };
  }

  getPlayerProfile(username) {
    const r = this._ensureDb().prepare('SELECT username, trust_score, role, interaction_summary, last_seen_at FROM player_profiles WHERE username = ?').get(String(username));
    return r ? {
      username: r.username,
      trustScore: Number(r.trust_score),
      role: r.role,
      interactionSummary: r.interaction_summary ?? null,
      lastSeenAt: r.last_seen_at != null ? Number(r.last_seen_at) : null,
    } : null;
  }

  adjustPlayerTrust(username, delta, { summary = null } = {}) {
    const cur = this.getPlayerProfile(username);
    const nextScore = Math.max(0, Math.min(100, (cur?.trustScore ?? 50.0) + Number(delta || 0)));
    const nextRole = cur?.role === 'owner' ? 'owner' : (nextScore >= 75 ? 'trusted' : (nextScore <= 25 ? 'hostile' : 'neutral'));
    return this.upsertPlayerProfile(username, {
      trustScore: nextScore,
      role: nextRole,
      interactionSummary: summary ?? cur?.interactionSummary ?? null,
      lastSeenAt: Date.now(),
    });
  }

  recordEvent({ eventType, summary, x = null, y = null, z = null }) {
    const now = Date.now();
    const ix = x != null ? Math.round(Number(x)) : null;
    const iy = y != null ? Math.round(Number(y)) : null;
    const iz = z != null ? Math.round(Number(z)) : null;
    const res = this._ensureDb().prepare(
      'INSERT INTO episodic_events (event_type, summary, x, y, z, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(String(eventType), String(summary), ix, iy, iz, now);
    return { id: Number(res.lastInsertRowid), eventType: String(eventType), summary: String(summary), x: ix, y: iy, z: iz, createdAt: now };
  }

  recentEvents({ eventType = null, limit = 10 } = {}) {
    const db = this._ensureDb();
    const maxRows = Math.max(1, Number(limit) || 10);
    const rows = eventType != null
      ? db.prepare('SELECT * FROM episodic_events WHERE event_type = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(String(eventType), maxRows)
      : db.prepare('SELECT * FROM episodic_events ORDER BY created_at DESC, id DESC LIMIT ?').all(maxRows);
    return rows.map(r => ({
      id: Number(r.id),
      eventType: r.event_type,
      summary: r.summary,
      x: r.x != null ? Number(r.x) : null,
      y: r.y != null ? Number(r.y) : null,
      z: r.z != null ? Number(r.z) : null,
      createdAt: Number(r.created_at),
    }));
  }

  _scheduleSave() {
    if (!this.jsonFile || this.autoSaveMs <= 0) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save().catch(() => {}); }, this.autoSaveMs);
    this._saveTimer.unref?.();
  }

  async save() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.jsonFile) { this._dirty = false; return this._saving; }
    this._saving = this._saving.then(async () => {
      await fs.mkdir(path.dirname(this.jsonFile), { recursive: true });
      await fs.writeFile(this.jsonFile, JSON.stringify(Object.fromEntries(this.cache), null, 2));
      this._dirty = false;
    });
    return this._saving;
  }

  async flush() {
    if (this._saveTimer || this._dirty) await this.save();
    else await this._saving;
  }

  close() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this.db) { try { this.db.close(); } catch {} this.db = null; }
  }
}
