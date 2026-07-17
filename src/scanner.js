// src/scanner.js — 扫描 codex home 目录，读取会话、技能、插件信息
import {
  readFileSync, writeFileSync, statSync, readdirSync, existsSync,
  openSync, readSync, closeSync, renameSync,
} from 'fs';
import { join, relative } from 'path';

// sessions 路径正则：sessions/YYYY/MM/DD/rollout-...UUID.jsonl
const SESSION_FILE_RE = /^sessions[/\\]\d{4}[/\\]\d{2}[/\\]\d{2}[/\\]rollout-.+\.jsonl$/;

/**
 * 递归遍历目录，收集所有文件的基础元数据
 * @param {string} base   codex home 根目录（用于计算 rel 路径）
 * @param {string} dir    当前目录
 * @param {Array}  acc    累积结果
 * @returns {{ rel, absPath, mtime, size }[]}
 */
function walkDir(base, dir = base, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }

  for (const ent of entries) {
    const absPath = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkDir(base, absPath, acc);
    } else if (ent.isFile()) {
      try {
        const st = statSync(absPath);
        acc.push({
          rel: relative(base, absPath).replace(/\\/g, '/'),
          absPath,
          mtime: st.mtimeMs,
          size: st.size,
        });
      } catch { /* 跳过无法 stat 的文件 */ }
    }
  }
  return acc;
}

/**
 * 读取 session_index.jsonl，返回条目数组
 */
function readSessionIndex(indexPath) {
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .reduce((acc, line) => {
      try { acc.push(JSON.parse(line)); } catch { /* 跳过格式错误行 */ }
      return acc;
    }, []);
}

/**
 * 同步读取文件前 8KB，返回第一行文本（用于获取 cwd）
 * 注意：rollout 首行可能非常大（含 base_instructions），故只做前缀读取
 */
function readFirstLineSync(filePath) {
  try {
    const SIZE = 8192;
    const buf = Buffer.alloc(SIZE);
    const fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buf, 0, SIZE, 0);
    closeSync(fd);
    return buf.slice(0, bytesRead).toString('utf8').split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * 从 rollout 首行提取 cwd。
 * 首行是 session_meta：{"timestamp":...,"type":"session_meta","payload":{"cwd":"..."}}
 * 首行可能被截断无法完整 JSON.parse，所以先尝试 parse，失败时用正则提取。
 */
function extractCwd(firstLine) {
  if (!firstLine) return null;
  try {
    const msg = JSON.parse(firstLine);
    return msg.payload?.cwd || msg.cwd || msg.workdir || null;
  } catch {
    const m = firstLine.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
  }
}

/**
 * 扫描 codex home，返回结构化信息
 * @param {string} codexHome  ~/.codex 目录路径
 * @returns {{ sessions, sessionIndex, skills, plugins, allFiles }}
 *   sessions:     按 cwd 分组的会话列表
 *   sessionIndex: session_index.jsonl 原始条目数组
 *   skills:       skills/** 文件列表
 *   plugins:      plugins/** 文件列表
 *   allFiles:     所有相关文件 { rel, absPath, mtime, size }
 */
export async function scanCodexHome(codexHome) {
  const indexPath   = join(codexHome, 'session_index.jsonl');
  const sessionsDir = join(codexHome, 'sessions');
  const skillsDir   = join(codexHome, 'skills');
  const pluginsDir  = join(codexHome, 'plugins');

  // 读取索引，建立 id → entry 映射
  const sessionIndex = readSessionIndex(indexPath);
  const indexMap = new Map(sessionIndex.filter(e => e.id).map(e => [e.id, e]));

  // 扫描 sessions 目录下的 .jsonl 文件
  const sessionFileEntries = existsSync(sessionsDir)
    ? walkDir(codexHome, sessionsDir).filter(f => SESSION_FILE_RE.test(f.rel))
    : [];

  // 构建会话列表，从每个文件第一行提取 cwd
  const sessionList = sessionFileEntries.map(f => {
    // 从文件名提取 UUID：rollout-YYYY-MM-DDThh-mm-ss-{UUID}.jsonl
    const fileNameMatch = f.rel.match(/rollout-.+?-([0-9a-f-]{36})\.jsonl$/i);
    const id = fileNameMatch ? fileNameMatch[1] : f.rel.replace('.jsonl', '');
    const indexEntry = indexMap.get(id) || {};

    let cwd = null;
    let project = null;
    const firstLine = readFirstLineSync(f.absPath);
    cwd = extractCwd(firstLine);
    if (cwd) {
      const cwdParts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
      project = cwdParts[cwdParts.length - 1] || cwd;
    }

    return {
      id: indexEntry.id || id,
      thread_name: indexEntry.thread_name ?? null,
      updated_at: indexEntry.updated_at ?? new Date(f.mtime).toISOString(),
      cwd,
      project,
      file: f.absPath,
      size_bytes: f.size,
    };
  });

  // 按 cwd 分组
  const sessions = {};
  for (const s of sessionList) {
    const key = s.cwd || '__unknown__';
    (sessions[key] ??= []).push(s);
  }

  const skills  = existsSync(skillsDir)  ? walkDir(codexHome, skillsDir)  : [];
  const plugins = existsSync(pluginsDir) ? walkDir(codexHome, pluginsDir) : [];

  // allFiles 覆盖 sessions/**、session_index.jsonl、skills/**、plugins/**
  const sessionsDirFiles = existsSync(sessionsDir) ? walkDir(codexHome, sessionsDir) : [];
  const indexFileMeta = existsSync(indexPath)
    ? [{ rel: 'session_index.jsonl', absPath: indexPath,
         mtime: statSync(indexPath).mtimeMs, size: statSync(indexPath).size }]
    : [];

  const allFiles = [...sessionsDirFiles, ...indexFileMeta, ...skills, ...plugins];

  return { sessions, sessionIndex, skills, plugins, allFiles };
}

/**
 * 解析 session JSONL 文件，返回前 50 条消息
 * @param {string} sessionFile
 * @returns {object[]}
 */
export function readSessionMessages(sessionFile) {
  if (!existsSync(sessionFile)) return [];
  const messages = [];
  for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
    if (messages.length >= 50) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { messages.push(JSON.parse(trimmed)); } catch { /* 跳过错误行 */ }
  }
  return messages;
}

/**
 * 修改 session_index.jsonl 中指定会话的 thread_name（原子写）
 * @param {string} codexHome
 * @param {string} sessionId
 * @param {string} newName
 */
export function updateSessionName(codexHome, sessionId, newName) {
  const indexPath = join(codexHome, 'session_index.jsonl');
  if (!existsSync(indexPath)) throw new Error(`session_index.jsonl not found: ${indexPath}`);

  let found = false;
  const updatedLines = readFileSync(indexPath, 'utf8').split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.id === sessionId) {
        found = true;
        return JSON.stringify({ ...entry, thread_name: newName });
      }
    } catch { /* 格式错误行原样保留 */ }
    return line;
  });

  if (!found) throw new Error(`Session not found in index: ${sessionId}`);

  // 原子写：先写临时文件，再 rename
  const tmpPath = indexPath + '.tmp';
  writeFileSync(tmpPath, updatedLines.join('\n'), 'utf8');
  renameSync(tmpPath, indexPath);
}
