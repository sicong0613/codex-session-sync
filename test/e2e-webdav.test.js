// test/e2e-webdav.test.js — end-to-end sync against a local WebDAV server
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v2 as webdavServer } from 'webdav-server';
import { createWebDAVClient } from '../src/webdav-client.js';
import { buildPlan, applyPlan } from '../src/sync-engine.js';
import { prepareSyncFileSets, finalizeManifest, isRemoteManifestFile } from '../src/manifest.js';

const PORT = 17999;
let server;
let localDir;

const CONFIG = {
  sync: { compare: 'mtime', time_tolerance_seconds: 2, equal_mtime_action: 'skip' },
  conflict: { policy: 'prefer_newer_mtime' },
  backup: { enabled: false },
};

beforeAll(async () => {
  // anonymous in-memory WebDAV server (auth quirks in webdav-server are not what we test)
  server = new webdavServer.WebDAVServer({ port: PORT });
  await new Promise(res => server.start(() => res()));

  // local test dir with sample session files
  localDir = mkdtempSync(join(tmpdir(), 'cxsync-e2e-'));
  mkdirSync(join(localDir, 'sessions/2026/07/17'), { recursive: true });
  writeFileSync(join(localDir, 'sessions/2026/07/17/rollout-test-1.jsonl'),
    '{"type":"session_meta","payload":{"cwd":"/tmp/proj"}}\n{"type":"message","text":"hello"}\n');
  writeFileSync(join(localDir, 'session_index.jsonl'),
    '{"id":"test-1","thread_name":"e2e test","updated_at":"2026-07-17T00:00:00Z"}\n');
});

afterAll(async () => {
  await new Promise(res => server.stop(() => res()));
  rmSync(localDir, { recursive: true, force: true });
});

function localFileList(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) localFileList(p, base, acc);
    else acc.push({
      rel: p.slice(base.length + 1).replace(/\\/g, '/'),
      absPath: p, mtime: st.mtimeMs, size: st.size,
    });
  }
  return acc;
}

describe('e2e: WebDAV sync', () => {
  const davConfig = {
    url: `http://localhost:${PORT}`,
    remote_path: '/codex-sync',
  };

  test('test connection', async () => {
    const dav = createWebDAVClient(davConfig);
    const r = await dav.testConnection();
    expect(r.ok).toBe(true);
    expect(typeof r.latency_ms).toBe('number');
  });

  test('initial sync uploads all local files', async () => {
    const dav = createWebDAVClient(davConfig);
    const localFiles = localFileList(localDir);
    const remoteFiles = await dav.list().catch(() => []);

    const plan = buildPlan({ localFiles, remoteFiles, config: CONFIG });
    expect(plan.to_upload.length).toBe(2);

    const result = await applyPlan({
      plan, config: CONFIG,
      localBase: localDir,
      remoteBase: '/codex-sync',
      webdavClient: dav,
    });
    expect(result.uploaded).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  test('second sync is a no-op', async () => {
    const dav = createWebDAVClient(davConfig);
    const localFiles = localFileList(localDir);
    const remoteFiles = await dav.list();

    const plan = buildPlan({ localFiles, remoteFiles, config: CONFIG });
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.to_download).toHaveLength(0);
    expect(plan.unchanged.length).toBe(2);
  });

  test('remote file downloads to local', async () => {
    const dav = createWebDAVClient(davConfig);
    // put a new remote file directly (client prefixes remote_path itself)
    await dav.putFile('sessions/2026/07/17/rollout-remote-new.jsonl',
      Buffer.from('{"type":"session_meta","payload":{"cwd":"/other"}}\n'));

    const localFiles = localFileList(localDir);
    const remoteFiles = await dav.list();
    const plan = buildPlan({ localFiles, remoteFiles, config: CONFIG });
    expect(plan.to_download).toContain('sessions/2026/07/17/rollout-remote-new.jsonl');

    const result = await applyPlan({
      plan, config: CONFIG,
      localBase: localDir,
      remoteBase: '/codex-sync',
      webdavClient: dav,
    });
    expect(result.downloaded).toBe(1);
    expect(existsSync(join(localDir, 'sessions/2026/07/17/rollout-remote-new.jsonl'))).toBe(true);
  });
});

describe('e2e: cross-device dedup via shared remote manifest (real WebDAV server)', () => {
  const HASH_CONFIG = {
    sync: { compare: 'mtime_hash_fallback', time_tolerance_seconds: 2, equal_mtime_action: 'skip' },
    conflict: { policy: 'manual_abort' },
    backup: { enabled: false },
  };
  const davConfig = { url: `http://localhost:${PORT}`, remote_path: '/codex-sync-crossdevice' };
  let dirA, dirB;

  afterAll(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  test('device A uploads, pushing its hash into the shared remote manifest', async () => {
    dirA = mkdtempSync(join(tmpdir(), 'cxsync-e2e-devA-'));
    mkdirSync(join(dirA, 'sessions/2026/07/17'), { recursive: true });
    writeFileSync(join(dirA, 'sessions/2026/07/17/rollout-shared.jsonl'),
      '{"type":"session_meta","payload":{"cwd":"/shared/proj"}}\n{"type":"message","text":"same everywhere"}\n');
    writeFileSync(join(dirA, 'session_index.jsonl'), '{"id":"shared-1"}\n');

    const dav = createWebDAVClient(davConfig);
    const manifestPathA = join(dirA, '.manifest.json'); // device A has never synced before

    const { prevManifest, localFiles, remoteFiles, sharedRemoteManifest } = await prepareSyncFileSets({
      codexHome: dirA, davClient: dav, manifestPath: manifestPathA,
    });
    const plan = buildPlan({ localFiles, remoteFiles, config: HASH_CONFIG });
    expect(plan.to_upload.length).toBe(2);

    const result = await applyPlan({
      plan, config: HASH_CONFIG, localBase: dirA, remoteBase: davConfig.remote_path, davClient: dav,
    });
    expect(result.uploaded).toBe(2);

    await finalizeManifest({
      manifestPath: manifestPathA, machineId: 'device-A', prevManifest, localFiles, remoteFiles,
      plan, result, sharedRemoteManifest, codexHome: dirA, davClient: dav,
    });

    // the shared manifest really landed on the WebDAV server
    const remoteListing = await dav.list();
    const rels = remoteListing.map(f => f.rel);
    expect(rels).toContain('.cxsync-manifest.json');
  });

  test('shared manifest file itself is filtered out of the plan-building file set', async () => {
    const dav = createWebDAVClient(davConfig);
    const { remoteFiles } = await prepareSyncFileSets({
      codexHome: dirA, davClient: dav,
      manifestPath: join(dirA, '.manifest.json'),
    });
    expect(Object.keys(remoteFiles).some(isRemoteManifestFile)).toBe(false);
  });

  test('device B — brand new machine, never synced before — sees the file as unchanged instead of re-uploading', async () => {
    dirB = mkdtempSync(join(tmpdir(), 'cxsync-e2e-devB-'));
    mkdirSync(join(dirB, 'sessions/2026/07/17'), { recursive: true });
    // identical bytes to what device A uploaded, but with an mtime forced far away (year 2000) —
    // well beyond time_tolerance_seconds, so 'unchanged' can only come from the hash match,
    // never from mtime-tolerance coincidentally overlapping since both tests ran moments apart.
    const farPast = new Date('2000-01-01T00:00:00Z');
    const fileB1 = join(dirB, 'sessions/2026/07/17/rollout-shared.jsonl');
    const fileB2 = join(dirB, 'session_index.jsonl');
    writeFileSync(fileB1, '{"type":"session_meta","payload":{"cwd":"/shared/proj"}}\n{"type":"message","text":"same everywhere"}\n');
    writeFileSync(fileB2, '{"id":"shared-1"}\n');
    utimesSync(fileB1, farPast, farPast);
    utimesSync(fileB2, farPast, farPast);

    const dav = createWebDAVClient(davConfig);
    // device B has never synced before: no manifest.json exists for it anywhere
    const manifestPathB = join(dirB, '.manifest.json');
    expect(existsSync(manifestPathB)).toBe(false);

    const { localFiles, remoteFiles } = await prepareSyncFileSets({
      codexHome: dirB, davClient: dav, manifestPath: manifestPathB,
    });
    const plan = buildPlan({ localFiles, remoteFiles, config: HASH_CONFIG });

    expect(plan.unchanged).toContain('sessions/2026/07/17/rollout-shared.jsonl');
    expect(plan.unchanged).toContain('session_index.jsonl');
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.to_download).toHaveLength(0);
  });
});

describe('e2e: delete propagation with delete_policy=mirror (real WebDAV server)', () => {
  const MIRROR_CONFIG = {
    sync: { compare: 'mtime_hash_fallback', time_tolerance_seconds: 2, equal_mtime_action: 'skip', delete_policy: 'mirror' },
    conflict: { policy: 'manual_abort' },
    backup: { enabled: false },
  };
  const davConfig = { url: `http://localhost:${PORT}`, remote_path: '/codex-sync-delete' };
  let dirC;
  const manifestPathFor = () => join(dirC, '.manifest.json');

  afterAll(() => rmSync(dirC, { recursive: true, force: true }));

  test('setup: a stray .bak file gets synced up like any other tracked file', async () => {
    dirC = mkdtempSync(join(tmpdir(), 'cxsync-e2e-devC-'));
    mkdirSync(join(dirC, 'sessions/2026/07/17'), { recursive: true });
    writeFileSync(join(dirC, 'sessions/2026/07/17/rollout-x.jsonl.bak'), 'a backup nobody wanted uploaded');

    const dav = createWebDAVClient(davConfig);
    const { prevManifest, localFiles, remoteFiles, sharedRemoteManifest } = await prepareSyncFileSets({
      codexHome: dirC, davClient: dav, manifestPath: manifestPathFor(),
    });
    const plan = buildPlan({ localFiles, remoteFiles, config: MIRROR_CONFIG, prevManifestFiles: prevManifest?.files });
    expect(plan.to_upload).toContain('sessions/2026/07/17/rollout-x.jsonl.bak');

    const result = await applyPlan({
      plan, config: MIRROR_CONFIG, localBase: dirC, remoteBase: davConfig.remote_path, davClient: dav,
    });
    expect(result.uploaded).toBe(1);

    await finalizeManifest({
      manifestPath: manifestPathFor(), machineId: 'device-C', prevManifest, localFiles, remoteFiles,
      plan, result, sharedRemoteManifest, codexHome: dirC, davClient: dav,
    });

    const rels = (await dav.list()).map(f => f.rel);
    expect(rels).toContain('sessions/2026/07/17/rollout-x.jsonl.bak');
  });

  test('deleting the file locally and re-syncing with delete_policy=mirror removes it from the remote too', async () => {
    // this is exactly the bug being fixed: without manifest-based delete detection,
    // the next sync would see "remote has it, local doesn't" and download it right back.
    rmSync(join(dirC, 'sessions/2026/07/17/rollout-x.jsonl.bak'));

    const dav = createWebDAVClient(davConfig);
    const { prevManifest, localFiles, remoteFiles, sharedRemoteManifest } = await prepareSyncFileSets({
      codexHome: dirC, davClient: dav, manifestPath: manifestPathFor(),
    });
    const plan = buildPlan({ localFiles, remoteFiles, config: MIRROR_CONFIG, prevManifestFiles: prevManifest?.files });
    expect(plan.to_delete_remote).toContain('sessions/2026/07/17/rollout-x.jsonl.bak');
    expect(plan.to_download).toHaveLength(0); // must NOT bring the deleted file back

    const result = await applyPlan({
      plan, config: MIRROR_CONFIG, localBase: dirC, remoteBase: davConfig.remote_path, davClient: dav,
    });
    expect(result.deletedRemote).toBe(1);

    await finalizeManifest({
      manifestPath: manifestPathFor(), machineId: 'device-C', prevManifest, localFiles, remoteFiles,
      plan, result, sharedRemoteManifest, codexHome: dirC, davClient: dav,
    });

    const rels = (await dav.list()).map(f => f.rel);
    expect(rels).not.toContain('sessions/2026/07/17/rollout-x.jsonl.bak');

    // and the manifest no longer remembers it, so it won't be mistaken for a future deletion
    const finalManifest = JSON.parse(readFileSync(manifestPathFor(), 'utf8'));
    expect(finalManifest.files['sessions/2026/07/17/rollout-x.jsonl.bak']).toBeUndefined();
  });
});
