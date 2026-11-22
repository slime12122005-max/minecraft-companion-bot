import fs from 'node:fs';
import path from 'node:path';

export class Logger {
  constructor({
    file = 'data/bot.log',
    maxBytes = 10 * 1024 * 1024,
    maxFiles = 5,
    format = 'text',
    consoleOutput = true,
    stdioMode = null,
    maxBuffer = 100,
  } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.maxFiles = Math.max(1, Number(maxFiles) || 1);
    this.format = format === 'ndjson' ? 'ndjson' : 'text';
    this.consoleOutput = consoleOutput;
    this.stdioMode = stdioMode != null
      ? Boolean(stdioMode)
      : (String(process.env.MCP_STDIO_MODE || '').toLowerCase() === 'true' || process.env.MCP_STDIO_MODE === '1');
    this.maxBuffer = maxBuffer;
    this.buffer = [];
    this.entries = [];
    this._dirReady = false;
  }

  _ensureDir() {
    if (!this.file || this._dirReady) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this._dirReady = true;
  }

  _rotateIfNeeded() {
    if (!this.file) return;
    try {
      const stat = fs.statSync(this.file);
      if (stat.size < this.maxBytes) return;

      if (this.maxFiles <= 1) {
        const backup = `${this.file}.1`;
        try { fs.rmSync(backup, { force: true }); } catch {}
        fs.renameSync(this.file, backup);
        return;
      }

      const oldest = `${this.file}.${this.maxFiles}`;
      try { fs.rmSync(oldest, { force: true }); } catch {}
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = `${this.file}.${i}`;
        const dst = `${this.file}.${i + 1}`;
        if (fs.existsSync(src)) {
          try { fs.renameSync(src, dst); } catch {}
        }
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {}
  }

  _format(args) {
    return args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');
  }

  write(level, tag, ...args) {
    const ts = new Date().toISOString();
    const msg = this._format(args);
    const line = `[${ts}] [${level}] [${tag}] ${msg}`;

    this.buffer.push(line);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
    }
    this.entries.push({ ts, level, tag, msg, line });
    if (this.entries.length > this.maxBuffer) {
      this.entries.shift();
    }

    if (this.consoleOutput) {
      if (this.stdioMode) {
        process.stderr.write(`[${tag}] ${msg}\n`);
      } else if (level === 'ERR') {
        console.error(`[${tag}]`, ...args);
      } else if (level === 'WARN') {
        console.warn(`[${tag}]`, ...args);
      } else {
        console.log(`[${tag}]`, ...args);
      }
    }
    if (this.file) {
      try {
        this._ensureDir();
        this._rotateIfNeeded();
        const payload = this.format === 'ndjson'
          ? `${JSON.stringify({ ts, level, tag, msg })}\n`
          : `${line}\n`;
        fs.appendFileSync(this.file, payload);
      } catch {}
    }
    return line;
  }

  recent(limit = 30) {
    return this.buffer.slice(-limit);
  }

  recentEntries(limit = 30) {
    return this.entries.slice(-limit);
  }

  scoped(tag) {
    return (...args) => this.write('INFO', tag, ...args);
  }

  warn(tag, ...args) {
    return this.write('WARN', tag, ...args);
  }

  error(tag, ...args) {
    return this.write('ERR', tag, ...args);
  }
}

export default Logger;
