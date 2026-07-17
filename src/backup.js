// src/backup.js — 快照备份、列举、恢复和清理
import {
  cpSync, mkdirSync, readdirSync, statSync, rmSync, existsSync, renameSync,
} from 'fs';
import { join, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const isWindows = process.platform === 'win32';

// ─── 快照名称工具 ──────────────────────────────────────────────────────────────

/**
 * 生成快照名称：ISO 时间戳，冒号替换为连字符（跨平台文件名安全）
 * 例：2026-07-17T06-54-09.123Z
 */
function makeSnapshotName() {
  return new Date().toISOString().replace(/:/g, '-');
}

/**
 * 快照名称转回 Date（用于过期判断）
 */
function snapshotNameToDate(name) {
  // 去除可能的后缀（.zip），还原冒号
  const iso = name.replace(/\.zip$/, '').replace(/-(\d{2})-(\d{2})\./,  ':$1:$2.');
  // 简单格式：YYYY-MM-DDTHH-MM-SS.mmmZ → 先把前两个 - 改回 :
  // 实际格式：2026-07-17T06-54-09.123Z
  const fixed = name.replace(/\.zip$/, '')
    .replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  return new Date(fixed);
}

// ─── createSnapshot ───────────────────────────────────────────────────────────

/**
 * 创建快照
 *
 * @param {{
 *   sourceDir:   string,   — 要备份的目录（绝对路径）
 *   backupDir:   string,   — 快照存放目录（绝对路径）
 *   compression: 'none' | 'zip',
 *   include?:    string[]  — 仅包含这些 rel 路径（未实现时备份全部）
 * }} params
 * @returns {Promise<string>}  快照名称
 */
export async function createSnapshot({ sourceDir, backupDir, compression = 'none', include }) {
  mkdirSync(backupDir, { recursive: true });
  const snapshotName = makeSnapshotName();

  if (compression === 'zip') {
    await createZipSnapshot({ sourceDir, backupDir, snapshotName, include });
  } else {
    // compression: 'none' — 目录复制
    const destDir = join(backupDir, snapshotName);
    mkdirSync(destDir, { recursive: true });
    cpSync(sourceDir, destDir, {
      recursive: true,
      // include 过滤：若指定了根路径列表，只复制这些路径下的内容
      filter: include
        ? (src) => {
            const rel = src.replace(sourceDir, '').replace(/^[\\/]/, '').replace(/\\/g, '/');
            if (!rel) return true; // 根目录本身
            return include.some(p =>
              rel === p ||             // 精确匹配（文件或目录本身）
              rel.startsWith(p + '/') || // src 在包含目录内
              p.startsWith(rel + '/')    // src 是包含路径的祖先目录
            );
          }
        : undefined,
    });
  }

  return snapshotName;
}

// ─── ZIP 快照（调用系统命令）─────────────────────────────────────────────────

async function createZipSnapshot({ sourceDir, backupDir, snapshotName, _include }) {
  const zipFile = join(backupDir, snapshotName + '.zip');

  if (isWindows) {
    // PowerShell Compress-Archive（Windows 内建）
    const src = sourceDir.replace(/'/g, "''");
    const dst = zipFile.replace(/'/g, "''");
    await execAsync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${src}\\*' -DestinationPath '${dst}' -Force"`
    );
  } else {
    // Unix：zip -r（需系统安装 zip）
    await execAsync(`zip -r "${zipFile}" .`, { cwd: sourceDir });
  }
}

// ─── listSnapshots ────────────────────────────────────────────────────────────

/**
 * 列出备份目录中的所有快照
 * @param {string} backupDir
 * @returns {Array<{ name, created_at, size_bytes, format }>}
 */
export function listSnapshots(backupDir) {
  if (!existsSync(backupDir)) return [];

  const entries = readdirSync(backupDir, { withFileTypes: true });
  const snapshots = [];

  for (const ent of entries) {
    const name = ent.name;
    const absPath = join(backupDir, name);

    let size_bytes = 0;
    let format = 'directory';

    if (ent.isFile() && name.endsWith('.zip')) {
      format = 'zip';
      try { size_bytes = statSync(absPath).size; } catch {}
    } else if (ent.isDirectory()) {
      format = 'directory';
      size_bytes = dirSizeSync(absPath);
    } else {
      continue; // 忽略其他文件
    }

    const created_at = snapshotNameToDate(name);

    snapshots.push({
      name,
      created_at: isNaN(created_at.getTime()) ? null : created_at.toISOString(),
      size_bytes,
      format,
    });
  }

  // 按创建时间降序排列（最新的在前）
  snapshots.sort((a, b) => (b.created_at ?? '') .localeCompare(a.created_at ?? ''));
  return snapshots;
}

/**
 * 递归计算目录大小（bytes）
 */
function dirSizeSync(dir) {
  let total = 0;
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isFile()) {
        try { total += statSync(p).size; } catch {}
      } else if (ent.isDirectory()) {
        total += dirSizeSync(p);
      }
    }
  } catch {}
  return total;
}

// ─── deleteSnapshot ──────────────────────────────────────────────────────────

/**
 * 删除指定快照（目录或 .zip 文件）
 * 名称须来自 listSnapshots，禁止路径穿越
 *
 * @param {{ snapshot: string, backupDir: string }} params
 */
export function deleteSnapshot({ snapshot, backupDir }) {
  // 防路径穿越：名称不允许包含路径分隔符或 ..
  if (!snapshot || /[\\/]|\.\./.test(snapshot)) {
    throw new Error(`Invalid snapshot name: ${snapshot}`);
  }
  const snapshotPath = join(backupDir, snapshot);
  if (!existsSync(snapshotPath)) {
    throw new Error(`Snapshot not found: ${snapshot}`);
  }
  rmSync(snapshotPath, { recursive: true, force: true });
}

// ─── restoreSnapshot ─────────────────────────────────────────────────────────

/**
 * 恢复快照到目标目录
 * 恢复前先备份当前 targetDir 内容（避免覆盖丢失）
 *
 * @param {{
 *   snapshot:  string,  — 快照名称（listSnapshots 返回的 name）
 *   backupDir: string,
 *   targetDir: string,
 * }} params
 * @returns {Promise<void>}
 */
export async function restoreSnapshot({ snapshot, backupDir, targetDir }) {
  const snapshotPath = join(backupDir, snapshot);
  if (!existsSync(snapshotPath)) {
    throw new Error(`Snapshot not found: ${snapshotPath}`);
  }

  // 先备份当前 targetDir（防止恢复失败时丢失数据）
  if (existsSync(targetDir)) {
    const safetyName = makeSnapshotName() + '-pre-restore';
    const safetyPath = join(backupDir, safetyName);
    mkdirSync(safetyPath, { recursive: true });
    cpSync(targetDir, safetyPath, { recursive: true });
  }

  const isZip = snapshot.endsWith('.zip');

  if (isZip) {
    mkdirSync(targetDir, { recursive: true });
    await extractZip(snapshotPath, targetDir);
  } else {
    // 目录快照：直接复制覆盖
    mkdirSync(targetDir, { recursive: true });
    cpSync(snapshotPath, targetDir, { recursive: true });
  }
}

async function extractZip(zipFile, targetDir) {
  if (isWindows) {
    const src = zipFile.replace(/'/g, "''");
    const dst = targetDir.replace(/'/g, "''");
    await execAsync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${src}' -DestinationPath '${dst}' -Force"`
    );
  } else {
    await execAsync(`unzip -o "${zipFile}" -d "${targetDir}"`);
  }
}

// ─── pruneSnapshots ───────────────────────────────────────────────────────────

/**
 * 删除过期快照
 *
 * @param {{
 *   backupDir:       string,
 *   retention_days:  number,  — 0 表示不按天数过期
 *   max_backups:     number,  — 0 表示不限数量
 * }} params
 * @returns {{ removed: string[] }}
 */
export function pruneSnapshots({ backupDir, retention_days = 30, max_backups = 0 }) {
  const all = listSnapshots(backupDir);
  const removed = [];

  // 按创建时间升序（最旧的先删）
  const sorted = [...all].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));

  const now = Date.now();
  const retentionMs = retention_days > 0 ? retention_days * 24 * 60 * 60 * 1000 : Infinity;

  let toRemove = new Set();

  // 按保留天数过期
  if (retention_days > 0) {
    for (const snap of sorted) {
      if (!snap.created_at) continue;
      const age = now - new Date(snap.created_at).getTime();
      if (age > retentionMs) toRemove.add(snap.name);
    }
  }

  // 按最大数量限制（保留最新的 max_backups 个）
  if (max_backups > 0) {
    const surviving = sorted.filter(s => !toRemove.has(s.name));
    if (surviving.length > max_backups) {
      const excess = surviving.slice(0, surviving.length - max_backups);
      for (const s of excess) toRemove.add(s.name);
    }
  }

  // 执行删除
  for (const name of toRemove) {
    const absPath = join(backupDir, name);
    try {
      rmSync(absPath, { recursive: true, force: true });
      removed.push(name);
    } catch { /* 删除失败时继续处理其他快照 */ }
  }

  return { removed };
}
