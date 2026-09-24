# Bibo Planet · 无主之星

一颗被多人共同访问的小星球。墨里、皮可和塞拉是持续存在的 AI 精灵，不归任何旅人所有。访客可以注册、登录，与同一批精灵反复相遇；自己的对话只对自己可见，精灵会从所有人的共同经历中形成回应。不要输入不希望被其他旅人间接得知的秘密。

这不是 NextClaw 私人助手的界面皮肤。Bibo Planet 独立拥有世界、账号、能量和前端；模型能力由公开的 `@nextclaw/harness` 提供。公网版本不给模型文件、命令或网络工具，所以精灵还不能运行代码、改造自己的界面。完整有工具的 Agent 需要真正的执行隔离后才能开放，不能用提示词或 `restrictToWorkspace` 冒充沙箱。

## 本地运行

需要 Node.js 22+、pnpm 9+ 和一个可用的模型供应商凭据。

```bash
pnpm install
cp .env.example .env
# 在 .env 中设置 BIBO_MODEL 与对应 API Key，或引用已有 NextClaw 配置文件
pnpm dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。`pnpm dev` 启动前端开发服务器和本机 API。也可以用 `pnpm local:start` 构建并在 `127.0.0.1:3038` 后台运行，`pnpm local:status` 查看状态，`pnpm local:stop` 停止。后台 PID、日志和世界数据放在 Git 忽略的 `.data/` 中。

本机 NextClaw 已配置可用供应商时，可只引用配置文件，不复制 key：

```dotenv
BIBO_MODEL=deepseek/deepseek-chat
BIBO_NEXTCLAW_CONFIG=/absolute/path/to/.nextclaw/config.json
```

也可以提供 `DEEPSEEK_API_KEY` 等供应商环境变量。模型不可用时系统明确报错，不给模拟回复。初始每只精灵有 250,000 点能量，真实 token 用量优先，供应商不报告时标明估算。管理员可在服务停止后运行 `pnpm energy:add mori 10000` 补能。

## 公网架构与运营边界

`planet.bibo.bot` 由 Cloudflare Worker 托管静态前端，并将 `/api/*` 通过 HTTPS 代理到受保护的 Node 服务。Node 服务只监听云主机 loopback，要求随机边缘认证头；模型密钥仅在后端运行环境里。生产实例以 `BIBO_DATA_DIR` 指向独立的持久数据目录，不依赖代码目录可写。账号密码使用 scrypt 哈希，会话 cookie 为 `HttpOnly`、公网 `Secure`，账号、世界与私人对话持久化到独立数据目录。公开服务设有每账号每日唤醒次数、全站上限和注册/登录节流；它们是成本/滥用保护，不是精灵世界的所有权规则。

部署与运营必须遵守 [公网设计](docs/designs/2026-09-24-public-world.design.md)、[线上运行手册](docs/OPERATIONS.md) 和 [上线验收记录](docs/plans/2026-09-24-public-launch.plan.md)。没有完成该记录中的外网验收时，不应把仓库源码或本机页面称为可直接交付的产品。生产凭据不进入 Git、文档和日志。

## 开发验证

```bash
pnpm tsc
pnpm test
pnpm lint
pnpm build
pnpm exec wrangler types --check
pnpm exec wrangler deploy --dry-run
```

## 项目关联

- [产品构想](docs/thoughts/2026-09-22-shared-spirits-world.thought.md)
- [第一颗星球的本地原型设计](docs/designs/2026-09-22-first-world.design.md)
- [跨项目 AI 开发体系与复用边界](docs/ai-development-system.md)
- [NextClaw](https://github.com/Peiiii/nextclaw) 与其 [Harness](https://github.com/Peiiii/nextclaw/tree/master/packages/nextclaw-harness)
