// src/doctor.js — preflight diagnostics
import { existsSync, accessSync, constants } from 'fs';
import { resolve } from 'path';

export async function runDoctor(cfg, log) {
  const checks = [];

  // 1. codex_home exists and readable
  checks.push(check(
    'codex_home exists',
    () => existsSync(cfg.codex_home),
    `${cfg.codex_home} not found`
  ));
  checks.push(check(
    'codex_home readable',
    () => { accessSync(cfg.codex_home, constants.R_OK); return true; },
    `${cfg.codex_home} not readable`
  ));

  // 2. session_index.jsonl exists
  const indexPath = resolve(cfg.codex_home, 'session_index.jsonl');
  checks.push(check(
    'session_index.jsonl exists',
    () => existsSync(indexPath),
    `${indexPath} not found — is Codex installed?`
  ));

  // 3. Codex not running
  const { isCodexRunning } = await import('./process-check.js');
  const running = await isCodexRunning().catch(() => null);
  checks.push({
    name: 'Codex not running',
    ok: running === false,
    warning: running === null,
    message: running ? 'Codex is running — close it before syncing' : running === null ? 'Could not detect process state' : null,
  });

  // 4. WebDAV configured
  const davCfg = cfg.webdav;
  const davConfigured = !!(davCfg.url && davCfg.username);
  checks.push({
    name: 'WebDAV configured',
    ok: davConfigured,
    warning: !davConfigured,
    message: davConfigured ? null : 'WebDAV not configured — set webdav.url and webdav.username in config',
  });

  // 5. WebDAV reachable (only if configured)
  if (davConfigured) {
    try {
      const { createWebDAVClient } = await import('./webdav-client.js');
      const dav = createWebDAVClient(davCfg);
      const result = await dav.testConnection();
      checks.push({
        name: 'WebDAV reachable',
        ok: result.ok,
        message: result.ok ? null : result.error,
      });
    } catch (e) {
      checks.push({ name: 'WebDAV reachable', ok: false, message: e.message });
    }
  }

  // 6. backup_dir writable
  const { mkdirSync } = await import('fs');
  try {
    mkdirSync(cfg.backup_dir, { recursive: true });
    accessSync(cfg.backup_dir, constants.W_OK);
    checks.push({ name: 'backup_dir writable', ok: true });
  } catch (e) {
    checks.push({ name: 'backup_dir writable', ok: false, message: e.message });
  }

  // Print results
  let allOk = true;
  for (const c of checks) {
    const icon = c.ok ? '✓' : c.warning ? '⚠' : '✗';
    const msg = c.message ? ` — ${c.message}` : '';
    console.log(`${icon} ${c.name}${msg}`);
    if (!c.ok && !c.warning) allOk = false;
  }

  return allOk;
}

function check(name, fn, failMsg) {
  try {
    const ok = fn();
    return { name, ok: !!ok, message: ok ? null : failMsg };
  } catch (e) {
    return { name, ok: false, message: e.message || failMsg };
  }
}
