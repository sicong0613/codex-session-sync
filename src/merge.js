// src/merge.js — 合并不同登录方式（model_provider）下的会话
//
// Codex 按 model_provider 隔离会话列表：
//   - "openai"  = ChatGPT 页面授权登录
//   - "custom"  = API key / 自定义 provider 登录
// 该字段存在两处，需同时改写：
//   1. rollout .jsonl 首行 session_meta 的 payload.model_provider
//   2. state_5.sqlite 的 threads.model_provider 列
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_DB = 'state_5.sqlite';

/**
 * 统计 codex home 里各 model_provider 的会话数量
 * @returns {{ providers: Array<{ provider, rollout_count, db_count }> }}
 */
export async function listProviders(codexHome) {
  const counts = new Map(); // provider → { rollout_count, db_count }
  const bump = (p, key) => {
    if (!p) return;
    const c = counts.get(p) ?? { rollout_count: 0, db_count: 0 };
    c[key]++;
    counts.set(p, c);
  };

  // 1) 扫描 rollout 文件首行
  const { scanCodexHome } = await import('./scanner.js');
  const { allFiles } = await scanCodexHome(codexHome);
  const rollouts = allFiles.filter(f => /^sessions\/.*\.jsonl$/.test(f.rel));
  for (const f of rollouts) {
    bump(readRolloutProvider(f.absPath), 'rollout_count');
  }

  // 2) 查询 sqlite threads 表
  const dbPath = join(codexHome, STATE_DB);
  if (existsSync(dbPath)) {
    const db = openDb(dbPath, true);
    try {
      for (const row of db.prepare(
        'SELECT model_provider p, COUNT(*) c FROM threads GROUP BY model_provider'
      ).all()) {
        const c = counts.get(row.p) ?? { rollout_count: 0, db_count: 0 };
        c.db_count = row.c;
        counts.set(row.p, c);
      }
    } finally { db.close(); }
  }

  return {
    providers: [...counts.entries()].map(([provider, c]) => ({ provider, ...c })),
  };
}

/**
 * 把 from 提供方的所有会话改写为 to 提供方
 *
 * @param {{
 *   codexHome: string,
 *   from: string,          — 源 provider（如 "openai"）
 *   to: string,            — 目标 provider（如 "custom"）
 *   dryRun?: boolean,      — true 时只统计不改写
 * }} params
 * @returns {Promise<{ rollouts_changed: number, db_rows_changed: number, files: string[] }>}
 */
export async function mergeProviders({ codexHome, from, to, dryRun = false }) {
  if (!from || !to) throw new Error('from and to providers are required');
  if (from === to) throw new Error('from and to must differ');

  const { scanCodexHome } = await import('./scanner.js');
  const { allFiles } = await scanCodexHome(codexHome);
  const rollouts = allFiles.filter(f => /^sessions\/.*\.jsonl$/.test(f.rel));

  // 1) 改写 rollout 首行
  let rollouts_changed = 0;
  const files = [];
  for (const f of rollouts) {
    if (readRolloutProvider(f.absPath) !== from) continue;
    files.push(f.rel);
    if (!dryRun) rewriteRolloutProvider(f.absPath, to);
    rollouts_changed++;
  }

  // 2) 改写 sqlite threads 表
  let db_rows_changed = 0;
  const dbPath = join(codexHome, STATE_DB);
  if (existsSync(dbPath)) {
    const db = openDb(dbPath, dryRun);
    try {
      if (dryRun) {
        const row = db.prepare(
          'SELECT COUNT(*) c FROM threads WHERE model_provider = ?'
        ).get(from);
        db_rows_changed = row?.c ?? 0;
      } else {
        const result = db.prepare(
          'UPDATE threads SET model_provider = ? WHERE model_provider = ?'
        ).run(to, from);
        db_rows_changed = Number(result.changes ?? 0);
      }
    } finally { db.close(); }
  }

  return { rollouts_changed, db_rows_changed, files };
}

// ─── 内部辅助 ─────────────────────────────────────────────────────────────────

/**
 * 打开 sqlite（Node 22 内建 node:sqlite，无需额外依赖）
 * 若 Codex 正在运行会持有锁，写打开会抛错 —— 调用方需先确认进程已关闭
 */
function openDb(dbPath, readOnly) {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(dbPath, { readOnly });
}

function requireNodeSqlite() {
  try {
    // 动态 require，避免旧 Node 版本加载模块时直接崩溃
    return process.getBuiltinModule
      ? process.getBuiltinModule('node:sqlite')
      : (() => { throw new Error('unsupported'); })();
  } catch {
    throw new Error('node:sqlite unavailable — Node.js >= 22.5 is required for merge');
  }
}

/**
 * 读取 rollout 首行的 model_provider（不整行 JSON.parse，首行可能数百 KB）
 */
function readRolloutProvider(absPath) {
  try {
    const firstLine = readFirstLine(absPath);
    const m = firstLine.match(/"model_provider"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
}

/**
 * 改写 rollout 首行的 model_provider，原子写回（tmp + rename）
 * 只替换首行的第一处匹配，其余内容原样保留
 */
function rewriteRolloutProvider(absPath, to) {
  const content = readFileSync(absPath, 'utf8');
  const nl = content.indexOf('\n');
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  const rest = nl === -1 ? '' : content.slice(nl);

  const newFirstLine = firstLine.replace(
    /("model_provider"\s*:\s*)"(?:[^"\\]|\\.)*"/,
    `$1${JSON.stringify(to)}`
  );
  if (newFirstLine === firstLine) return; // 无该字段则跳过

  const tmp = absPath + '.tmp';
  writeFileSync(tmp, newFirstLine + rest, 'utf8');
  renameSync(tmp, absPath);
}

function readFirstLine(absPath) {
  // 首行可能很大（含 base_instructions），直接整文件读到首个换行
  const content = readFileSync(absPath, 'utf8');
  const nl = content.indexOf('\n');
  return nl === -1 ? content : content.slice(0, nl);
}
