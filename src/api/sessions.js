// src/api/sessions.js — GET /api/sessions, GET /api/sessions/:id, PATCH /api/sessions/:id
import { Router } from 'express';
import { scanCodexHome, readSessionMessages, updateSessionName } from '../scanner.js';

export const router = Router();

// helper: scanner returns sessions grouped by cwd — flatten to array
function flatSessions(grouped) {
  return Object.values(grouped).flat();
}

router.get('/', async (req, res) => {
  const cfg = req.app.locals.cfg;
  try {
    const { sessions } = await scanCodexHome(cfg.codex_home);
    const list = flatSessions(sessions);
    res.json({ sessions: list, total: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  const cfg = req.app.locals.cfg;
  try {
    const { sessions } = await scanCodexHome(cfg.codex_home);
    const session = flatSessions(sessions).find(s => s.id === req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const messages = await readSessionMessages(session.file).catch(() => []);
    res.json({ ...session, messages: messages.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', async (req, res) => {
  const cfg = req.app.locals.cfg;
  const { thread_name } = req.body;
  if (!thread_name) return res.status(400).json({ error: 'thread_name required' });
  try {
    await updateSessionName(cfg.codex_home, req.params.id, thread_name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
