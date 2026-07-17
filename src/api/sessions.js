// src/api/sessions.js — GET /api/sessions, GET/PATCH/DELETE /api/sessions/:id
import { Router } from 'express';
import { scanCodexHome, readSessionMessages } from '../scanner.js';
import { renameSession, deleteSession, getDbTitles } from '../session-ops.js';
import { isCodexRunning } from '../process-check.js';

export const router = Router();

// helper: scanner returns sessions grouped by cwd — flatten to array
function flatSessions(grouped) {
  return Object.values(grouped).flat();
}

// helper: 用 sqlite threads.title 补全 index 里缺失的标题
function enrichTitles(list, codexHome) {
  const dbTitles = getDbTitles(codexHome);
  for (const s of list) {
    if (!s.thread_name) {
      const t = dbTitles.get(s.id);
      // 数据库标题可能是首条用户消息全文，截断到 60 字符做显示名
      if (t?.title) s.thread_name = t.title.split('\n')[0].slice(0, 60);
    }
  }
  return list;
}

router.get('/', async (req, res) => {
  const cfg = req.app.locals.cfg;
  try {
    const { sessions } = await scanCodexHome(cfg.codex_home);
    const list = enrichTitles(flatSessions(sessions), cfg.codex_home);
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
  const log = req.app.locals.log;
  const { thread_name } = req.body;
  if (!thread_name) return res.status(400).json({ error: 'thread_name required' });
  try {
    const result = renameSession(cfg.codex_home, req.params.id, thread_name);
    log.info(`Session renamed: ${req.params.id}`, result);
    res.json({ ok: true, ...result });
  } catch (e) {
    const code = /not found/i.test(e.message) ? 404 : 500;
    res.status(code).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const cfg = req.app.locals.cfg;
  const log = req.app.locals.log;
  try {
    // 删除会写 sqlite，Codex 运行中会持锁且可能立即重建数据
    if (await isCodexRunning()) {
      return res.status(409).json({ error: 'Codex is running — close it before deleting sessions' });
    }
    const result = deleteSession({ codexHome: cfg.codex_home, sessionId: req.params.id });
    log.info(`Session deleted: ${req.params.id}`, result);
    res.json({ ok: true, ...result });
  } catch (e) {
    const code = /not found/i.test(e.message) ? 404 : 500;
    res.status(code).json({ error: e.message });
  }
});
