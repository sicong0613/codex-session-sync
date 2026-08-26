// src/manifest.js — 读写同步清单，记录已同步文件的元数据（含 sha256 缓存）
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { scanCodexHome } from './scanner.js';

/**
 * 读取清单文件
 * @param {string} manifestPath
 * @returns {{ machine_id, synced_at, files: Object } | null}
 */
export function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 原子写清单：先写 .tmp，再 rename
 * @param {string} manifestPath
 * @param {{ machine_id, synced_at, files }} data
 */
export function writeManifest(manifestPath, data) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tmpPath = manifestPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmpPath, manifestPath);
}

/**
 * 从 scanner allFiles 生成 manifest files 对象（不含 sha256）
 * @param {Array<{ rel, absPath, mtime, size }>} fileList
 * @returns {Object<string, { mtime, size }>}
 */
export function buildFileMap(fileList) {
  const files = {};
  for (const f of fileList) {
    files[f.rel] = { mtime: f.mtime, size: f.size };
  }
  return files;
}

/**
 * 计算文件 SHA-256（同步）
 * @param {string} filePath
 * @returns {string} hex digest
 */
export function hashFile(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * 为本地文件列表附加 sha256：若 manifest 中记录的 (local_mtime, local_size)
 * 与当前值一致，直接复用缓存的哈希（零 IO）；否则读取文件重新计算。
 * 这是让 hash 校验"快"的关键——只对真正可能变化的文件付 IO 代价。
 *
 * @param {Array<{ rel, absPath, mtime, size }>} fileList
 * @param {{ files: Object } | null} prevManifest
 * @returns {Object<string, { mtime, size, sha256 }>}
 */
export function buildLocalHashedMap(fileList, prevManifest) {
  const prevFiles = prevManifest?.files ?? {};
  const files = {};
  for (const f of fileList) {
    const prev = prevFiles[f.rel];
    const cacheHit = prev
      && prev.local_mtime === f.mtime
      && prev.local_size === f.size
      && !!prev.sha256;
    const sha256 = cacheHit ? prev.sha256 : hashFile(f.absPath);
    files[f.rel] = { mtime: f.mtime, size: f.size, sha256 };
  }
  return files;
}

/**
 * 为远端文件列表附加 sha256（若可用）：若 manifest 中记录的
 * (remote_mtime, remote_size) 与当前值一致，复用缓存哈希，全程不下载文件。
 * 若不一致，哈希留空——buildPlan 会回退到 mtime 比较（不强制下载去取哈希）。
 *
 * @param {Array<{ rel, mtime, size }>} remoteFileList
 * @param {{ files: Object } | null} prevManifest
 * @returns {Object<string, { mtime, size, sha256? }>}
 */
export function mergeRemoteHashCache(remoteFileList, prevManifest) {
  const prevFiles = prevManifest?.files ?? {};
  const files = {};
  for (const f of remoteFileList) {
    const prev = prevFiles[f.rel];
    const entry = { mtime: f.mtime, size: f.size };
    if (prev && prev.remote_mtime === f.mtime && prev.remote_size === f.size && prev.sha256) {
      entry.sha256 = prev.sha256;
    }
    files[f.rel] = entry;
  }
  return files;
}

/**
 * 准备一次同步所需的本地/远端文件集合（均已按缓存规则附加 sha256）
 * @param {{ codexHome: string, davClient: object, remotePath: string, manifestPath: string }} params
 * @returns {Promise<{ prevManifest, localFiles, remoteFiles }>}
 */
export async function prepareSyncFileSets({ codexHome, davClient, remotePath, manifestPath }) {
  const prevManifest = readManifest(manifestPath);
  const local = await scanCodexHome(codexHome);
  const localFiles = buildLocalHashedMap(local.allFiles, prevManifest);
  const remoteList = await davClient.list(remotePath).catch(() => []);
  const remoteFiles = mergeRemoteHashCache(remoteList, prevManifest);
  return { prevManifest, localFiles, remoteFiles };
}

/**
 * 同步执行完成后，重建并写入 manifest：只更新本次实际成功处理的文件条目，
 * 未解决的冲突/失败项保留旧记录，留待下次重新判断。
 *
 * @param {{
 *   manifestPath: string,
 *   machineId: string,
 *   prevManifest: object | null,
 *   localFiles:  Object<string, { mtime, size, sha256 }>,
 *   remoteFiles: Object<string, { mtime, size, sha256? }>,
 *   plan:   ReturnType<import('./sync-engine.js').buildPlan>,
 *   result: { errors: Array<{ rel }> },
 *   codexHome: string,
 *   davClient: object,
 * }} params
 * @returns {Promise<Object>} 写入的 files 映射
 */
export async function finalizeManifest({
  manifestPath, machineId, prevManifest, localFiles, remoteFiles, plan, result, codexHome, davClient,
}) {
  const files = { ...(prevManifest?.files ?? {}) };
  const erroredRels = new Set((result?.errors ?? []).map(e => e.rel));

  const setEntry = (rel, sha256, localMeta, remoteMeta) => {
    if (!sha256) return; // 无法确定内容哈希时不写入，避免污染缓存
    files[rel] = {
      sha256,
      local_mtime:  localMeta?.mtime  ?? files[rel]?.local_mtime,
      local_size:   localMeta?.size   ?? files[rel]?.local_size,
      remote_mtime: remoteMeta?.mtime ?? files[rel]?.remote_mtime,
      remote_size:  remoteMeta?.size  ?? files[rel]?.remote_size,
    };
  };

  for (const rel of plan.unchanged ?? []) {
    const l = localFiles[rel], r = remoteFiles[rel];
    setEntry(rel, l?.sha256 ?? r?.sha256, l, r);
  }

  for (const rel of plan.to_upload ?? []) {
    if (erroredRels.has(rel)) continue;
    const l = localFiles[rel];
    let remoteMeta = null;
    try { remoteMeta = await davClient.stat(rel); } catch { /* 取不到就用本地值近似 */ }
    setEntry(rel, l?.sha256, l, remoteMeta ?? l);
  }

  for (const rel of plan.to_download ?? []) {
    if (erroredRels.has(rel)) continue;
    const absPath = join(codexHome, rel);
    try {
      const st = statSync(absPath);
      const sha256 = hashFile(absPath);
      setEntry(rel, sha256, { mtime: st.mtimeMs, size: st.size }, remoteFiles[rel]);
    } catch { /* 文件写入失败/已被移除，跳过 */ }
  }

  writeManifest(manifestPath, {
    machine_id: machineId,
    synced_at: new Date().toISOString(),
    files,
  });

  return files;
}
