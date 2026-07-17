// src/api/backup.js — GET /api/backups, POST /api/backup, POST /api/restore
import { Router } from 'express';
import { listSnapshots, createSnapshot, restoreSnapshot } from '../backup.js';
import { sseStream } from '../server.js';

export const router = Router();

router.get('/backups', async (req, res) => {
  const cfg = req.app.locals.cfg;
  try {
    const backups = await listSnapshots(cfg.backup_dir);
    res.json({ backups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 备份只包含同步相关的根路径，避免复制巨大的缓存目录
const BACKUP_INCLUDE = ['sessions', 'session_index.jsonl', 'skills', 'plugins'];

router.post('/backup', async (req, res) => {
  const cfg = req.app.locals.cfg;
  const log = req.app.locals.log;
  try {
    const name = await createSnapshot({
      sourceDir: cfg.codex_home,
      backupDir: cfg.backup_dir,
      compression: cfg.backup.compression,
      include: BACKUP_INCLUDE,
    });
    log.info(`Backup created: ${name}`);
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/restore', async (req, res) => {
  const cfg = req.app.locals.cfg;
  const log = req.app.locals.log;
  const { snapshot, target = 'local' } = req.body;
  const sse = sseStream(res);

  try {
    const snaps = await listSnapshots(cfg.backup_dir);
    const snap = snapshot
      ? snaps.find(s => s.name === snapshot)
      : snaps[snaps.length - 1];

    if (!snap) {
      sse.send({ type: 'error', message: snapshot ? `Snapshot not found: ${snapshot}` : 'No backups available' });
      sse.end(); return;
    }

    sse.send({ type: 'start', snapshot: snap.name });

    const targetDir = target === 'cloud' ? null : cfg.codex_home;
    await restoreSnapshot({
      snapshot: snap.name,
      backupDir: cfg.backup_dir,
      targetDir,
      onProgress: (p) => sse.send({ type: 'progress', ...p }),
    });

    log.info(`Restore complete: ${snap.name} → ${target}`);
    sse.send({ type: 'done', snapshot: snap.name, target });
  } catch (e) {
    log.error('restore error', { message: e.message });
    sse.send({ type: 'error', message: e.message });
  } finally {
    sse.end();
  }
});
