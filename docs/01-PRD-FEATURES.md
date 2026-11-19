# 01. 产品功能规格文档（PRD & Feature Spec）

> **文档状态**：v2.0 定稿（已合入架构评审结论与分期裁剪）  
> **产品定位**：纯服务端、Web 接入的多 Agent 中间层与协作管理平台（Server-First Multi-Agent Control Plane）  
> **技术栈**：TypeScript + Node.js 22+（`node:sqlite` + 后端 `protocol` / `daemon` / `core` / `plugin-sdk`）+ 纯自研 React Web（前端）

---

## 1. 产品定位与核心目标

### 1.1 核心痛点
1. **轻重任务错配**：简单任务（问答、文档整理、消息路由、轻量文件处理）无需启动重型第三方 CLI，需要**进程内毫秒级启动的内置轻量 Agent**。
2. **第三方 CLI 难管理**：Claude Code 等强能力外部 CLI 仅运行在本地终端，缺少服务端常驻托管、Web 接入、进程保活与统一工作区体验。
3. **多 Agent 编排难扩展**：市面上工具常将委派、团队、群聊做成彼此割裂的烟囱模块，新增协作玩法极难扩展，且第三方 CLI 常在黑盒中私开 Subagent 导致失控。
4. **外部信息流割裂**：后续需把邮件、IM、Jira、GitHub 统一归一化为「文本 + 文件」进入收件箱，再由人类指派或规则自动路由给 Agent 处理。

### 1.2 核心设计原则
- **纯服务端 + 自研简洁 Web**：无 Electron 桌面端包袱，后端可部署在本地服务器/VPS/Docker，浏览器直连工作台。
- **双轨 Agent 平级抽象**：内置轻量自研 Agent（直连任意 OpenAI-Compatible API）与外部重型 CLI Agent（首期仅接入 **Claude Code CLI**）实现统一 `AgentDriver` 接口。
- **架构一步到位，交付严格分期**：底座一次按「统一 `Room + WorkNode + CollabEngine + CollabStrategy` + Agent 环境隔离架构 + 极简安全基线」搭正，**第一版（`v0.1a`）极度聚焦把单个 Agent（内置 + Claude Code）与工作区文件处理跑通可验收**，多 Agent 协作群、圆桌讨论室、收件箱与完整环境隔离按阶段平滑叠加。
- **多 Agent 固定编组、禁止私开 Subagent**：进入多 Agent 协作后，房间成员固定，从平台编排层与外部 CLI 参数层双重封堵私开 Subagent。

---

## 2. 分期交付路线图（核心边界）

| 阶段 | 阶段定位 | 交付核心能力 |
| :--- | :--- | :--- |
| **第一版 `v0.1a`（当前首期目标）** | **可运行、可验收的单 Agent 服务端工作台** | • 极简安全基线（`admin/admin` 登录、Cookie/Bearer、WS 同源校验）<br>• 极薄 `daemon`（Pipe + PTY + 环形缓冲）与 `core` 热重启无缝接管<br>• **双轨 Agent**：内置轻量 `BuiltinDriver`（OpenAI 兼容 API）+ 外部 **`ClaudeCodeDriver`**（唯一首期外部 CLI）<br>• **工作区系统**：Agent 私有持久工作区 + 本地项目目录挂载 + 工作区文件读写/编辑/Git Diff/Web 终端<br>• 统一 `Room + WorkNode` 内核骨架（先启用 `single` 单聊策略，完整预留协作/隔离/安全扩展接口）<br>• 纯自研简洁 React Web 工作台 |
| **第二版 `v0.1b`** | **Agent 环境隔离 + 无竞态多 Agent 协作群** | • 落地 5 层 Agent 环境隔离（`spawnPipeClean`、配置目录隔离 `CLAUDE_CONFIG_DIR`、Provider 环境变量清洗、Lockdown 与路径围栏、`config_hash` 漂移重建）<br>• 落地完整无竞态调度器（写优先读写锁、两阶段 `work_deliveries`、`waiting_children` 让锁让配额）<br>• 独立抗重启 `mcp-main` stdio 桥接 + `collab_*` 协作原语<br>• 开放协作群（`open-channel`：确定性 `@`/Lead 路由、任务树、人工 `Stop/Continue/Cancel/Retry/Reassign`、Git Worktree 隔离协作、双层禁 Subagent） |
| **第三版 `v0.1c`** | **Super-step 讨论室 + 统一收件箱（Inbox）** | • Pregel Super-step 屏障 + Reducer 驱动的圆桌讨论室（`roundtable`：盲答 → `visible_seq` Reveal → 收敛总结 → 一键转交执行）<br>• 统一收件箱（`InboxItem`：手动入箱 + 通用 Webhook 验签 + 路由规则自动分派 + 默认 `read-only` 降权 + `plugin-sdk` 示范插件）<br>• 附件 `file_refs` 引用计数 + Outbox 垃圾回收 |
| **第四版 `v0.2+`** | **生态扩张与高阶治理** | • 扩展更多外部 CLI（ACP / Codex / Gemini 等）与外部渠道（邮件 / 飞书 / 钉钉 / Slack / Jira）<br>• 定时任务（Cron + 静默运行）、托管浏览器（Playwright）、用量统计看板、S3/异步备份实现、Web 审批弹窗与多用户 RBAC |

---

## 3. 第一版（`v0.1a`）功能详细规格

### 3.1 极简安全基线（开箱即用）
- **账号登录**：默认 `admin / admin`（支持环境变量 `MYAGENTS_ADMIN_USER` / `MYAGENTS_ADMIN_PASS` 覆盖），密码使用 `scryptSync` + 随机盐落库，支持在 Web 设置页修改密码。
- **会话与接口保护**：登录下发 `HttpOnly` Cookie（兼容 `Authorization: Bearer`）；除健康检查、登录与静态资源外，所有 HTTP API 与 WebSocket 强制鉴权，WS 握手校验 `Origin` 同源防止跨站劫持。
- **非本机提示**：若监听非 `127.0.0.1` 且仍使用默认 `admin/admin`，在控制台日志和 Web 顶部显示温和提醒条。

### 3.2 模型服务商与双轨 Agent 管理
- **模型服务商（Model Providers）**：
  - 支持增删改查 OpenAI-Compatible 端点（`baseUrl`、`apiKey`、`defaultModel`、`models[]`），提供一键连通性测试（`providers.probe`）。
- **内置轻量 Agent（`builtin` Driver）**：
  - 进程内运行，毫秒级冷启动，基于流式 Tool-Calling + ReAct 循环（默认 `maxSteps = 25`）。
  - 按工作区权限动态提供文件工具：`workspace_list`、`workspace_read`、`workspace_grep`、`workspace_write`、`workspace_patch`、`workspace_exec`（经 `daemon` 执行并受超时保护）。
- **外部 Claude Code Agent（`claude` Driver）**：
  - 启动本机 `claude` CLI（`-p --input-format stream-json --output-format stream-json`），经由 `daemon` 的 `pipe-session` 托管，支持流式输出、工具步骤解析、`nativeSessionId` 续接。
  - 环境自检：自动探测本机 `git` 与 `claude` 的路径、版本和可用状态。
  - 按架构预留 `IsolationProfile` 注入点（v0.1a 支持基础环境变量传递与路径约束，v0.1b 激活完整目录隔离与 Lockdown）。
- **Agent 基本配置**：
  - 名称、职责简介（`bio`）、系统提示词（`systemPrompt`）、驱动类型（`builtin | claude`）、模型配置、默认权限模式（`read-only | workspace-write | full`）、自动分配私有工作区、归档。

### 3.3 工作区系统与工作区文件处理
- **两类首期工作区**：
  1. **Agent 私有持久工作区（`agent_private`）**：创建 Agent 时自动在 `~/.myagents/workspaces/agents/<agentId>/` 初始化，预置 `notes/`、`artifacts/`，不绑定代码项目也能正常读写处理文件。
  2. **本地项目工作区（`project`）**：登记服务器本地目录或 Git 仓库路径，自动检测是否 Git 仓库与当前分支。
  - *(注：`git_worktree` 与群 `shared` 工作区数据模型与表在 v0.1a 同步建立，完整 Worktree 隔离创建/清理在 v0.1a/b 平滑开放。)*
- **工作区文件操作（Web 右侧工作台 + Agent 工具共用安全边界）**：
  - **文件树浏览**：懒加载目录树，支持新建文件/目录、重命名、删除、上传本地文件到当前工作区、下载文件。
  - **在线查看与编辑**：文本/代码文件查看与编辑保存（携带 `expectedMtime` 乐观锁防止静默覆盖 Agent 的修改）；Markdown 源码/预览切换。
  - **Git Diff 查看**：针对 Git 工作区查看变更文件列表与单文件 Unified Diff。
  - **Web 交互终端**：通过独立 WS 通道连接 `daemon` PTY，在当前工作区目录下打开交互 Shell（支持刷新重连恢复输出）。

### 3.4 单聊会话与过程持久化（`single` 策略）
- 基于统一 `Room + WorkNode` 引擎运行 `single` 策略：
  - 创建单聊会话：选择 1 个 Agent（`builtin` 或 `claude`）+ 选择其私有工作区或已登记的项目工作区。
  - 流式聊天：实时推送文本增量、思考过程、工具调用卡片（可折叠），过程事件落库 `node_events`，刷新页面完整还原。
  - 会话控制：支持发送时附带幂等键、运行中点击 **Stop（中断）**、异常失败后点击 **Retry（重试）**。
  - 热重启接管：重启 `core` 进程时，正在运行的 `claude` 会话和已打开的 Web 终端在 `daemon` 中保持存活，重连后自动 `attach` 补齐输出。

### 3.5 Web 端极简三栏布局（纯自研 React）
- **左栏**：会话列表（显示运行状态点）、Agent 管理入口、工作区管理入口、模型服务商/系统设置入口。
- **中栏**：聊天消息流（Markdown + 折叠工具卡片）+ 底部输入框（发送/中断按钮）。
- **右栏（可折叠工作台 Dock）**：**文件**（树 + 编辑器 + 上传）、**变更**（Git Diff）、**终端**（`xterm.js`）。

---

## 4. 第一版（`v0.1a`）交付验收清单

交接时只需逐条验证以下 **5 项实测标准**：

1. **启动与登录**：单命令启动 `daemon` + `core`，浏览器打开 `http://localhost:3210`，用 `admin / admin` 登录进入 Web 工作台（支持修改密码）。
2. **内置轻量 Agent 闭环**：配置一个 OpenAI-Compatible 模型服务商，创建 1 个 `builtin` Agent，在它的**私有工作区**里完成多轮对话、让它创建/读取/修改文件，并在 Web 右侧文件面板直接查看、编辑和上传工作区文件。
3. **Claude Code CLI 闭环**：创建 1 个 `claude` Agent，绑定一个本地 Git 项目目录，发指令让它读取分析或修改代码，实时看到流式回复与工具调用步骤，在右侧面板查看 **Git Diff** 并在 **Web 终端**执行命令验证。
4. **过程持久化与中断重试**：刷新浏览器页面，历史消息与工具调用步骤完整保留；运行中点 Stop 能干净中断，失败可 Retry。
5. **热重启不中断**：保持 Web 终端运行（例如 `ping` 或 dev server）及 Claude 会话存活，重启 `core` 进程后刷新网页，终端输出不断、Claude 会话状态正常对账恢复。

---

## 5. 下一阶段能力概览（`v0.1b` / `v0.1c` 架构已就位）

以下能力已在 [02-ARCHITECTURE.md](./02-ARCHITECTURE.md)、[03-DOMAIN-DESIGN.md](./03-DOMAIN-DESIGN.md)、[04-API-PROTOCOL.md](./04-API-PROTOCOL.md)、[05-DATABASE-DESIGN.md](./05-DATABASE-DESIGN.md) 中完成完整架构与表结构设计，首期不写其上层业务，二三期零重构直接叠加：
- **5 层 Agent 环境隔离**（参考 Antumi 环境变量清洗、`CLAUDE_CONFIG_DIR` 隔离、Lockdown 锁死、路径围栏与 `config_hash` 漂移重建）。
- **开放协作群（`open-channel`）**：固定成员编组、确定性 `@` + 内置 Lead 路由、任务树与人工干预、写优先读写锁、双层禁 Subagent。
- **圆桌讨论室（`roundtable`）**：Pregel Super-step 屏障 + Reducer 盲答公开收敛 + 一键转交执行。
- **统一收件箱（Inbox）**：Webhook / `plugin-sdk`（GitHub / Jira / 邮件 / IM）归一化为文本+文件、路由规则自动派发（默认只读降权）与人工指派。
