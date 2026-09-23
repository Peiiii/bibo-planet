# Bibo Planet · 无主之星

一颗可以被多人共同访问的小星球。这里有三只 AI 精灵：墨里、皮可和塞拉。它们有各自的身份与工作目录，可以分辨访客、记住共同遭遇，却不天然属于任何人。

这是**真实可运行的本地 MVP**，不是预制对话演示。回复由 `@nextclaw/harness` 调用真实模型生成；模型不可用时会显示错误，不会替换成假回复。界面独立于 NextClaw 的私人助手前端。

## 本地运行

需要 Node.js 22+、pnpm 9+，以及一个可用的模型供应商凭据。

```bash
pnpm install
cp .env.example .env
# 编辑 .env：选择 BIBO_MODEL，并设置对应 API Key；或引用已有的 NextClaw 配置文件
pnpm dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。`pnpm dev` 同时启动前端和世界服务，适合开发，关闭终端后服务会停止。

需要让本机体验版在终端或 Codex 任务结束后继续运行时，使用：

```bash
pnpm local:start
# 打开 http://127.0.0.1:3038
pnpm local:status
# 不再使用时：pnpm local:stop
```

后台服务的 PID 与日志放在被 Git 忽略的 `.data/` 中。再次执行 `pnpm local:start` 不会重复启动。

例如已有 NextClaw 配置且其中的模型凭据有效，可在 `.env` 写：

```dotenv
BIBO_MODEL=codex-sub/gpt-5.6-luna
BIBO_NEXTCLAW_CONFIG=/absolute/path/to/.nextclaw/config.json
```

`BIBO_NEXTCLAW_CONFIG` 只读取选中供应商的配置，并用 NextClaw 的 secret file reference 在运行时取用 key；不会把 key 复制到此仓库。其他供应商可设置 `BIBO_MODEL=minimax/MiniMax-M2.5` 与 `MINIMAX_API_KEY` 等。 `.env`、`.data` 已被 Git 忽略。免费模型可能拒绝第三方客户端；请使用确实可调用的供应商。

精灵的 Agent、会话、上下文压缩、模型与工具链都由 `@nextclaw/harness` 运行；Bibo Planet 没有另写一套聊天运行时。世界层为每位访客生成稳定的 NextClaw session ID，同一访客可以连续多轮交谈。

初始每只精灵有 250,000 点能量。模型报告 token 时直接按报告扣减；报告不可用时按输入与回复长度估算，并在界面标明。要补能，**先停止服务**，运行：

```bash
pnpm energy:add mori 10000
```

可用 ID：`mori`、`piko`、`sela`。

## 第一版具备什么

- 三只真正独立的 Agent，分别有自己的 `AGENTS.md`、`SOUL.md`、`IDENTITY.md` 和 `MEMORY.md`，保存在 `.data/workspace/agents/<id>/`。
- 匿名访客由服务器分配 cookie；每位访客与每只精灵有自己的会话和原始对话列表。
- 同一只精灵会读取其他访客留下的近期遭遇；原始对话列表不向别的访客展示。世界状态与会话在本机重启后保留。
- 能量随真实模型调用消耗，耗尽后拒绝新对话；本机 CLI 可补能。
- 独立的星球界面、桌面与手机布局、等待/失败/余额状态。

## 边界

服务强制监听 `127.0.0.1`。**请勿直接将这版接入公网或开放代理。** NextClaw Harness 仍可能拥有宿主进程能力，`restrictToWorkspace` 不是进程级沙箱。公开运营前需要精灵执行沙箱、访问频率/费用控制和更完整的身份与内容治理。

精灵自制 mini-app、精灵之间主动互动、访客补能与公网托管在方向中，但未伪装为首版功能。当前的共同遭遇会进入精灵上下文，因此不要输入不希望被精灵向其他访客提及的敏感信息。

## 文档与关联

- [产品构想](docs/thoughts/2026-09-22-shared-spirits-world.thought.md)
- [MVP 设计与验收](docs/designs/2026-09-22-first-world.design.md)
- [实施与验收状态](docs/plans/2026-09-22-first-world.plan.md)
- [跨项目 AI 开发体系与复用边界](docs/ai-development-system.md)
- [NextClaw](https://github.com/Peiiii/nextclaw)：个人长期搭档产品；本项目复用其 [Harness](https://github.com/Peiiii/nextclaw/tree/master/packages/nextclaw-harness) 运行时，但不继承私人助手定位。
