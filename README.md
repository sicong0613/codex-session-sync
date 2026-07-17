# codex-session-sync

[中文文档](./README_CN.md)

Sync, back up, and manage local [OpenAI Codex](https://github.com/openai/codex) sessions across machines — via any WebDAV server, with a CLI and a local Web GUI.

## Why

Codex (CLI / Desktop / IDE extension) keeps all conversation state in a local `~/.codex` directory. If you work on more than one machine, your sessions don't follow you. codex-session-sync moves them safely:

- **Cold sync** — only runs when Codex is closed, so state files are never corrupted mid-write
- **Backup before overwrite** — every destructive step snapshots first
- **Local-first** — your data goes only to the WebDAV server you configure; no third-party service, no telemetry

## Features

| Feature | Description |
|---------|-------------|
| WebDAV sync | Bidirectional sync of sessions / skills / plugins with Nextcloud, Synology, Koofr, or any WebDAV server |
| Web GUI | Dashboard, session browser, sync progress (SSE live stream), backup management — at `http://localhost:7420` |
| Session management | Browse by project, search, rename (syncs back into Codex's own UI), delete (cleans all three Codex stores) |
| Provider merge | Merge sessions isolated between ChatGPT web login (`openai`) and API-key login (`custom`) into one visible list |
| Backup & restore | Timestamped snapshots, one-click restore, retention pruning, delete |
| Conflict policies | `manual_abort` / `prefer_local` / `prefer_cloud` / `prefer_newer_mtime` |
| Safety guards | Codex process detection, atomic writes (tmp + rename), path-traversal protection, pre-merge/pre-restore auto-backup |

## Requirements

- Node.js **≥ 22.5** (uses built-in `node:sqlite`; sync/backup alone works on ≥ 18)
- Codex CLI or Codex Desktop installed (a `~/.codex` directory exists)
- Windows / macOS / Linux (Windows is the most battle-tested)

## Installation

```bash
git clone https://github.com/shonngithub/codex-session-sync.git
cd codex-session-sync
npm install

# optional: install the `cxsync` command globally
npm install -g .
```

## Quick start

```bash
# 1. Generate config at ~/.codex-session-sync/config.yml
cxsync init-config

# 2. Edit the config — fill in your WebDAV credentials
#    webdav:
#      url: https://your-server/remote.php/dav/files/username
#      username: your_username
#      password: your_password
#      remote_path: /codex-sync

# 3. Check everything is ready
cxsync doctor

# 4. Start the Web GUI (opens browser automatically)
cxsync serve
```

Or go CLI-only:

```bash
cxsync sync --dry-run   # preview
cxsync sync --apply     # sync for real
```

## CLI reference

```
cxsync init-config [--output <path>] [--force]     Generate config file
cxsync validate                                    Validate config
cxsync doctor                                      Preflight diagnostics
cxsync plan                                        Show sync plan (read-only)
cxsync sync --dry-run | --apply                    Sync local <-> WebDAV
cxsync restore [--from <snapshot>] --apply         Restore from backup
cxsync sessions [--project <name>]                 List local sessions
cxsync merge-providers --list                      Show sessions per login provider
cxsync merge-providers --from openai --to custom --apply   Merge providers
cxsync serve [--port 7420] [--no-open]             Start Web GUI
```

Global flags: `-c <config path>`, `-v` (verbose).

Exit codes: `3` = Codex is running (close it first).

## Typical workflow: machine A → machine B

```bash
# On machine A: close Codex, then
cxsync sync --apply

# Wait for your WebDAV/cloud server to settle

# On machine B: close Codex, then
cxsync sync --apply

# Reopen Codex — sessions are there
```

## Web GUI

| Page | What it does |
|------|--------------|
| Dashboard | Codex process status, session stats, quick actions |
| Sessions | Browse by project, search, double-click rename, delete |
| Sync | WebDAV connection test, plan preview, live progress + log stream |
| Backup | Snapshot list with storage path, create/restore/delete, provider merge |

## How Codex stores sessions (what this tool touches)

| Store | Purpose |
|-------|---------|
| `sessions/YYYY/MM/DD/rollout-*.jsonl` | Conversation content (JSONL, first line is `session_meta`) |
| `session_index.jsonl` | Index used by `codex resume` |
| `state_5.sqlite` → `threads` | Source of truth for the Codex Desktop session list (titles, providers) |

Rename writes stores 2+3 (auto-creating missing index entries). Delete cleans all three. Provider merge rewrites `model_provider` in stores 1+3.

## Configuration

See [`config.example.yml`](./config.example.yml) for the full annotated config. Key options:

| Key | Default | Description |
|-----|---------|-------------|
| `sync.direction` | `bidirectional` | `bidirectional` / `push` / `pull` |
| `sync.session_mode` | `last_date_only` | Sync only latest date folder, or `all` |
| `sync.compare` | `mtime` | `mtime` or `mtime_hash_fallback` (SHA-256 tiebreak) |
| `conflict.policy` | `manual_abort` | Conflict resolution strategy |
| `backup.compression` | `none` | `none` (directory) or `zip` |
| `backup.retention_days` | `30` | Auto-prune old snapshots |
| `server.port` | `7420` | Web GUI port (binds 127.0.0.1 only) |

## REST API

The Web GUI is backed by a documented REST API (`docs/API.md`) — sessions, sync plan/apply (SSE), backups, provider merge, WebDAV test. Integrate it into your own tooling if you like.

## Development

```bash
npm test        # unit + e2e tests (e2e runs against an in-memory WebDAV server)
npm run dev     # start GUI server on :7420
```

Project layout: see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Security notes

- Sync/delete/merge refuse to run while Codex is running (process detection, sqlite lock safety)
- Every overwrite/merge/restore is preceded by an automatic snapshot
- WebDAV credentials live only in your local `config.yml` (never uploaded)
- The GUI server binds to `127.0.0.1` — not reachable from the network

## Acknowledgements

Design informed by [codexSync](https://github.com/kroxiksut/codexSync) (cold-sync handoff, backup-before-overwrite) and codex-session-toolkit variants (web UI session browsing, rename write-back).

## License

MIT
