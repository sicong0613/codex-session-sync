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
 * 为远端文件列表附加 sha256（若可用）。优先取"共享远端清单"（写在 WebDAV 上，
 * 所有设备共享）里记录的哈希——只要它记录时的 (mtime, size) 与当前一致就可信；
 * 找不到共享记录时，退回到本设备私有 manifest 里的缓存（同一设备重复同步的场景）。
 * 两者都没有则哈希留空——buildPlan 会回退到 mtime 比较（不强制下载去取哈希）。
 *
 * @param {Array<{ rel, mtime, size }>} remoteFileList
 * @param {{ files: Object } | null} prevManifest       本设备私有 manifest（可能为 null）
 * @param {Object<string, { sha256, mtime, size }>} [sharedRemoteManifest]  跨设备共享清单
 * @returns {Object<string, { mtime, size, sha256? }>}
 */
export function mergeRemoteHashCache(remoteFileList, prevManifest, sharedRemoteManifest) {
  const prevFiles = prevManifest?.files ?? {};
  const shared = sharedRemoteManifest ?? {};
  const files = {};
  for (const f of remoteFileList) {
    const entry = { mtime: f.mtime, size: f.size };
    const sharedEntry = shared[f.rel];
    if (sharedEntry && sharedEntry.mtime === f.mtime && sharedEntry.size === f.size && sharedEntry.sha256) {
      entry.sha256 = sharedEntry.sha256;
    } else {
      const prev = prevFiles[f.rel];
      if (prev && prev.remote_mtime === f.mtime && prev.remote_size === f.size && prev.sha256) {
        entry.sha256 = prev.sha256;
      }
    }
    files[f.rel] = entry;
  }
  return files;
}

// ─── 跨设备共享的远端哈希清单 ────────────────────────────────────────────────
// 存放在 WebDAV 上 remote_path 根目录下的一个隐藏文件，内容为
// { [rel]: { sha256, mtime, size } }（mtime/size 是记录哈希时 WebDAV 报告的值，
// 用于判断这条记录是否还对得上当前文件）。这样即便是"从没同步过这台设备"的机器，
// 也能在不下载文件的前提下，用别的设备已经算好的哈希判断内容是否相同。
export const REMOTE_MANIFEST_REL = '.cxsync-manifest.json';

/** 判断某个远端相对路径是不是共享清单本身（同步文件列表时要把它过滤掉，
 *  否则它会被当成一个"远端多出来的文件"下载进 codex_home）。 */
export function isRemoteManifestFile(rel) {
  return rel === REMOTE_MANIFEST_REL;
}

/**
 * 从 WebDAV 拉取共享远端清单；不存在或损坏时视为空（例如首次同步）。
 * @param {object} davClient
 * @returns {Promise<Object<string, { sha256, mtime, size }>>}
 */
export async function fetchRemoteManifest(davClient) {
  try {
    const buf = await davClient.getFile(REMOTE_MANIFEST_REL);
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * 把共享远端清单写回 WebDAV。失败（网络问题等）不应阻断整个同步流程，
 * 由调用方决定是否吞掉异常。
 * @param {object} davClient
 * @param {Object} sharedRemoteManifest
 */
export async function pushRemoteManifest(davClient, sharedRemoteManifest) {
  const buf = Buffer.from(JSON.stringify(sharedRemoteManifest, null, 2), 'utf8');
  await davClient.putFile(REMOTE_MANIFEST_REL, buf);
}

/**
 * 准备一次同步所需的本地/远端文件集合（均已按缓存规则附加 sha256）
 *
 * 注意：davClient 在创建时（createWebDAVClient）已经把 remote_path 固化为根，
 * davClient.list() 不需要（也不应该）再传一次 remote_path——那样会把路径拼两次
 * （如 /codex-sync/codex-sync），导致 404 被 .catch(() => []) 悄悄吞掉，
 * 同步计划永远把远端当成空的。
 *
 * @param {{ codexHome: string, davClient: object, manifestPath: string }} params
 * @returns {Promise<{ prevManifest, localFiles, remoteFiles, sharedRemoteManifest }>}
 */
export async function prepareSyncFileSets({ codexHome, davClient, manifestPath }) {
  const prevManifest = readManifest(manifestPath);
  const local = await scanCodexHome(codexHome);
  const localFiles = buildLocalHashedMap(local.allFiles, prevManifest);

  const sharedRemoteManifest = await fetchRemoteManifest(davClient);
  const remoteListRaw = await davClient.list().catch(() => []);
  const remoteList = remoteListRaw.filter(f => !isRemoteManifestFile(f.rel));
  const remoteFiles = mergeRemoteHashCache(remoteList, prevManifest, sharedRemoteManifest);

  return { prevManifest, localFiles, remoteFiles, sharedRemoteManifest };
}

/**
 * 同步执行完成后，重建并写入 manifest：只更新本次实际成功处理的文件条目，
 * 未解决的冲突/失败项保留旧记录，留待下次重新判断。
 * 同时把新增/确认过的哈希合并进共享远端清单并回写到 WebDAV——这样"从没同步过
 * 这台设备"的其它机器，下次也能直接复用这些哈希，不必重新下载判断。
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
 *   sharedRemoteManifest?: Object,   — prepareSyncFileSets 返回的那份，同步期间未再变化
 * }} params
 * @returns {Promise<{ files: Object, sharedRemoteManifest: Object }>}
 */
export async function finalizeManifest({
  manifestPath, machineId, prevManifest, localFiles, remoteFiles, plan, result, codexHome, davClient,
  sharedRemoteManifest,
}) {
  const files = { ...(prevManifest?.files ?? {}) };
  const shared = { ...(sharedRemoteManifest ?? {}) };
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
    if (remoteMeta) {
      shared[rel] = { sha256, mtime: remoteMeta.mtime, size: remoteMeta.size };
    }
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

  // 成功镜像删除的文件：清掉两份 manifest 里对应的记录，
  // 否则残留的旧哈希会在文件被重新创建时造成误判。
  for (const rel of [...(plan.to_delete_local ?? []), ...(plan.to_delete_remote ?? [])]) {
    if (erroredRels.has(rel)) continue;
    delete files[rel];
    delete shared[rel];
  }

  // 垃圾回收：两侧都已经不在了、又没有出现在本次计划里的旧记录
  // （例如两台设备几乎同时各自删除了同一个文件），顺手清掉，避免 manifest 无限膨胀。
  const liveRels = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)]);
  for (const rel of Object.keys(files)) {
    if (!liveRels.has(rel) && !erroredRels.has(rel)) delete files[rel];
  }
  for (const rel of Object.keys(shared)) {
    if (!liveRels.has(rel) && !erroredRels.has(rel)) delete shared[rel];
  }

  writeManifest(manifestPath, {
    machine_id: machineId,
    synced_at: new Date().toISOString(),
    files,
  });

  try {
    await pushRemoteManifest(davClient, shared);
  } catch { /* 共享清单回写失败不影响本次同步结果，下次同步会重新拉取/合并 */ }

  return { files, sharedRemoteManifest: shared };
}
