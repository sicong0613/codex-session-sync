// src/logger.js — simple structured logger with daily file rotation
import { createWriteStream, mkdirSync, existsSync, renameSync, statSync } from 'fs';
import { resolve, dirname } from 'path';

const LEVELS = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 };

export class Logger {
  constructor({ level = 'INFO', file, format = 'text', max_file_size_mb = 10 } = {}) {
    this.level = LEVELS[level] ?? LEVELS.INFO;
    this.format = format;
    this.maxBytes = max_file_size_mb * 1024 * 1024;
    this._stream = null;
    this._filePath = file ? resolve(file) : null;
    this._currentDate = null;
    if (this._filePath) {
      mkdirSync(dirname(this._filePath), { recursive: true });
      this._openStream();
    }
  }

  _dateTag() { return new Date().toISOString().slice(0, 10); }

  _openStream() {
    const today = this._dateTag();
    if (this._stream) { try { this._stream.end(); } catch {} }
    const p = this._filePath.replace(/\.log$/, '') + `-${today}.log`;
    this._stream = createWriteStream(p, { flags: 'a', encoding: 'utf8' });
    this._currentDate = today;
    this._activeFile = p;
  }

  _rotate() {
    const today = this._dateTag();
    if (today !== this._currentDate) { this._openStream(); return; }
    if (this._activeFile && existsSync(this._activeFile)) {
      try {
        const { size } = statSync(this._activeFile);
        if (size > this.maxBytes) this._openStream();
      } catch {}
    }
  }

  _write(lvl, msg, data) {
    if (LEVELS[lvl] < this.level) return;
    const ts = new Date().toISOString();
    let line;
    if (this.format === 'json') {
      line = JSON.stringify({ ts, level: lvl, msg, ...data }) + '\n';
    } else {
      const extras = data && Object.keys(data).length
        ? ' ' + Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
        : '';
      line = `${ts} [${lvl}] ${msg}${extras}\n`;
    }
    process.stderr.write(line);
    if (this._stream) { this._rotate(); this._stream.write(line); }
  }

  debug(msg, data) { this._write('DEBUG', msg, data); }
  info(msg, data)  { this._write('INFO',  msg, data); }
  warn(msg, data)  { this._write('WARNING', msg, data); }
  error(msg, data) { this._write('ERROR', msg, data); }
}

// default singleton — replaced by server after config load
export const log = new Logger();
