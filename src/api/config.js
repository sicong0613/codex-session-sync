// src/api/config.js — GET /api/config, PUT /api/config
import { Router } from 'express';

export const router = Router();

router.get('/config', (req, res) => {
  const cfg = structuredClone(req.app.locals.cfg);
  // mask passwords
  if (cfg.webdav?.password) cfg.webdav.password = '***';
  res.json(cfg);
});

router.put('/config', async (req, res) => {
  const cfg = req.app.locals.cfg;
  const updates = req.body;
  // shallow-merge top-level sections
  for (const [k, v] of Object.entries(updates)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      cfg[k] = { ...(cfg[k] ?? {}), ...v };
    } else {
      cfg[k] = v;
    }
  }
  res.json({ ok: true });
});
