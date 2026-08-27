# codex-session-sync — Architecture

## Module tree

```
bin/
  cxsync.js              CLI entry point (Commander)
src/
  config.js              Load & validate config.yml
  scanner.js             Walk ~/.codex, parse session_index.jsonl
  webdav-client.js       webdav npm wrapper (list/stat/get/put/mkdir)
  manifest.js            Read/write sync manifest; sha256 cache (local+remote) keyed by mtime+size
  sync-engine.js         Build plan, resolve conflicts, apply (copy/skip/abort)
  backup.js              Snapshot creation & restore, zip support
  process-check.js       Detect codex.exe / codex process, optional terminate
  logger.js              Structured logger (text/json), daily rotation
  server.js              Express HTTP server + SSE bus
  api/
    sessions.js          GET /api/sessions, GET /api/sessions/:id
    sync.js              POST /api/sync/plan, POST /api/sync/apply (SSE)
    backup.js            GET /api/backups, POST /api/restore
    webdav.js            GET|POST /api/config/webdav (test connection)
    config.js            GET|PUT /api/config
web/
  index.html             Single-file SPA (no build step)
test/
  sync-engine.test.js
  backup.test.js
  scanner.test.js
docs/
  API.md                 REST contract
  ARCHITECTURE.md        This file
```

## Data flow

```
~/.codex  →  scanner  →  plan(sync-engine)  →  apply
                               ↑                  ↓
                         manifest.json       webdav-client / fs
                                                   ↓
                                              backup (before overwrite)
```

## Config shape (config.yml)

```yaml
codex_home: ~/.codex          # local Codex state dir
machine_id: machine-a
sync:
  mode: cold                  # cold only (Codex must be closed)
  direction: bidirectional    # bidirectional | push | pull
  compare: mtime_hash_fallback  # mtime | mtime_hash_fallback
  time_tolerance_seconds: 2
  equal_mtime_action: skip    # skip | prefer_local | prefer_cloud | manual_abort
  delete_policy: never          # never | mirror (deletion propagates using manifest.json as the "was this ever synced" record)
  session_mode: last_date_only  # all | last_date_only
conflict:
  policy: manual_abort        # manual_abort | prefer_cloud | prefer_local | prefer_newer_mtime
backup:
  enabled: true
  compression: none           # none | zip
  retention_days: 30
  max_backups: 0
webdav:
  url: https://example.com/dav
  username: user
  password: pass
  remote_path: /codex-sync
server:
  port: 7420
  open_browser: true
logging:
  level: INFO
  file: ~/.codex-session-sync/logs/sync.log
```
