// test/sync-engine.test.js
import { describe, test, expect, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildPlan, applyPlan } from '../src/sync-engine.js';

const BASE_CONFIG = {
  sync: { compare: 'mtime', time_tolerance_seconds: 2, equal_mtime_action: 'skip' },
  conflict: { policy: 'manual_abort' },
};

// helper: file entry
const f = (mtime, size = 100) => ({ mtime, size });

describe('buildPlan', () => {
  test('upload new local file', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/a.jsonl': f(1000) },
      remoteFiles: {},
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toContain('sessions/a.jsonl');
    expect(plan.to_download).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  test('download new remote file', () => {
    const plan = buildPlan({
      localFiles:  {},
      remoteFiles: { 'sessions/b.jsonl': f(2000) },
      config: BASE_CONFIG,
    });
    expect(plan.to_download).toContain('sessions/b.jsonl');
    expect(plan.to_upload).toHaveLength(0);
  });

  test('unchanged file (same mtime+size)', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/c.jsonl': f(1000, 200) },
      remoteFiles: { 'sessions/c.jsonl': f(1000, 200) },
      config: BASE_CONFIG,
    });
    expect(plan.unchanged).toContain('sessions/c.jsonl');
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.to_download).toHaveLength(0);
  });

  test('local newer → upload', () => {
    // diff = 10000ms > tolerance 2000ms → should upload
    const plan = buildPlan({
      localFiles:  { 'sessions/d.jsonl': f(20000) },
      remoteFiles: { 'sessions/d.jsonl': f(10000) },
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toContain('sessions/d.jsonl');
  });

  test('remote newer → download', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/e.jsonl': f(1000) },
      remoteFiles: { 'sessions/e.jsonl': f(9000) },
      config: BASE_CONFIG,
    });
    expect(plan.to_download).toContain('sessions/e.jsonl');
  });

  test('within tolerance → unchanged (equal_mtime_action=skip)', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/f.jsonl': f(1000) },
      remoteFiles: { 'sessions/f.jsonl': f(1001) }, // 1ms diff, tolerance 2s
      config: BASE_CONFIG,
    });
    expect(plan.unchanged).toContain('sessions/f.jsonl');
  });

  test('conflict: both sides changed, policy=manual_abort', () => {
    // simulate both sides different size at similar mtime
    const plan = buildPlan({
      localFiles:  { 'session_index.jsonl': { mtime: 5000, size: 300 } },
      remoteFiles: { 'session_index.jsonl': { mtime: 5000, size: 999 } },
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, equal_mtime_action: 'manual_abort' } },
    });
    expect(plan.conflicts.length).toBeGreaterThan(0);
  });

  test('hash fallback: touched file (mtime jumped) but identical content stays unchanged', () => {
    // local mtime is far newer than remote (well beyond tolerance), but sha256 matches:
    // a plain 'mtime' compare would misfire an upload here; hash mode should not.
    const plan = buildPlan({
      localFiles:  { 'sessions/g.jsonl': { mtime: 500000, size: 100, sha256: 'abc123' } },
      remoteFiles: { 'sessions/g.jsonl': { mtime: 1000,   size: 100, sha256: 'abc123' } },
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, compare: 'mtime_hash_fallback' } },
    });
    expect(plan.unchanged).toContain('sessions/g.jsonl');
    expect(plan.to_upload).toHaveLength(0);
  });

  test('hash fallback: genuinely different content still uploads even with mtime close', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/h.jsonl': { mtime: 500000, size: 100, sha256: 'aaa' } },
      remoteFiles: { 'sessions/h.jsonl': { mtime: 1000,   size: 100, sha256: 'bbb' } },
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, compare: 'mtime_hash_fallback' } },
    });
    expect(plan.to_upload).toContain('sessions/h.jsonl');
  });

  test('hash fallback: missing hash on one side falls back to mtime behavior', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/i.jsonl': { mtime: 1000, size: 100 } },
      remoteFiles: { 'sessions/i.jsonl': { mtime: 1000, size: 100 } },
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, compare: 'mtime_hash_fallback' } },
    });
    expect(plan.unchanged).toContain('sessions/i.jsonl');
  });

  test('multiple files mixed', () => {
    // Use mtime values clearly beyond 2000ms tolerance
    const plan = buildPlan({
      localFiles: {
        'a.jsonl': f(100000),
        'b.jsonl': f(200000),
        'c.jsonl': f(300000), // local mtime >> remote
      },
      remoteFiles: {
        'b.jsonl': f(200000),
        'c.jsonl': f(100000), // remote much older → local should upload
        'd.jsonl': f(400000), // only remote
      },
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toContain('a.jsonl');
    expect(plan.to_upload).toContain('c.jsonl');
    expect(plan.to_download).toContain('d.jsonl');
    expect(plan.unchanged).toContain('b.jsonl');
  });

  describe('delete propagation (delete_policy)', () => {
    const MIRROR_CONFIG = { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, delete_policy: 'mirror' } };

    test('default policy (never): missing-remote file just re-uploads, even if manifest shows it was synced before', () => {
      const plan = buildPlan({
        localFiles:  { 'gone-remote.jsonl': f(1000) },
        remoteFiles: {},
        prevManifestFiles: { 'gone-remote.jsonl': { sha256: 'x' } }, // was synced before
        config: BASE_CONFIG, // delete_policy defaults to 'never'
      });
      expect(plan.to_upload).toContain('gone-remote.jsonl');
      expect(plan.to_delete_local).toHaveLength(0);
    });

    test('mirror: file present in manifest but missing on remote → delete it locally too', () => {
      const plan = buildPlan({
        localFiles:  { 'x.bak': f(1000) },
        remoteFiles: {},
        prevManifestFiles: { 'x.bak': { sha256: 'abc' } }, // previously synced -> remote deletion, not new
        config: MIRROR_CONFIG,
      });
      expect(plan.to_delete_local).toContain('x.bak');
      expect(plan.to_upload).toHaveLength(0);
    });

    test('mirror: file present in manifest but missing locally → delete it remotely too', () => {
      const plan = buildPlan({
        localFiles:  {},
        remoteFiles: { 'y.bak': f(2000) },
        prevManifestFiles: { 'y.bak': { sha256: 'def' } }, // previously synced -> local deletion, not new
        config: MIRROR_CONFIG,
      });
      expect(plan.to_delete_remote).toContain('y.bak');
      expect(plan.to_download).toHaveLength(0);
    });

    test('mirror: file never in manifest and missing on remote → still treated as new (upload)', () => {
      const plan = buildPlan({
        localFiles:  { 'brand-new.jsonl': f(1000) },
        remoteFiles: {},
        prevManifestFiles: {}, // never synced before -> can't be a deletion
        config: MIRROR_CONFIG,
      });
      expect(plan.to_upload).toContain('brand-new.jsonl');
      expect(plan.to_delete_local).toHaveLength(0);
    });

    test('mirror: file never in manifest and missing locally → still treated as new (download)', () => {
      const plan = buildPlan({
        localFiles:  {},
        remoteFiles: { 'brand-new-remote.jsonl': f(2000) },
        prevManifestFiles: {},
        config: MIRROR_CONFIG,
      });
      expect(plan.to_download).toContain('brand-new-remote.jsonl');
      expect(plan.to_delete_remote).toHaveLength(0);
    });
  });
});

describe('applyPlan delete execution', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function makeFakeDav(initialFiles = {}) {
    const store = new Map(Object.entries(initialFiles));
    return {
      deleted: [],
      async getFile(rel) {
        if (!store.has(rel)) { const e = new Error('404'); e.status = 404; throw e; }
        return store.get(rel);
      },
      async deleteFile(rel) {
        store.delete(rel);
        this.deleted.push(rel);
      },
    };
  }

  test('to_delete_local removes the local file and reports deletedLocal', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cxsync-apply-del-'));
    const target = join(dir, 'x.bak');
    writeFileSync(target, 'stale backup');

    const dav = makeFakeDav();
    const plan = { to_upload: [], to_download: [], to_delete_local: ['x.bak'], to_delete_remote: [], conflicts: [], unchanged: [] };
    const result = await applyPlan({
      plan, config: { conflict: { policy: 'manual_abort' }, backup: { enabled: false } },
      localBase: dir, remoteBase: '/x', davClient: dav,
    });

    expect(result.deletedLocal).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(existsSync(target)).toBe(false);
  });

  test('to_delete_local with backup.enabled saves a copy under backup_dir/deleted, not next to the original', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cxsync-apply-del-'));
    const backupDir = join(dir, '.backups');
    const target = join(dir, 'sessions', 'old.jsonl');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(target, 'important-ish content');

    const dav = makeFakeDav();
    const plan = { to_upload: [], to_download: [], to_delete_local: ['sessions/old.jsonl'], to_delete_remote: [], conflicts: [], unchanged: [] };
    await applyPlan({
      plan, config: { conflict: { policy: 'manual_abort' }, backup: { enabled: true }, backup_dir: backupDir },
      localBase: dir, remoteBase: '/x', davClient: dav,
    });

    expect(existsSync(target)).toBe(false); // original gone
    expect(existsSync(join(dir, 'sessions', 'old.jsonl.bak'))).toBe(false); // no sidecar left in the synced tree
    const safetyCopy = join(backupDir, 'deleted', 'sessions', 'old.jsonl');
    expect(existsSync(safetyCopy)).toBe(true);
    expect(readFileSync(safetyCopy, 'utf8')).toBe('important-ish content');
  });

  test('to_delete_remote calls davClient.deleteFile and reports deletedRemote', async () => {
    const dav = makeFakeDav({ 'y.bak': Buffer.from('remote stale') });
    const plan = { to_upload: [], to_download: [], to_delete_local: [], to_delete_remote: ['y.bak'], conflicts: [], unchanged: [] };
    const result = await applyPlan({
      plan, config: { conflict: { policy: 'manual_abort' }, backup: { enabled: false } },
      localBase: tmpdir(), remoteBase: '/x', davClient: dav,
    });

    expect(result.deletedRemote).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(dav.deleted).toContain('y.bak');
  });
});
