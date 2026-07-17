# codex-session-sync

本地 Codex 会话同步工具：通过 WebDAV 协议在多台机器间同步 `~/.codex` 状态，并提供 Web GUI 管理界面。

## 功能

- **会话同步**：通过 WebDAV（Nextcloud/坚果云/Synology/任意 WebDAV 服务器）同步 Codex 会话、技能、插件
- **Web GUI**：浏览器管理界面，支持会话浏览、在线重命名、同步进度、备份恢复
- **备份恢复**：同步前自动备份，支持一键恢复到任意快照
- **安全优先**：同步前检测 Codex 进程，仅在 Codex 关闭后执行，备份后再覆盖
- **冲突策略**：`manual_abort` / `prefer_local` / `prefer_cloud` / `prefer_newer_mtime`
- **跨平台**：Windows 优先，兼容 macOS/Linux

## 快速开始

### 安装

```bash
git clone <repo>
cd codex-session-sync
npm install
```

全局安装（可选）：

```bash
npm install -g .
```

### 初始化配置

```bash
cxsync init-config
# 配置文件生成在 ~/.codex-session-sync/config.yml
```

编辑配置，填入你的 WebDAV 信息：

```yaml
webdav:
  url: https://your-nextcloud.com/remote.php/dav/files/username
  username: your_username
  password: your_password
  remote_path: /codex-sync
```

### 启动 Web GUI

```bash
cxsync serve
# 浏览器自动打开 http://localhost:7420
```

## CLI 命令

```
cxsync init-config [--output <path>] [--force]   生成配置文件
cxsync validate                                   验证配置
cxsync doctor                                     预检诊断
cxsync plan                                       预览同步计划（不写文件）
cxsync sync --dry-run                             模拟同步
cxsync sync --apply                               执行同步
cxsync restore --dry-run                          模拟恢复
cxsync restore --apply                            执行恢复（默认取最新快照）
cxsync restore --from <snapshot> --apply          恢复指定快照
cxsync sessions                                   列出本地会话
cxsync serve [--port 7420] [--no-open]            启动 Web GUI
```

## 典型工作流

**机器 A → 机器 B 的会话交接：**

```bash
# 1. 在机器 A 上，关闭 Codex
# 2. 执行同步
cxsync sync --apply

# 3. 等待 WebDAV 云端同步完成（OneDrive/Dropbox/Nextcloud 等）

# 4. 在机器 B 上，关闭 Codex
# 5. 执行同步
cxsync sync --apply

# 6. 重新打开 Codex，会话已同步
```

## Web GUI 功能

| 页面 | 功能 |
|------|------|
| Dashboard | 运行状态、会话统计、快捷操作 |
| 会话管理 | 按项目分组浏览、搜索、双击重命名 |
| 同步 | WebDAV 连接测试、同步计划预览、实时进度 |
| 备份恢复 | 备份列表、立即备份、快照恢复 |

## 配置说明

完整配置见 `config.example.yml`，关键参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `sync.direction` | `bidirectional` | 同步方向：双向/push/pull |
| `sync.session_mode` | `last_date_only` | 同步范围：仅最新日期/全部 |
| `conflict.policy` | `manual_abort` | 冲突策略 |
| `backup.compression` | `none` | 备份压缩：none/zip |
| `backup.retention_days` | `30` | 备份保留天数 |
| `server.port` | `7420` | Web GUI 端口 |

## REST API

服务端 API 文档见 `docs/API.md`，支持通过 HTTP 集成到其他工具。

## 项目结构

```
bin/cxsync.js          CLI 入口
src/
  config.js            配置加载
  scanner.js           扫描本地 ~/.codex
  webdav-client.js     WebDAV 客户端
  sync-engine.js       同步计划与执行（纯逻辑）
  backup.js            快照备份/恢复
  manifest.js          同步清单
  process-check.js     Codex 进程检测
  logger.js            结构化日志
  server.js            Express HTTP 服务器
  api/                 REST API 路由
  doctor.js            预检诊断
web/index.html         Web GUI（单文件 SPA）
test/                  单元测试
docs/API.md            REST API 契约
docs/ARCHITECTURE.md   架构说明
```

## 开发

```bash
npm test          # 运行单元测试
npm run dev       # 开发模式启动（端口 7420）
```

## 安全说明

- **只在 Codex 关闭后同步**：工具会检测 Codex 进程，运行中拒绝执行
- **覆盖前备份**：每次覆盖文件前自动创建备份快照
- **密码存本地**：WebDAV 密码仅存在本机 `config.yml`，不上传

## License

MIT
