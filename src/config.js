// src/config.js — load and validate config.yml
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';

const DEFAULTS = {
  codex_home: '~/.codex',
  machine_id: 'default',
  sync: {
    mode: 'cold',
    direction: 'bidirectional',
    compare: 'mtime_hash_fallback',
    time_tolerance_seconds: 2,
    equal_mtime_action: 'skip',
    delete_policy: 'never',
    session_mode: 'last_date_only',
  },
  conflict: { policy: 'manual_abort' },
  backup: {
    enabled: true,
    compression: 'none',
    retention_days: 30,
    max_backups: 0,
  },
  webdav: { url: '', username: '', password: '', remote_path: '/codex-sync' },
  server: { port: 7420, open_browser: true },
  logging: { level: 'INFO', file: '~/.codex-session-sync/logs/sync.log' },
};

function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~') ? resolve(homedir(), p.slice(2)) : resolve(p);
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source ?? {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(target[k] ?? {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(configPath) {
  let raw = {};
  if (configPath && existsSync(configPath)) {
    raw = yaml.load(readFileSync(configPath, 'utf8')) ?? {};
  }
  const merged = deepMerge(DEFAULTS, raw);
  // expand home in key paths
  merged.codex_home = expandHome(merged.codex_home);
  merged.logging.file = expandHome(merged.logging.file);
  // derive backup_dir next to config or in ~/.codex-session-sync
  if (!merged.backup_dir) {
    const base = configPath ? dirname(resolve(configPath)) : expandHome('~/.codex-session-sync');
    merged.backup_dir = resolve(base, 'backups');
  }
  // manifest.json 记录上次同步时每个文件的 sha256 + 双端 mtime/size，
  // 用于在不下载/少读盘的前提下判断文件内容是否真的变化过
  if (!merged.manifest_path) {
    const base = configPath ? dirname(resolve(configPath)) : expandHome('~/.codex-session-sync');
    merged.manifest_path = resolve(base, 'manifest.json');
  }
  return merged;
}

export function writeExampleConfig(dest) {
  const example = readFileSync(
    new URL('../config.example.yml', import.meta.url),
    'utf8'
  );
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, example, 'utf8');
}

export function getDefaultConfigPath() {
  return expandHome('~/.codex-session-sync/config.yml');
}
