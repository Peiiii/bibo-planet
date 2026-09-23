# First World Implementation Plan

> 执行约定：按本仓库开发约定逐步交付；未获用户明确要求时不委派。

**Goal:** 交付独立的、可运行的多人共享精灵星球 MVP，并推送 GitHub。

**Architecture:** 世界服务以单进程本机 HTTP API 拥有能量与遭遇的持久状态；`@nextclaw/harness` 拥有 Agent、工作目录和会话。Vite/React 前端是独立星球界面，不导入 NextClaw UI。

**Tech Stack:** Node.js 22、TypeScript、React、Vite、`@nextclaw/harness`、Node test runner。

---

## 顺序与恢复

1. 建立项目清单、类型配置与文档，安装依赖。验证 `pnpm install`、`pnpm tsc` 可运行。
2. 在 `src/server/world-store.ts` 实现持久状态与精灵级互斥；在 `test/world-store.test.ts` 先覆盖初始状态、能量扣减、跨访客遭遇、重启恢复和余额不足，再实现到通过。
3. 在 `src/server/spirit-runtime.ts` 以 Harness 启动三只精灵并处理一次真实对话；在 `test/spirit-runtime.test.ts` 用可替换的运行函数验证会话 ID、记忆注入与计量，随后做真实模型冒烟。
4. 在 `src/server/server.ts` / `src/server/main.ts` 暴露世界列表、访客历史和对话，使用服务器签发的 HttpOnly 访客 cookie；补能仅用本机 CLI。定向验证错误、非本机默认监听和访客隔离。
5. 在 `src/client` 实现独立星球界面与访问路径，验证窄屏、空/加载/失败态和刷新恢复。
6. 完成 README、设计/想法和 AI 开发体系共享说明；与 NextClaw 双向链接，但不混入其现有 WIP。
7. `pnpm tsc`、测试、构建、真实链路和 diff Review；仅 stage 本任务文件，创建公开 GitHub 仓库并普通 push。公开只发布代码与文档，不部署不安全的本机服务，也不提交凭据或本地世界数据。

恢复时从 `git status --short`、当前测试结果和本计划未通过的下一步继续，不重复已完成的工作。设计语义改变时先更新设计。

## 验收契约

| ID | Required | 判定 | Status |
| --- | --- | --- | --- |
| FW-1 | true | 独立项目、文档、GitHub 链接成立，未覆盖旧 `bibo.bot` 或 NextClaw WIP | passed: 两仓库双向链接已推送；旧仓库及原 WIP 未改 |
| FW-2 | true | 三只独立精灵可经真实模型回应，没有预制回复 | passed: 墨里、皮可、塞拉均经真实模型回应 |
| FW-3 | true | A/B 访客共享精灵遭遇但不互看原始私聊；刷新/重启保留 | passed: A/B 真实对话与存储测试 |
| FW-4 | true | 能量随 token 消耗且有计量标记，耗尽拒绝，管理员可补能 | passed: 浏览器真实扣费 + 自动测试 + 本机补能 |
| FW-5 | true | 独立世界界面可用，主要操作与状态/错误清晰 | passed: 桌面/手机浏览器实测 |
| FW-6 | true | 运行时与 AI 开发约定有可复用关系，不复制 NextClaw 私人助手前端/规则 | passed: Harness 包依赖 + 独立前端与开发体系文档 |
| FW-7 | true | TypeScript、自动测试、构建和真实链路验证完成；变更推送 GitHub | passed: `pnpm tsc`、lint、6 项测试、格式检查、构建与真实模型/浏览器链路；两个远端仓库已推送 |

真实外部边界：公网部署需要执行沙箱与滥用治理；用户只要求 GitHub 推送，本计划不部署。模型服务可用性取决于所选真实供应商；不可用时保留真实错误与可配置连接，而不伪造成功。

## 交付核对

- Bibo Planet 公共仓库：<https://github.com/Peiiii/bibo-planet>，初始交付提交 `7a76b83`。
- NextClaw 中英文 README 关联提交：`7d829cee2`，已推送到远端 `master`。
- 真实模型链路分别唤醒墨里、皮可、塞拉；A/B 访客测试证实共同遭遇可影响回应，而原始私聊列表隔离。浏览器端实测了桌面、手机与实际能量扣减。
- NextClaw 本地主工作区已有未提交思考文档；主线同步协调器返回 `LOCAL_WORKTREE_RETRYING`，自动等待其 WIP 安全窗口。远端 `master` 已完成交付，本地主工作区未被强行覆盖。

## 2026-09-23 多轮可用性回归

初次验收只覆盖了不同访客各自的首轮消息，没有覆盖同一访客连续第二轮；同时把临时 `pnpm dev` 进程误当成了任务结束后仍可访问的体验服务。真实使用因此先出现前端残留但服务进程已退出，服务恢复后又在第二轮触发 NextClaw 上下文压缩失败。

修复后，体验入口改为可显式启停和查询的 `pnpm local:{start,status,stop}` 后台服务；NextClaw Agent 上下文由错误的 8K/2K 调整为 200K/10K。验收新增同一 session 自动回归，并在同一个真实浏览器会话中连续完成到第三轮。后续聊天型 MVP 的真实验收至少包含：服务启动命令退出后仍存活、同一访客连续三轮、刷新后历史仍在，以及明确的离线提示。
