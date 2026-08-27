// src/sync-engine.js — 同步计划生成与执行（纯逻辑层，便于测试）
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 计算 Buffer 的 SHA-256 hex
 */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 判断两个文件条目的 mtime 是否在容差范围内相等
 */
function mtimeEqual(a, b, toleranceMs) {
  return Math.abs(a.mtime - b.mtime) <= toleranceMs;
}

/**
 * 归一化文件集合：数组 [{rel,...}] → 对象 { [rel]: {...} }
 */
function toFileMap(files) {
  if (!files) return {};
  if (Array.isArray(files)) {
    const map = {};
    for (const f of files) { if (f?.rel) map[f.rel] = f; }
    return map;
  }
  return files;
}

// ─── buildPlan ────────────────────────────────────────────────────────────────

/**
 * 纯函数：对比本地和远端文件集合，生成同步计划
 *
 * 当一侧缺失某个文件时，光看 localFiles/remoteFiles 分不清"这文件从没同步过，
 * 该传过去"还是"之前同步过，现在被删掉了，该镜像删除"。prevManifestFiles
 * （通常是上一份本地 manifest.json 里的 files）就是用来分辨这两种情况的依据：
 * 如果这个 rel 曾经出现在 manifest 里，说明上次同步时两边都有它；现在缺了一侧，
 * 只可能是那一侧把它删了。
 *
 * @param {{
 *   localFiles:  Object<string, { mtime, size, sha256? }>,
 *   remoteFiles: Object<string, { mtime, size, sha256? }>,
 *   config:      object  — 包含 sync.compare / sync.time_tolerance_seconds / conflict.policy / sync.delete_policy
 *   prevManifestFiles?: Object  — 上次同步后 manifest.json 的 files（用于判断"没同步"还是"删除了"）
 * }} params
 *
 * @returns {{
 *   to_upload:   string[],
 *   to_download: string[],
 *   to_delete_local:  string[],  — 远端已删除，delete_policy=mirror 时镜像删本地
 *   to_delete_remote: string[],  — 本地已删除，delete_policy=mirror 时镜像删远端
 *   conflicts:   Array<{ rel, local, remote }>,
 *   unchanged:   string[]
 * }}
 */
export function buildPlan({ localFiles, remoteFiles, config, prevManifestFiles }) {
  // 兼容两种输入：数组 [{rel,mtime,size}] 或对象 { [rel]: {mtime,size} }
  localFiles  = toFileMap(localFiles);
  remoteFiles = toFileMap(remoteFiles);
  const prevFiles = prevManifestFiles ?? {};
  const compare   = config?.sync?.compare ?? 'mtime';
  const toleranceMs = (config?.sync?.time_tolerance_seconds ?? 2) * 1000;
  const deletePolicy = config?.sync?.delete_policy ?? 'never';

  const to_upload   = [];
  const to_download = [];
  const to_delete_local  = [];
  const to_delete_remote = [];
  const conflicts   = [];
  const unchanged   = [];

  // 合并所有 rel 键
  const allRels = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)]);

  for (const rel of allRels) {
    const local  = localFiles[rel]  ?? null;
    const remote = remoteFiles[rel] ?? null;
    const wasSynced = !!prevFiles[rel];

    // 远端缺失：曾经同步过 + 开启镜像删除 → 远端是被删的，本地也删；否则视为新文件，上传
    if (!remote) {
      if (deletePolicy === 'mirror' && wasSynced) { to_delete_local.push(rel); }
      else { to_upload.push(rel); }
      continue;
    }
    // 本地缺失：同理，判断是"本地删除，镜像到远端"还是"远端新文件，下载"
    if (!local) {
      if (deletePolicy === 'mirror' && wasSynced) { to_delete_remote.push(rel); }
      else { to_download.push(rel); }
      continue;
    }

    // 两端都有，需要比较
    const decision = compareFiles(local, remote, { compare, toleranceMs });

    if (decision === 'equal')   { unchanged.push(rel); }
    else if (decision === 'upload')   { to_upload.push(rel); }
    else if (decision === 'download') { to_download.push(rel); }
    else { conflicts.push({ rel, local, remote }); }
  }

  return { to_upload, to_download, to_delete_local, to_delete_remote, conflicts, unchanged };
}

/**
 * 比较两个文件条目
 * @returns {'equal'|'upload'|'download'|'conflict'}
 */
function compareFiles(local, remote, { compare, toleranceMs }) {
  // hash 模式且两侧都有哈希：内容比较优先于 mtime，
  // 这样"文件被 touch 但内容没变"（mtime 跳变、size 不变）不会被误判为需要传输。
  if (compare === 'mtime_hash_fallback' && local.sha256 && remote.sha256) {
    if (local.sha256 === remote.sha256) return 'equal';
    // 哈希不同：内容确实变了，继续走下面的 mtime 方向判断
  } else if (local.size === remote.size && mtimeEqual(local, remote, toleranceMs)) {
    // mtime 模式，或缺少哈希时的回退：大小相同且 mtime 在容差内视为相同
    return 'equal';
  }

  // 取更新的一方
  if (local.mtime > remote.mtime + toleranceMs) return 'upload';
  if (remote.mtime > local.mtime + toleranceMs) return 'download';

  // mtime 接近但内容/大小不同：冲突
  return 'conflict';
}

// ─── applyPlan ────────────────────────────────────────────────────────────────

/**
 * 执行同步计划
 *
 * @param {{
 *   plan:       ReturnType<buildPlan>,
 *   config:     object,
 *   localBase:  string,   — 本地根目录绝对路径
 *   remoteBase: string,   — 远端根路径（WebDAV）
 *   webdavClient: object, — src/webdav-client.js 导出的 client 实例
 *   onProgress: (info: { file, action, n, total }) => void
 * }} params
 *
 * @returns {Promise<{ uploaded, downloaded, deletedLocal, deletedRemote, skipped, errors }>}
 */
export async function applyPlan({
  plan,
  config,
  localBase,
  remoteBase,
  webdavClient,
  davClient,            // 别名参数，兼容调用方
  onProgress = () => {},
}) {
  webdavClient = webdavClient ?? davClient;
  const conflictPolicy = config?.conflict?.policy ?? 'manual_abort';
  const backupEnabled  = config?.backup?.enabled ?? false;

  let uploaded = 0, downloaded = 0, deletedLocal = 0, deletedRemote = 0, skipped = 0;
  const errors = [];

  // 解析冲突（删除动作没有"内容冲突"的概念，原样带过去）
  let effectivePlan = { ...plan };
  if (plan.conflicts.length > 0) {
    const resolved = resolveConflicts(plan.conflicts, conflictPolicy);
    effectivePlan = {
      to_upload:   [...plan.to_upload,   ...resolved.to_upload],
      to_download: [...plan.to_download, ...resolved.to_download],
      to_delete_local:  plan.to_delete_local  ?? [],
      to_delete_remote: plan.to_delete_remote ?? [],
      conflicts:   resolved.remaining,
      unchanged:   plan.unchanged,
    };
  }

  // manual_abort：有未解决冲突则停止
  if (effectivePlan.conflicts.length > 0 && conflictPolicy === 'manual_abort') {
    for (const c of effectivePlan.conflicts) {
      errors.push({ rel: c.rel, reason: 'conflict', detail: c });
    }
    return { uploaded, downloaded, deletedLocal, deletedRemote, skipped, errors };
  }

  const total =
    effectivePlan.to_upload.length +
    effectivePlan.to_download.length +
    (effectivePlan.to_delete_local?.length ?? 0) +
    (effectivePlan.to_delete_remote?.length ?? 0) +
    (effectivePlan.conflicts?.length ?? 0);
  let n = 0;

  // 上传
  // 注意：webdavClient 内部已拼接 remote_path 前缀，这里直接传 rel
  for (const rel of effectivePlan.to_upload) {
    n++;
    onProgress({ file: rel, action: 'upload', n, total });
    try {
      const localPath = join(localBase, rel);
      if (backupEnabled) await backupRemote(webdavClient, rel, config);
      const buf = readFileSync(localPath);
      await webdavClient.putFile(rel, buf);
      uploaded++;
    } catch (err) {
      errors.push({ rel, action: 'upload', reason: err.message });
    }
  }

  // 下载
  for (const rel of effectivePlan.to_download) {
    n++;
    onProgress({ file: rel, action: 'download', n, total });
    try {
      const localPath = join(localBase, rel);
      const buf = await webdavClient.getFile(rel);
      if (backupEnabled) backupLocal(localPath, config);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, buf);
      downloaded++;
    } catch (err) {
      errors.push({ rel, action: 'download', reason: err.message });
    }
  }

  // 镜像删除本地（远端已被删）——删前把内容存到 backup_dir/deleted/ 之外的位置，
  // 而不是留 .bak 在 codex_home 里：那样下次扫描会把 .bak 当成新文件又传回去，
  // 循环制造垃圾，正是这个功能要解决的问题本身。
  for (const rel of effectivePlan.to_delete_local ?? []) {
    n++;
    onProgress({ file: rel, action: 'delete_local', n, total });
    try {
      const localPath = join(localBase, rel);
      if (backupEnabled && existsSync(localPath)) backupDeletedFile(localPath, rel, config);
      if (existsSync(localPath)) unlinkSync(localPath);
      deletedLocal++;
    } catch (err) {
      errors.push({ rel, action: 'delete_local', reason: err.message });
    }
  }

  // 镜像删除远端（本地已被删）
  for (const rel of effectivePlan.to_delete_remote ?? []) {
    n++;
    onProgress({ file: rel, action: 'delete_remote', n, total });
    try {
      if (backupEnabled) {
        try {
          const buf = await webdavClient.getFile(rel);
          backupDeletedFile(buf, rel, config);
        } catch { /* 远端已经不存在就没什么可备份的 */ }
      }
      await webdavClient.deleteFile(rel);
      deletedRemote++;
    } catch (err) {
      errors.push({ rel, action: 'delete_remote', reason: err.message });
    }
  }

  return { uploaded, downloaded, deletedLocal, deletedRemote, skipped, errors };
}

// ─── 冲突解决 ─────────────────────────────────────────────────────────────────

/**
 * 根据策略把 conflicts 分流到 to_upload / to_download / remaining
 */
function resolveConflicts(conflicts, policy) {
  const to_upload = [], to_download = [], remaining = [];

  for (const c of conflicts) {
    if (policy === 'prefer_local') {
      to_upload.push(c.rel);
    } else if (policy === 'prefer_cloud') {
      to_download.push(c.rel);
    } else if (policy === 'prefer_newer_mtime') {
      if ((c.local?.mtime ?? 0) >= (c.remote?.mtime ?? 0)) {
        to_upload.push(c.rel);
      } else {
        to_download.push(c.rel);
      }
    } else {
      // manual_abort 或未知策略：保留为冲突
      remaining.push(c);
    }
  }

  return { to_upload, to_download, remaining };
}

// ─── 备份辅助 ─────────────────────────────────────────────────────────────────

/**
 * 覆盖前备份本地文件（写入 .bak 副本）
 */
function backupLocal(localPath, _config) {
  if (!existsSync(localPath)) return;
  try {
    copyFileSync(localPath, localPath + '.bak');
  } catch { /* 备份失败不阻断主流程 */ }
}

/**
 * 覆盖前备份远端文件（下载到本地 .bak）
 * TODO: 可改为上传到 backup 目录
 */
async function backupRemote(webdavClient, remotePath, _config) {
  try {
    const buf = await webdavClient.getFile(remotePath);
    if (buf) {
      // 暂不持久化远端备份，仅检查可访问性
    }
  } catch { /* 远端文件可能不存在，忽略 */ }
}

/**
 * 镜像删除前的安全备份：存到 config.backup_dir/deleted/<rel>，
 * 刻意放在 codex_home 之外——不然备份出来的文件会被下次扫描当成"新文件"
 * 又传回同步目标，跟这个功能本身要消灭的"垃圾文件越删越多"是同一个问题。
 * @param {string | Buffer} source  本地文件路径，或者已经读到内存里的远端内容
 * @param {string} rel
 * @param {object} config
 */
function backupDeletedFile(source, rel, config) {
  const backupDir = config?.backup_dir;
  if (!backupDir) return;
  try {
    const dest = join(backupDir, 'deleted', rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (Buffer.isBuffer(source)) writeFileSync(dest, source);
    else copyFileSync(source, dest);
  } catch { /* 备份失败不阻断删除 */ }
}

/**
 * 拼接远端路径（避免双斜线）
 */
function joinRemote(base, rel) {
  return base.replace(/\/$/, '') + '/' + rel.replace(/^\//, '');
}

// 别名导出，兼容 buildSyncPlan 命名
export { buildPlan as buildSyncPlan };
