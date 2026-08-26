// test/manifest.test.js
import { describe, test, expect, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  hashFile, buildLocalHashedMap, mergeRemoteHashCache,
  readManifest, writeManifest,
  REMOTE_MANIFEST_REL, isRemoteManifestFile, fetchRemoteManifest, pushRemoteManifest,
  prepareSyncFileSets, finalizeManifest,
} from '../src/manifest.js';
import { buildPlan } from '../src/sync-engine.js';

/** 极简内存版 davClient，只实现 manifest.js / sync-engine.js 用到的接口 */
function makeFakeDav() {
  const store = new Map(); // rel -> { buf, mtime, size }
  let clock = 1000;
  return {
    async list() {
      return [...store.entries()].map(([rel, v]) => ({ rel, mtime: v.mtime, size: v.size }));
    },
    async stat(rel) {
      const v = store.get(rel);
      return v ? { mtime: v.mtime, size: v.size } : null;
    },
    async getFile(rel) {
      const v = store.get(rel);
      if (!v) { const e = new Error('404'); e.status = 404; throw e; }
      return v.buf;
    },
    async putFile(rel, buf) {
      clock += 1000;
      store.set(rel, { buf, mtime: clock, size: buf.length });
    },
  };
}

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('buildLocalHashedMap', () => {
  test('cache hit: reuses manifest sha256 without reading the file when mtime+size match', () => {
    dir = mkdtempSync(join(tmpdir(), 'cxsync-manifest-'));
    const p = join(dir, 'a.jsonl');
    writeFileSync(p, 'hello world');
    const realHash = hashFile(p);

    const fileList = [{ rel: 'a.jsonl', absPath: p, mtime: 12345, size: 11 }];
    const prevManifest = {
      files: { 'a.jsonl': { local_mtime: 12345, local_size: 11, sha256: 'FAKE-CACHED-HASH' } },
    };

    const map = buildLocalHashedMap(fileList, prevManifest);
    // proves the cached value was used, not a fresh hash of the real content
    expect(map['a.jsonl'].sha256).toBe('FAKE-CACHED-HASH');
    expect(map['a.jsonl'].sha256).not.toBe(realHash);
  });

  test('cache miss: recomputes hash when mtime or size differs from manifest', () => {
    dir = mkdtempSync(join(tmpdir(), 'cxsync-manifest-'));
    const p = join(dir, 'b.jsonl');
    writeFileSync(p, 'actual content');
    const realHash = hashFile(p);

    const fileList = [{ rel: 'b.jsonl', absPath: p, mtime: 99999, size: 14 }];
    const prevManifest = {
      files: { 'b.jsonl': { local_mtime: 1, local_size: 1, sha256: 'STALE' } },
    };

    const map = buildLocalHashedMap(fileList, prevManifest);
    expect(map['b.jsonl'].sha256).toBe(realHash);
  });

  test('no prior manifest: hashes every file', () => {
    dir = mkdtempSync(join(tmpdir(), 'cxsync-manifest-'));
    const p = join(dir, 'c.jsonl');
    writeFileSync(p, 'x');
    const map = buildLocalHashedMap([{ rel: 'c.jsonl', absPath: p, mtime: 1, size: 1 }], null);
    expect(map['c.jsonl'].sha256).toBe(hashFile(p));
  });
});

describe('mergeRemoteHashCache', () => {
  test('reuses cached hash when remote mtime+size unchanged (no download needed)', () => {
    const prevManifest = { files: { 'r.jsonl': { remote_mtime: 500, remote_size: 20, sha256: 'CACHED' } } };
    const map = mergeRemoteHashCache([{ rel: 'r.jsonl', mtime: 500, size: 20 }], prevManifest);
    expect(map['r.jsonl'].sha256).toBe('CACHED');
  });

  test('leaves sha256 undefined when remote mtime+size changed since last sync', () => {
    const prevManifest = { files: { 'r.jsonl': { remote_mtime: 500, remote_size: 20, sha256: 'CACHED' } } };
    const map = mergeRemoteHashCache([{ rel: 'r.jsonl', mtime: 999, size: 20 }], prevManifest);
    expect(map['r.jsonl'].sha256).toBeUndefined();
  });
});

describe('mergeRemoteHashCache with shared remote manifest', () => {
  test('shared manifest hash wins even with no per-device manifest at all', () => {
    const shared = { 'r.jsonl': { sha256: 'SHARED-HASH', mtime: 500, size: 20 } };
    const map = mergeRemoteHashCache([{ rel: 'r.jsonl', mtime: 500, size: 20 }], null, shared);
    expect(map['r.jsonl'].sha256).toBe('SHARED-HASH');
  });

  test('shared manifest entry ignored when its (mtime,size) no longer matches the live listing', () => {
    const shared = { 'r.jsonl': { sha256: 'STALE-SHARED', mtime: 111, size: 1 } };
    const map = mergeRemoteHashCache([{ rel: 'r.jsonl', mtime: 999, size: 20 }], null, shared);
    expect(map['r.jsonl'].sha256).toBeUndefined();
  });

  test('falls back to per-device cache when shared manifest has no entry for the file', () => {
    const prevManifest = { files: { 'r.jsonl': { remote_mtime: 500, remote_size: 20, sha256: 'DEVICE-CACHED' } } };
    const map = mergeRemoteHashCache([{ rel: 'r.jsonl', mtime: 500, size: 20 }], prevManifest, {});
    expect(map['r.jsonl'].sha256).toBe('DEVICE-CACHED');
  });
});

describe('isRemoteManifestFile', () => {
  test('flags the shared manifest path so it never gets treated as a synced file', () => {
    expect(isRemoteManifestFile(REMOTE_MANIFEST_REL)).toBe(true);
    expect(isRemoteManifestFile('sessions/2026/01/01/rollout-x.jsonl')).toBe(false);
  });
});

describe('fetchRemoteManifest / pushRemoteManifest round-trip', () => {
  test('pushes to WebDAV and reads the same data back', async () => {
    const dav = makeFakeDav();
    expect(await fetchRemoteManifest(dav)).toEqual({}); // nothing uploaded yet
    const data = { 'a.jsonl': { sha256: 'abc', mtime: 1, size: 2 } };
    await pushRemoteManifest(dav, data);
    expect(await fetchRemoteManifest(dav)).toEqual(data);
  });

  test('treats a missing or corrupt remote manifest as empty rather than throwing', async () => {
    const dav = makeFakeDav();
    await dav.putFile(REMOTE_MANIFEST_REL, Buffer.from('{not json'));
    expect(await fetchRemoteManifest(dav)).toEqual({});
  });
});

describe('cross-device dedup: two devices, same content, different mtimes, no shared sync history', () => {
  test('device B (first time, no local manifest) sees device A\'s upload as unchanged instead of re-uploading', () => {
    // Device A already uploaded 'a.jsonl' and recorded its hash in the shared remote manifest
    // (this is exactly what finalizeManifest does after a real upload).
    const sharedRemoteManifest = {
      'a.jsonl': { sha256: 'CONTENT-HASH', mtime: 5000, size: 12 }, // recorded by device A
    };

    // Device B has its own, unrelated local copy: identical bytes, wildly different mtime,
    // and it has never synced before (prevManifest is null -> real hash gets computed).
    // We simulate "real hash equals CONTENT-HASH" by feeding buildPlan the local map directly
    // (buildLocalHashedMap's job — hashing real bytes — is already covered above).
    const localFiles = { 'a.jsonl': { mtime: 999999, size: 12, sha256: 'CONTENT-HASH' } };
    const remoteFiles = mergeRemoteHashCache(
      [{ rel: 'a.jsonl', mtime: 5000, size: 12 }],
      null, // device B has no private manifest history for this file
      sharedRemoteManifest,
    );

    const plan = buildPlan({
      localFiles, remoteFiles,
      config: { sync: { compare: 'mtime_hash_fallback', time_tolerance_seconds: 2 }, conflict: { policy: 'manual_abort' } },
    });

    expect(plan.unchanged).toContain('a.jsonl');
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.to_download).toHaveLength(0);
  });

  test('without the shared manifest, the same scenario would have wrongly conflicted/re-transferred', () => {
    // Same setup but no shared manifest available (today's local-only cache) — proves the gap
    // this feature closes: device B has no way to know the content already matches.
    const localFiles = { 'a.jsonl': { mtime: 999999, size: 12, sha256: 'CONTENT-HASH' } };
    const remoteFiles = mergeRemoteHashCache(
      [{ rel: 'a.jsonl', mtime: 5000, size: 12 }],
      null, undefined, // no per-device cache, no shared manifest
    );
    expect(remoteFiles['a.jsonl'].sha256).toBeUndefined();

    const plan = buildPlan({
      localFiles, remoteFiles,
      config: { sync: { compare: 'mtime_hash_fallback', time_tolerance_seconds: 2 }, conflict: { policy: 'manual_abort' } },
    });
    // local mtime (999999) is far newer than remote (5000) beyond tolerance -> spurious upload
    expect(plan.to_upload).toContain('a.jsonl');
  });
});

describe('readManifest / writeManifest round-trip', () => {
  test('writes atomically and reads back the same data', () => {
    dir = mkdtempSync(join(tmpdir(), 'cxsync-manifest-'));
    const manifestPath = join(dir, 'sub', 'manifest.json');
    const data = { machine_id: 'm1', synced_at: '2026-01-01T00:00:00Z', files: { 'x.jsonl': { sha256: 'abc' } } };
    writeManifest(manifestPath, data);
    expect(readManifest(manifestPath)).toEqual(data);
  });

  test('returns null for missing or corrupt manifest', () => {
    dir = mkdtempSync(join(tmpdir(), 'cxsync-manifest-'));
    expect(readManifest(join(dir, 'nope.json'))).toBeNull();
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{not json');
    expect(readManifest(badPath)).toBeNull();
  });
});
