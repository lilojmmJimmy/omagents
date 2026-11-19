# MyAgents 项目里程碑总结与下阶段任务路线图

> **当前基线版本**：`v0.1c`（已完成 `v0.1a` → `v0.1b` → `v0.1c` 全阶段核心能力与验收闭环）  
> **维护日期**：2026-11-19  
> **定位**：本文档沉淀迄今为止的全部研发成果、质量基线、已踩坑修复记录以及下一阶段（`v0.1c` 补强与 `v0.2+`）待办任务清单，作为当前阶段收尾与后续继续开发的单一总览入口。

---

## 1. 当前总体状态

MyAgents 现已建成一个 **纯服务端、纯自研 React Web 接入、零 C++ 编译依赖（Node.js 22+ 原生 `node:sqlite`）** 的多 Agent 控制面，支持单条命令（`pnpm start`）开箱运行，覆盖：

1. **双轨单 Agent 执行与热重启保活（`v0.1a` + 体验打磨）**
2. **5 层 Agent 环境隔离 + 无竞态/无死锁 `open-channel` 多 Agent 协作 + Git Worktree 并行隔离（`v0.1b`）**
3. **Pregel Super-step `roundtable` 圆桌讨论室 + 统一收件箱 / Webhook / `SourcePlugin` / 自动路由防注入隔离 + `Codex` / `ACP` CLI 适配（`v0.1c`）**

---

## 2. 迄今已完成工作全景清单

### 2.1 阶段 0：v2.0 架构与数据库设计定稿
- 完成并合入评审结论，定稿五大核心规范文档：[01-PRD-FEATURES.md](./01-PRD-FEATURES.md)、[02-ARCHITECTURE.md](./02-ARCHITECTURE.md)、[03-DOMAIN-DESIGN.md](./03-DOMAIN-DESIGN.md)、[04-API-PROTOCOL.md](./04-API-PROTOCOL.md)、[05-DATABASE-DESIGN.md](./05-DATABASE-DESIGN.md)（评审历史见 [DESIGN-REVIEW.md](./DESIGN-REVIEW.md)）。
- 确立关键架构边界：Per-Room 同步原子事务（`node:sqlite` 同步事务避免跨 `await` 竞态）、固定成员禁止私开 Subagent、`room_member_id` 一等席位串行、`WorkNode` 单一真相源、两阶段 `work_deliveries`、以及借鉴自 Antumi 的极薄 `daemon` 进程保活与环境隔离架构。

### 2.2 阶段 1：`v0.1a` 单 Agent 双轨基座与前端体验打磨
- **5 子包工程骨架**：搭建 `packages/protocol`（纯 Zod 契约 + `@myagents/protocol/node`）、`packages/plugin-sdk`、`packages/daemon`（stdio NDJSON `pipe-session` + ConPTY/PTY `pty-session` + 环形输出缓冲）、`packages/core` 与 `packages/web`（React 19 + Vite + Tailwind + Zustand + `@xterm/xterm`）。
- **极简安全基线**：`admin/admin` 登录与 `scryptSync` 加盐哈希落库、Web 设置页改密、`HttpOnly` Cookie / Bearer 鉴权、WS `Origin` 同源校验。
- **双轨驱动**：
  - `BuiltinDriver`（`packages/core/src/runtime/builtin-driver.ts`）：OpenAI 兼容流式 Tool-Calling + ReAct 循环，内置 7 类工作区读写/检索/Diff/命令工具及 `<think>` 流式 CoT 抽取；
  - `ClaudeCodeDriver`（`packages/core/src/runtime/claude-driver.ts`）：托管外部 `claude` CLI（`stream-json` + 初始化控制握手 + `nativeSessionId` 续接 + `.jsonl` 会话文件定位）。
- **工作区与 Web 工作台**：Agent 私有目录 + 本地 Git 项目目录挂载；路径穿越/符号链接越界沙箱（`path-guard.ts`）；文件读写 `expectedMtimeMs` 乐观锁；HTTP 上传/下载；Git 状态与 Unified Diff；`/ws/terminal/:id` 独立实时终端与 `core` 热重启保活。
- **交互细节打磨**：实现三栏（左侧导航、主对话区、右侧 Dock）拖拽调宽及持久化；补充 CoT 思考过程折叠卡片、上下文占用、Token 生成速率（`tok/s`）、首字耗时/总耗时统计，以及基于文件会话的外部 CLI `.jsonl` 路径展示与一键复制（数据库存储的 Builtin 会话 intentionally 不显示路径）。

### 2.3 阶段 2：`v0.1b` 5 层环境隔离与 `open-channel` 无竞态协作
- **5 层环境隔离（`environment-isolator.ts`）**：`daemon.spawnPipeClean` 净环境启动；`isolated-home` / `lockdown` 独立 `CLAUDE_CONFIG_DIR`；按是否绑定宿主机 `providerId` 精确门控 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`；多 Agent 场景参数层 + 提示词层双层封堵 `Agent`/`Task` 子代理；`lockdown` / `fenced-ro` 规则及 16 位 SHA-256 `configHash` 漂移重建。
- **无死锁/无竞态调度器与协作原语（`collab-engine.ts` / `open-channel-strategy.ts` / `context-builder.ts`）**：实现固定群成员 `@成员`（含中文无空格前缀最长匹配）/`@everyone` 路由与 `@Lead` 兜底；`waiting_children` 让锁挂起与两阶段 `work_deliveries` 唤醒；`work_node_deps` DAG 依赖与环检测；`member_reply`、`transfer`、并发防爆炸护栏；`paused` 房间状态不变量保护；`reassign`/`stop`/`continue`/`cancel`/`retry` 级联控制。
- **Git Worktree 并行隔离与写优先锁（`worktree-service.ts` / `rw-lock.ts`）**：`RepoMutex` 串行管理 `git worktree` 创建与强清理；支持子任务自动隔离分支并由审核者继承只读检查；`isWorktreeDir` 免除主仓库写锁序列化阻塞。
- **抗重启 stdio MCP 桥（`packages/core/src/mcp/`）**：单一 `collab-tools.json` 定义 5 个 `collab_*` 原语；纯 ESM `mcp-bridge.mjs` 每次调用现读 `<home>/run/core.json`（失败短退避重试），经 `timingSafeEqual` 校验调用 `/api/internal/mcp/call`，`Core` 热重启更换端口与 Token 后在途 MCP 桥无需重启即可续调。
- **Web 端升级**：支持创建 `开放协作群 (多 Agent)`、配置隔离级别、管理 Git Worktree、展示右侧 `任务` 树与房间共享记忆。

### 2.4 阶段 3：`v0.1c` Super-step 圆桌讨论室、统一收件箱与多 CLI 适配
- **SQLite Migration `v3`**：幂等新增 `work_nodes.source_trust_level`，新建 `webhooks`、`routing_rules`、`plugin_instances`、`inbox_items`、`background_jobs`、`approval_requests` 表（`packages/core/src/storage/database.ts`）。
- **Pregel Super-step 圆桌引擎（`roundtable-strategy.ts`）**：激活 `executionModel: 'superstep'` 与纯 `reduceState` 归约器；首轮盲答私有消息隔离（`visibilityScope: 'private'`）并在 Super-step Barrier 原子揭晓（推送 `room.messagesRevealed`，且在 Barrier 前先同步热会话 `last_delivered_seq` 确保下一超步精确增量投递）；支持匿名掩码（`成员 A / B / C` 及正文中 `@名称` 脱敏）；讨论中途人类插话保持当前轮次不重置；单席位失败进入 `paused_partial_failure` 暂停并支持 `next_round` / `summarize_now`；多轮立场收敛自动触发 Chair `summary` 定论；`rooms.handoff` 支持将圆桌总结与 `sharedMemories` 无损转交至新 `open-channel` / `single` 房间执行。
- **统一收件箱、Webhook 与 `SourcePlugin`（`inbox-service.ts` / `plugin-manager.ts` / `http-server.ts` / `rpc-router.ts`）**：封装 Fastify `/webhooks` 独立原始 `Buffer` 解析作用域（不影响 `/api/*`）；支持 `generic-webhook`（`X-Webhook-Secret` / `Authorization: Bearer` / `?secret=`，SHA-256 + `timingSafeEqual`）与 `github-webhook`（HMAC-SHA256 `X-Hub-Signature-256` 原始字节验签）；`UNIQUE(source, source_instance_id, external_key)` 幂等去重；优先级路由规则默认 `allowWrite = false`（强制 `forceReadOnly / lockdown` 防注入隔离）；支持手动建单、人工指派及根节点完成后自动置为 `resolved`。
- **多 CLI 驱动与环境探测（`cli-drivers.ts` / `env-check.ts`）**：新增 `CodexCliDriver`（`codex exec --json` + 只读 `--sandbox read-only`）与 `AcpCliDriver`（`gemini -p ... --output-format stream-json` + 只读 `--approval-mode plan`）；`EnvCheckService` 并行探测 `git`、`claude`、`codex`、`gemini`。
- **Web 端 `v0.1c` 工作台**：左侧导航新增 `收件箱`（`InboxView.tsx`：工单队列 / Webhook 与插件 / 自动路由规则三页签）；新建会话弹窗新增 `圆桌讨论室` 页签与 `主责 Chair`；`ChatView.tsx` 新增轮次状态、`下一轮` / `立即总结` / `转交执行` 弹窗与 `圆桌总结` / `盲答·待揭晓` / `收件箱工单` 标识；`AgentsView.tsx` 开放 `codex` / `acp` 驱动选择。

### 2.5 代码目录结构速查

| 目录 / 文件 | 职责说明 |
| :--- | :--- |
| `packages/protocol/src/` | 全量 Zod Schema（`models.ts` / `room.ts` / `collab.ts` / `inbox.ts` / `rpc.ts`）与跨平台 Node 工具（`node/`） |
| `packages/plugin-sdk/src/` | 外部来源/策略插件 SPI（`SourcePlugin`、`InboundEnvelope`、`PluginContext`、`StrategyPlugin`） |
| `packages/daemon/src/` | 跨平台极薄进程宿主（Pipe/PTY/ConPTY 会话与环形缓冲） |
| `packages/core/src/collab/` | `CollabEngine`、`single-strategy`、`open-channel-strategy`、`roundtable-strategy`、`context-builder`、`rw-lock` |
| `packages/core/src/inbox/` | `InboxService`（Webhook/路由/工单生命周期）、`PluginManager`（`generic-webhook` / `github-webhook`） |
| `packages/core/src/runtime/` | `BuiltinDriver`、`ClaudeCodeDriver`、`CodexCliDriver`、`AcpCliDriver`、`AgentEnvironmentIsolator`、`EnvCheckService`、`AgentService`、`ProviderService` |
| `packages/core/src/mcp/` | `collab-tools.json`、抗重启 stdio `mcp-bridge.mjs`、`mcp-config.ts` |
| `packages/core/src/workspace/` | `WorkspaceService`、`WorktreeService`、`GitService`、`TerminalService`、`path-guard.ts` |
| `packages/core/src/storage/` | `CoreDatabase`（SQLite WAL + Migration v1–v3） |
| `packages/core/src/security/` | `AuthService`（scrypt 会话）与安全 Hooks（`hooks.ts`） |
| `packages/core/src/transport/` | Fastify HTTP 服务（含 `/webhooks` 隔离作用域）与 WS `/rpc` 路由 |
| `packages/web/src/` | React 19 前端（`App.tsx`、`store/app-store.ts`、`components/{ChatView,InboxView,AgentsView,WorkspacesView,WorkspaceDock,SettingsView,LoginView}.tsx`） |
| `scripts/` | `dev.mjs`、`start.mjs`、`smoke.mjs`、`verify-claude-live.mjs`、`verify-claude-v01b-live.mjs` |
| `docs/` | `01~05` 设计基线、评审记录及 `V0.1A/B/C-TEST-REPORT.md` 验收报告 |

---

## 3. 当前验证与质量基线

最新源码状态下实测通过的全部检查（详单见 [V0.1A-TEST-REPORT.md](./V0.1A-TEST-REPORT.md)、[V0.1B-TEST-REPORT.md](./V0.1B-TEST-REPORT.md)、[V0.1C-TEST-REPORT.md](./V0.1C-TEST-REPORT.md)）：

| 检查项 | 最新实测结果 | 备注与已知边界 |
| :--- | :--- | :--- |
| **`pnpm build`** | **通过（退出码 `0`）** | Vite v6.4.6（`1856 modules`）+ `protocol` / `plugin-sdk` / `daemon` / `web` / `core` 全部 `tsc -p .` 通过 |
| **`pnpm test`** | **通过（11 文件 / 26 用例，0 失败、0 跳过，`36.60s`）** | 覆盖单聊、Worktree、路径沙箱、读写锁、环境隔离、`open-channel`、MCP 热重启、`roundtable` Super-step、收件箱/Webhook/Lockdown、`Codex`/`ACP` 驱动单测 |
| **`node scripts/smoke.mjs`** | **通过（退出码 `0`）** | `daemon` + `core` + 静态页面完整拉起，`/api/health` 正常 |
| **`verify-claude-v01b-live.mjs --mock-anthropic`** | **通过（退出码 `0`）** | 宿主机真实 `claude 2.1.325` + `isolated-home` + MCP 桥打通（宿主机默认 OAuth 网关当前因网络返回 `api_retry`，故默认启用 `--mock-anthropic` 离线桩验闭环） |
| **真机浏览器 Web UI 验收** | **三阶段均通过（0 控制台/页面/HTTP 报错）** | 已覆盖登录、三栏调宽、单聊/CoT/指标、协作群/任务树/Git Diff/终端、圆桌讨论与转交执行、统一收件箱建单与指派；`Codex`/`ACP` 当前完成单测/环境探测/UI 下拉，尚未跑外部真实子进程回合 |

**累计解决的关键工程问题摘要**：Claude Code CLI `2.1.325` `stdio` 控制握手初始化阻塞；Windows 盘符根 `.git` 误溯保护；`isolated-home` 下 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 误注导致认证失效；`paused` 房间被普通工具调度覆写；中文无空格 `@成员` 分词；`ChatView` React #310 Hooks 顺序错误及圆桌 `Chair` 非首位时 `转交执行` 触发 `idx_room_single_lead` 唯一约束冲突等。

---

## 4. 下阶段任务清单（Backlog & Roadmap）

> 表中「已预留基建」均已在当前代码库中落地建表或定义接口，后续开发可直接对接、无需推翻现有架构。

### 4.1 A 组：`v0.1c` 收尾与体验补强（建议作为收口小版本 `v0.1d` 或并入下期首周）

| 编号 | 优先级 | 任务名称 | 已预留基建 | 目标与验收要点 |
| :--- | :---: | :--- | :--- | :--- |
| **T-101** | P1 | **聊天/工单附件 Blob 存储与 GC** | `files`、`file_refs`、`file_deletion_outbox` 表（[database.ts](../packages/core/src/storage/database.ts#L259-L289)） | 实现消息与 Inbox 附件的内容寻址存储（`~/.myagents/blobs/<aa>/<bb>/<sha256>`）、入站/删除事务维护 `file_refs` 引用计数，以及定时扫描 Outbox 清理零引用物理文件的后台任务 |
| **T-102** | P1 | **`Codex` / `ACP` CLI 真实联调与能力评估** | `CodexCliDriver` / `AcpCliDriver`（[cli-drivers.ts](../packages/core/src/runtime/cli-drivers.ts)）、宿主机已探测 `codex-cli 0.170.0` | 在有对应 API/CLI 环境的机器上跑通 `codex` 与 `gemini` 真实子进程对话、只读沙箱阻断验证与超步协同测试；评估补齐多轮会话续接及 MCP 配置透传 |
| **T-103** | P2 | **收件箱交互补强（路由工作区 + 外部回写）** | `inbox_items.reply_target_json`、`RoutingRuleAction.workspaceId` | 在 [InboxView.tsx](../packages/web/src/components/InboxView.tsx)「自动路由规则」表单补充可选目标工作区下拉框；在工单 `resolved` 时按 `reply_target` 调用来源插件回调（如 GitHub Issue 自动回复摘要） |

### 4.2 B 组：`v0.2a` 生态扩展与安全治理（建议作为下阶段核心主线）

| 编号 | 优先级 | 任务名称 | 已预留基建 | 目标与验收要点 |
| :--- | :---: | :--- | :--- | :--- |
| **T-201** | P0 | **外部 MCP 服务器 & Skill 仓库管理** | `mcp_servers`、`skills` 表；`Agent.mcpServerIds / skillIds` 字段；`writeRoomMemberMcpConfig` 流程 | 实现外部 MCP（`stdio` / `http`）与本地/Git Skill 的 CRUD 与 RPC 接口、Web 管理页面（禁用保留名 `myagents`），以及运行时向 `BuiltinDriver` 与 `ClaudeCodeDriver` 合并注入配置 |
| **T-202** | P0 | **后台任务与定时调度器（Cron / `background_jobs`）** | `background_jobs` 表（支持 `sync_source`、`backup_snapshot`、`routine_tick`） | 实现统一后台作业执行器与 Cron 触发器（含 `run_after`、幂等键、失败退避重试）；打通拉取型 `SourcePlugin` 周期同步（`sync_source`）与静默定时巡检任务（`routine_tick`） |
| **T-203** | P1 | **高危工具人工审批闭环（HITL）** | `approval_requests` 表；[hooks.ts](../packages/core/src/security/hooks.ts) `ApprovalGate` SPI | 在策略/权限命中高危动作（如非沙箱命令、破坏性操作或外部写入）时挂起当前 `WorkNode`（`status = 'awaiting_human'`）并生成 `approval_requests`，通过 WS 推送到 Web 弹窗由人工点击「允许 / 拒绝」后恢复或拒绝执行 |

### 4.3 C 组：`v0.2b+` 渠道扩张与平台运维

| 编号 | 优先级 | 任务名称 | 目标与验收要点 |
| :--- | :---: | :--- | :--- |
| **T-301** | P2 | **更多外部信息渠道插件** | 基于 [plugin-sdk](../packages/plugin-sdk/src/index.ts) `SourcePlugin` 扩展邮件（IMAP/SMTP）、飞书、钉钉、Slack、Jira 等接入插件 |
| **T-302** | P2 | **全局用量与费用统计看板** | 基于 `work_nodes.usage_json` 聚合按房间、Agent、模型、时间段的 Token 与 `costUsd` 消耗报表 |
| **T-303** | P2 | **异步一致性备份（`VACUUM INTO` / S3）** | 接入 `background_jobs.backup_snapshot`，定期执行 SQLite WAL 一致性快照并同步至本地归档或 S3 对象存储 |
| **T-304** | P3 | **托管浏览器工具与多用户 RBAC** | 扩展受控浏览器自动化工具，以及基于多账号的角色权限隔离与审计日志 |

---

## 5. 恢复开发与验收快速指引

```bash
# 1. 拉起标准生产服务（默认 http://127.0.0.1:3210，admin / admin）
pnpm start

# 2. 开发调试模式（daemon + core 热重载 + Vite :5173）
pnpm dev

# 3. 修改代码后的标准全量验收流水线
pnpm build && pnpm test && node scripts/smoke.mjs
node --import tsx scripts/verify-claude-v01b-live.mjs --mock-anthropic
```

- **默认数据与隔离目录**：`~/.myagents/`（或通过 `MYAGENTS_HOME` 指定独立环境），内含 `data/myagents.db`（SQLite）、`workspaces/`（私有与群共享工作区）、`agent-homes/`（Agent 隔离 `CLAUDE_CONFIG_DIR`）与 `run/core.json`。
