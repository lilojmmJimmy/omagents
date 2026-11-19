# MyAgents（v0.1c）

纯服务端、自研 React Web 接入的多 Agent 中间层与工作区协作管理平台（TypeScript + Node.js 22+ `node:sqlite` + React Web）。

## 交付进展与路线图总览

当前已完整交付并验收 **`v0.1a`、`v0.1b`、`v0.1c`** 全部主干里程碑，现阶段收尾总结与下一阶段（`v0.1c` 补强 / `v0.2+` 生态治理）待办清单见：
- **[项目里程碑总结与下阶段任务路线图](./docs/PROJECT-STATUS-AND-ROADMAP.md)**

各阶段验收报告与 v2.0 完整设计基线见 [docs/README.md](./docs/README.md)：
- [01-PRD-FEATURES.md](./docs/01-PRD-FEATURES.md) — 功能规格与分期路线
- [02-ARCHITECTURE.md](./docs/02-ARCHITECTURE.md) — 系统架构与 5 层 Agent 环境隔离设计
- [03-DOMAIN-DESIGN.md](./docs/03-DOMAIN-DESIGN.md) — 领域模型、无死锁 `WorkNode` 状态机、写优先读写锁、Reducer + 双节拍引擎
- [04-API-PROTOCOL.md](./docs/04-API-PROTOCOL.md) — HTTP Auth / Webhook / WS JSON-RPC 2.0 / 独立终端 WS / Daemon NDJSON / SPI 契约
- [05-DATABASE-DESIGN.md](./docs/05-DATABASE-DESIGN.md) — Node 22 原生 `node:sqlite` 数据库设计
- 阶段验收报告：[v0.1a](./docs/V0.1A-TEST-REPORT.md) · [v0.1b](./docs/V0.1B-TEST-REPORT.md) · [v0.1c](./docs/V0.1C-TEST-REPORT.md)

## 核心能力摘要

- **多驱动 Agent 与 5 层环境隔离**：内置轻量 `BuiltinDriver`（OpenAI 兼容 API）+ 外部 CLI 托管（`ClaudeCodeDriver`、`CodexCliDriver`、`AcpCliDriver`）；支持 `standard` / `isolated-home` / `lockdown` 三级隔离、`spawnPipeClean` 净环境、配置漂移 `configHash` 检测与多 Agent 房间双层禁私开 Subagent。
- **`open-channel` 开放协作群**：固定成员编组、`@成员`/`@everyone` 与 Lead 路由、DAG 前置依赖、两阶段 `work_deliveries`、Git Worktree 并行隔离（`RepoMutex`）、抗重启 stdio MCP 桥（`collab_*`）及右侧工作台「任务」树。
- **`roundtable` 圆桌讨论室（Pregel Super-step）**：首轮盲答私有隔离与 Barrier 原子揭晓、匿名掩码（`成员 A/B/C`）、中途插话保留轮次、部分失败暂停恢复、立场收敛总结与一键「转交执行」（继承 `sharedMemories`）。
- **统一收件箱（Unified Inbox）**：原生 `generic-webhook`（Header/Bearer 验签）与 `github-webhook`（HMAC-SHA256 原始字节验签）`SourcePlugin`、幂等去重、优先级自动路由（默认 `allowWrite = false` Lockdown 防注入）、手动建单指派与根任务完成自动 `resolved`。
- **工作区与自研 Web 工作台**：私有工作区与本地 Git 目录挂载、三栏可调宽布局、流式 CoT 思考过程与 Token 速度/上下文指标、文件编辑乐观锁、Git Diff 与 `daemon` 保活的 Web 交互终端（`core` 重启不断线）。

## 快速启动

### 环境要求
- **Node.js >= 22.13**（使用原生 `node:sqlite`，`core` 零 C++ 编译依赖）
- **pnpm**
- 可选：**Claude Code CLI** / **Codex CLI** / **Gemini CLI**（在设置页或环境检测自动识别）

### 安装与构建
```bash
pnpm install
pnpm build
```

### 运行方式

**方式 A：生产单端口运行（推荐验收）**
```bash
pnpm start
```
打开浏览器访问 `http://127.0.0.1:3210`（默认账号 `admin` / 密码 `admin`）。

> 如需局域网/公网访问，可设置环境变量：  
> `MYAGENTS_HOST=0.0.0.0 MYAGENTS_PORT=3210 MYAGENTS_ADMIN_PASS=你的强密码 pnpm start`

**方式 B：开发模式（热重载）**
```bash
pnpm dev
```
开发模式同时启动 `daemon`、`core`（`:3210`）与 `web`（Vite `:5173`，自动代理到 `:3210`）。

### 测试与检查
```bash
pnpm build
pnpm test
node scripts/smoke.mjs
node --import tsx scripts/verify-claude-v01b-live.mjs --mock-anthropic
```

## 致谢与许可
`packages/daemon` 进程宿主与 `packages/protocol/src/node` 跨平台启动/协议模块部分借鉴适配自 [Antumi](https://github.com/flyhero/antumi)（Apache License 2.0）。
