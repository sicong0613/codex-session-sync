// src/manifest.js — 读写同步清单，记录已同步文件的元数据
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';

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
 * 从 scanner allFiles 生成 manifest files 对象
 * 不强制要求 sha256（计算成本高），可按需在调用侧补充
 * @param {Array<{ rel, absPath, mtime, size }>} fileList
 * @returns {Object<string, { mtime, size, sha256? }>}
 */
export function buildFileMap(fileList) {
  const files = {};
  for (const f of fileList) {
    files[f.rel] = {
      mtime: f.mtime,
      size: f.size,
    };
  }
  return files;
}

/**
 * 计算文件 SHA-256（同步，用于 hash 比较模式）
 * @param {string} filePath
 * @returns {string} hex digest
 */
export function hashFile(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}
