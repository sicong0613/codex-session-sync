# codex-session-sync

[English](./README.md)

本地 [OpenAI Codex](https://github.com/openai/codex) 会话同步、备份与管理工具——通过任意 WebDAV 服务器跨机器同步，提供 CLI 和本地 Web GUI。

## 为什么需要它

Codex（CLI / Desktop / IDE 插件）把所有会话状态存在本地 `~/.codex` 目录。多台电脑工作时，会话不会跟着你走。codex-session-sync 安全地解决这个问题：

- **冷同步** —— 仅在 Codex 关闭后执行，杜绝写入中途损坏状态文件
- **覆盖前备份** —— 每个破坏性操作前先自动创建快照
- **本地优先** —— 数据只发往你自己配置的 WebDAV 服务器，无第三方服务、无遥测

## 功能

| 功能 | 说明 |
|------|------|
| WebDAV 同步 | 与 Nextcloud、群晖、坚果云或任意 WebDAV 服务器双向同步 sessions / skills / plugins |
| Web GUI | 仪表盘、会话浏览、同步实时进度（SSE）、备份管理 —— `http://localhost:7420` |
| 会话管理 | 按项目分组浏览、搜索、重命名（同步写回 Codex 自身 UI）、删除（清理 Codex 全部三处存储） |
| 登录方式合并 | 合并 ChatGPT 页面授权登录（`openai`）与 API key 登录（`custom`）相互隔离的会话列表 |
| 备份恢复 | 时间戳快照、一键恢复、过期清理、删除 |
| 冲突策略 | `manual_abort` / `prefer_local` / `prefer_cloud` / `prefer_newer_mtime` |
| 安全防护 | Codex 进程检测、原子写入（tmp + rename）、路径穿越防护、合并/恢复前自动备份 |

## 环境要求

- Node.js **≥ 22.5**（会话重命名/删除/合并用到内建 `node:sqlite`；仅同步/备份 ≥ 18 即可）
- 已安装 Codex CLI 或 Codex Desktop（存在 `~/.codex` 目录）
- Windows / macOS / Linux（Windows 实测最充分）

## 安装

```bash
git clone https://github.com/shonngithub/codex-session-sync.git
cd codex-session-sync
npm install

# 可选：全局安装 cxsync 命令
npm install -g .
```

## 快速开始

```bash
# 1. 生成配置文件（~/.codex-session-sync/config.yml）
cxsync init-config

# 2. 编辑配置，填入 WebDAV 信息
#    webdav:
#      url: https://your-server/remote.php/dav/files/username
#      username: 用户名
#      password: 密码
#      remote_path: /codex-sync

# 3. 预检环境
cxsync doctor

# 4. 启动 Web GUI（自动打开浏览器）
cxsync serve
```

纯命令行方式：

```bash
cxsync sync --dry-run   # 预览
cxsync sync --apply     # 执行同步
```

## CLI 命令参考

```
cxsync init-config [--output <path>] [--force]     生成配置文件
cxsync validate                                    验证配置
cxsync doctor                                      预检诊断
cxsync plan                                        查看同步计划（只读）
cxsync sync --dry-run | --apply                    本地 <-> WebDAV 同步
cxsync restore [--from <snapshot>] --apply         从备份恢复
cxsync sessions [--project <name>]                 列出本地会话
cxsync merge-providers --list                      查看各登录方式的会话数
cxsync merge-providers --from openai --to custom --apply   合并登录方式
cxsync serve [--port 7420] [--no-open]             启动 Web GUI
```

全局参数：`-c <配置路径>`、`-v`（详细日志）。

退出码：`3` = Codex 正在运行（请先关闭）。

## 典型工作流：机器 A → 机器 B

```bash
# 机器 A：关闭 Codex，然后
cxsync sync --apply

# 等待 WebDAV/云端同步完成

# 机器 B：关闭 Codex，然后
cxsync sync --apply

# 重新打开 Codex，会话已到位
```

## Web GUI 页面

| 页面 | 功能 |
|------|------|
| Dashboard | Codex 进程状态、会话统计、快捷操作 |
| 会话管理 | 按项目分组、搜索、双击重命名、删除 |
| 同步 | WebDAV 连接测试、计划预览、实时进度和日志流 |
| 备份恢复 | 快照列表（含存储路径）、创建/恢复/删除、登录方式合并 |

## Codex 会话的存储结构（本工具触及的部分）

| 存储 | 用途 |
|------|------|
| `sessions/YYYY/MM/DD/rollout-*.jsonl` | 会话内容本体（JSONL，首行为 `session_meta`） |
| `session_index.jsonl` | `codex resume` 使用的索引 |
| `state_5.sqlite` → `threads` 表 | Codex Desktop 会话列表的权威来源（标题、登录方式） |

重命名写入 2+3（索引缺失条目时自动补建）；删除清理全部三处；登录方式合并改写 1+3 中的 `model_provider`。

## 配置说明

完整注释配置见 [`config.example.yml`](./config.example.yml)。关键参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `sync.direction` | `bidirectional` | `bidirectional` / `push` / `pull` |
| `sync.session_mode` | `last_date_only` | 仅同步最新日期目录，或 `all` 全部 |
| `sync.compare` | `mtime` | `mtime` 或 `mtime_hash_fallback`（SHA-256 二次校验） |
| `conflict.policy` | `manual_abort` | 冲突解决策略 |
| `backup.compression` | `none` | `none`（目录）或 `zip` |
| `backup.retention_days` | `30` | 快照自动清理天数 |
| `server.port` | `7420` | Web GUI 端口（仅绑定 127.0.0.1） |

## REST API

Web GUI 背后是一套文档化的 REST API（`docs/API.md`）——会话、同步计划/执行（SSE）、备份、登录方式合并、WebDAV 测试，可集成到你自己的工具链。

## 开发

```bash
npm test        # 单元测试 + e2e（e2e 对内存 WebDAV 服务器执行完整同步循环）
npm run dev     # 在 :7420 启动 GUI 服务
```

项目结构见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 安全说明

- 同步/删除/合并在 Codex 运行时拒绝执行（进程检测 + sqlite 锁安全）
- 每次覆盖/合并/恢复前自动创建快照
- WebDAV 凭据仅存于本机 `config.yml`，绝不上传
- GUI 服务只绑定 `127.0.0.1`，局域网不可达

## 致谢

设计参考了 [codexSync](https://github.com/kroxiksut/codexSync)（冷同步交接、覆盖前备份）以及 codex-session-toolkit 系列（Web UI 会话浏览、重命名写回）。

## License

MIT
