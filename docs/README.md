# MyAgents 设计文档总览（v2.0 基线）

本项目是一个纯服务端、纯自研 Web 接入的多 Agent 中间层与协作管理平台（TypeScript + Node.js 22+ `node:sqlite` + React Web）。

## 文档导航

| 文档 | 内容说明 |
| :--- | :--- |
| [PROJECT-STATUS-AND-ROADMAP.md](./PROJECT-STATUS-AND-ROADMAP.md) | **项目里程碑总结与下阶段路线图**：迄今已完成能力全景、最新质量基线、`v0.1c` 收尾与 `v0.2+` 待办任务清单（**阶段收尾与续开发总览入口**） |
| [01-PRD-FEATURES.md](./01-PRD-FEATURES.md) | **功能规格文档（v2.0）**：双轨 Agent（内置轻量 + 首个外部 CLI Claude Code）、工作区与文件处理、分期路线（`v0.1a` 聚焦单 Agent 可运行验收 → `v0.1b` 环境隔离与协作群 → `v0.1c` 圆桌与收件箱） |
| [02-ARCHITECTURE.md](./02-ARCHITECTURE.md) | **系统架构设计（v2.0）**：总体分层、Antumi Apache-2.0 后端底座复用边界、**5 层 Agent 环境隔离架构**、极薄 `daemon` 热重启接管、抗重启 MCP 桥、Reducer + 双节拍引擎与极简登录安全基线 |
| [03-DOMAIN-DESIGN.md](./03-DOMAIN-DESIGN.md) | **领域模型与状态机设计（v2.0）**：`room_member_id` 一等身份与单席位串行、禁止私开 Subagent、无死锁 `WorkNode` 状态机、写优先读写锁、两阶段 `work_deliveries`、`visible_seq` 增量投递、Reducer + Super-step 策略模型 |
| [04-API-PROTOCOL.md](./04-API-PROTOCOL.md) | **接口与协议文档（v2.0）**：极简 `admin/admin` 登录 REST、WS `/rpc` JSON-RPC 2.0、终端独立 WS、Core↔Daemon NDJSON（含 `spawnPipeClean`）、下划线规范 `workspace_* / collab_*` 工具、完整 SPI（`AgentDriver` / `EnvironmentIsolator` / `CollabStrategy` / 4 个安全 Hook） |
| [05-DATABASE-DESIGN.md](./05-DATABASE-DESIGN.md) | **数据库与存储设计（v2.0）**：Node 22 原生 `node:sqlite` WAL 完整 22 表 DDL（分期激活）、ER 图、`work_nodes` 单一真相源、`work_node_deps`、`work_deliveries`、`node_events`、`terminal_sessions`、`file_refs` 引用计数与 Outbox 清理 |
| [DESIGN-REVIEW.md](./DESIGN-REVIEW.md) | 架构评审历史记录（结论已全面合入上述 01~05 号 v2.0 正式文档） |
| [V0.1A-TEST-REPORT.md](./V0.1A-TEST-REPORT.md) | **`v0.1a` 交付与测试验收报告**：构建/类型检查、单元与 E2E、真机 Claude Code CLI 联调、真机浏览器 Web UI 验收结果、问题修复记录与启动指南 |
| [V0.1B-TEST-REPORT.md](./V0.1B-TEST-REPORT.md) | **`v0.1b` 交付与测试验收报告**：5 层环境隔离、`open-channel` 无竞态多 Agent 协作群、Git Worktree 并行隔离、抗重启 MCP 桥、Web 任务树与真机 CLI/浏览器端到端验收记录 |
| [V0.1C-TEST-REPORT.md](./V0.1C-TEST-REPORT.md) | **`v0.1c` 交付与测试验收报告**：Pregel Super-step `roundtable` 圆桌讨论与转交、统一收件箱 / Webhook / `SourcePlugin` / 自动路由 Lockdown 隔离、`Codex`/`ACP` 驱动与真机全链路验收记录 |
