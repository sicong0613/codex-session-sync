// src/session-ops.js — 会话重命名 / 删除（同步 Codex 的三处存储）
//
// Codex 会话状态存在三处：
//   1. sessions/**/rollout-*.jsonl        会话内容本体
//   2. session_index.jsonl                codex resume 用的索引（部分会话可能缺失）
//   3. state_5.sqlite → threads 表        Codex 会话列表 UI 读取标题的权威来源
// 重命名需写 2+3（2 缺失时补建），删除需清理 1+2+3。
import {
  readFileSync, writeFileSync, renameSync, existsSync, rmSync, statSync,
} from 'fs';
import { join, isAbsolute } from 'path';

const STATE_DB = 'state_5.sqlite';

// ─── sqlite 辅助（Node 22 内建 node:sqlite）────────────────────────────────────

function openStateDb(codexHome, { readOnly = false } = {}) {
  const dbPath = join(codexHome, STATE_DB);
  if (!existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = process.getBuiltinModule('node:sqlite'));
  } catch {
    throw new Error('node:sqlite unavailable — Node.js >= 22.5 is required');
  }
  try {
    return new DatabaseSync(dbPath, { readOnly });
  } catch (err) {
    throw new Error(`Cannot open ${STATE_DB}: ${err.message} (is Codex running?)`);
  }
}

/**
 * 从 sqlite 读取全部会话标题映射 id → { title, archived }
 * 供 scanner 补全 index 里缺失的标题
 */
export function getDbTitles(codexHome) {
  const map = new Map();
  let db = null;
  try {
    db = openStateDb(codexHome, { readOnly: true });
    if (!db) return map;
    for (const row of db.prepare('SELECT id, title, archived FROM threads').all()) {
      map.set(row.id, { title: row.title, archived: !!row.archived });
    }
  } catch { /* 数据库被锁或损坏时静默降级 */ }
  finally { try { db?.close(); } catch {} }
  return map;
}

// ─── 重命名 ───────────────────────────────────────────────────────────────────

/**
 * 重命名会话：写 state_5.sqlite（Codex UI 标题）+ session_index.jsonl（resume 索引）
 * index 中不存在该会话时自动补建条目，而不是报错
 */
export function renameSession(codexHome, sessionId, newName) {
  let dbUpdated = false;
  let indexUpdated = false;

  // 1) sqlite：权威标题来源
  let db = null;
  try {
    db = openStateDb(codexHome);
    if (db) {
      const result = db.prepare(
        'UPDATE threads SET title = ? WHERE id = ?'
      ).run(newName, sessionId);
      dbUpdated = Number(result.changes ?? 0) > 0;
    }
  } finally { try { db?.close(); } catch {} }

  // 2) session_index.jsonl：更新已有条目，缺失则追加
  const indexPath = join(codexHome, 'session_index.jsonl');
  if (existsSync(indexPath)) {
    let found = false;
    const lines = readFileSync(indexPath, 'utf8').split('\n');
    const updated = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      try {
        const entry = JSON.parse(trimmed);
        if (entry.id === sessionId) {
          found = true;
          return JSON.stringify({ ...entry, thread_name: newName, updated_at: new Date().toISOString() });
        }
      } catch { /* 格式错误行原样保留 */ }
      return line;
    });

    if (!found) {
      // 补建条目（会话存在于 sqlite/rollout 但 index 缺失的情况）
      const entry = JSON.stringify({
        id: sessionId, thread_name: newName, updated_at: new Date().toISOString(),
      });
      // 保持末尾换行的整洁性
      while (updated.length && !updated[updated.length - 1].trim()) updated.pop();
      updated.push(entry, '');
    }
    indexUpdated = true;

    const tmpPath = indexPath + '.tmp';
    writeFileSync(tmpPath, updated.join('\n'), 'utf8');
    renameSync(tmpPath, indexPath);
  }

  if (!dbUpdated && !indexUpdated) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return { dbUpdated, indexUpdated };
}

// ─── 删除 ─────────────────────────────────────────────────────────────────────

/**
 * 删除会话：rollout 文件 + session_index.jsonl 条目 + sqlite threads 行
 *
 * @param {{ codexHome: string, sessionId: string, rolloutPath?: string }} params
 *   rolloutPath 可选：调用方已知的会话文件绝对路径（优先用 sqlite 里的 rollout_path）
 * @returns {{ fileDeleted, indexDeleted, dbDeleted }}
 */
export function deleteSession({ codexHome, sessionId, rolloutPath }) {
  let fileDeleted = false;
  let indexDeleted = false;
  let dbDeleted = false;

  // 1) sqlite：先取 rollout_path，再删行（threads + 关联表）
  let db = null;
  try {
    db = openStateDb(codexHome);
    if (db) {
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sessionId);
      if (row?.rollout_path && !rolloutPath) rolloutPath = row.rollout_path;

      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?')
          .run(sessionId, sessionId);
        db.prepare('DELETE FROM thread_dynamic_tools WHERE thread_id = ?').run(sessionId);
        const result = db.prepare('DELETE FROM threads WHERE id = ?').run(sessionId);
        dbDeleted = Number(result.changes ?? 0) > 0;
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  } finally { try { db?.close(); } catch {} }

  // 2) rollout 文件
  if (rolloutPath) {
    // sqlite 里存的可能是相对或带 \\?\ 前缀的路径
    let abs = rolloutPath.replace(/^\\\\\?\\/, '');
    if (!isAbsolute(abs)) abs = join(codexHome, abs);
    if (existsSync(abs)) {
      // 安全检查：只删除 .jsonl 文件
      if (!abs.endsWith('.jsonl')) throw new Error(`Refusing to delete non-jsonl file: ${abs}`);
      rmSync(abs);
      fileDeleted = true;
    }
  }

  // 3) session_index.jsonl 条目
  const indexPath = join(codexHome, 'session_index.jsonl');
  if (existsSync(indexPath)) {
    const lines = readFileSync(indexPath, 'utf8').split('\n');
    const kept = lines.filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      try {
        if (JSON.parse(trimmed).id === sessionId) { indexDeleted = true; return false; }
      } catch { /* 保留格式错误行 */ }
      return true;
    });
    if (indexDeleted) {
      const tmpPath = indexPath + '.tmp';
      writeFileSync(tmpPath, kept.join('\n'), 'utf8');
      renameSync(tmpPath, indexPath);
    }
  }

  if (!fileDeleted && !indexDeleted && !dbDeleted) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return { fileDeleted, indexDeleted, dbDeleted };
}
