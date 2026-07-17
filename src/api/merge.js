// src/api/merge.js — GET /api/providers, POST /api/merge
import { Router } from 'express';
import { listProviders, mergeProviders } from '../merge.js';
import { isCodexRunning } from '../process-check.js';
import { createSnapshot } from '../backup.js';

export const router = Router();

router.get('/providers', async (req, res) => {
  const cfg = req.app.locals.cfg;
  try {
    const result = await listProviders(cfg.codex_home);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/merge', async (req, res) => {
  const cfg = req.app.locals.cfg;
  const log = req.app.locals.log;
  const { from, to, dry_run = true } = req.body;

  try {
    if (!dry_run) {
      // 真实改写前必须确认 Codex 已关闭（sqlite 锁 + 数据一致性）
      if (await isCodexRunning()) {
        return res.status(409).json({ error: 'Codex is running — close it before merging' });
      }
      // 改写前自动备份
      const snapshot = await createSnapshot({
        sourceDir: cfg.codex_home,
        backupDir: cfg.backup_dir,
        compression: cfg.backup.compression,
        include: ['sessions', 'session_index.jsonl', 'state_5.sqlite'],
      });
      log.info(`Pre-merge backup created: ${snapshot}`);
    }

    const result = await mergeProviders({
      codexHome: cfg.codex_home,
      from, to, dryRun: dry_run,
    });
    if (!dry_run) log.info('Provider merge applied', { from, to, ...result });
    res.json({ ok: true, dry_run, from, to, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
