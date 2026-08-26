// test/manifest.test.js
import { describe, test, expect, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  hashFile, buildLocalHashedMap, mergeRemoteHashCache,
  readManifest, writeManifest,
} from '../src/manifest.js';

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
