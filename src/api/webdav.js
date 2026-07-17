// src/api/webdav.js — POST /api/config/webdav/test
import { Router } from 'express';
import { createWebDAVClient } from '../webdav-client.js';

export const router = Router();

router.post('/webdav/test', async (req, res) => {
  const { url, username, password, remote_path = '/' } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const dav = createWebDAVClient({ url, username, password, remote_path });
    const result = await dav.testConnection();
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
