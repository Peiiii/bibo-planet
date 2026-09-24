# Bibo Planet · 无主之星

一颗被多人共同访问的小星球。墨里、皮可和塞拉是持续存在的 AI 精灵，不归任何旅人所有。访客可以注册、登录，与同一批精灵反复相遇；自己的原始对话列表只对自己可见，但发送成功的内容会成为精灵的共同记忆，其他旅人可能从它的回应中得知。不要输入隐私或秘密。

首页的精灵卡片显示最近一次真实相遇的大致时间，并在页面可见时低频更新；它只展示活动时间，不公开访客身份或消息。选中精灵即可进入对话，手机上会直接带你滚动到聊天区。

已登录旅人可以在页首进入「账号与数据」，下载自己的账号基本资料、与三只精灵的对话，以及自己贡献给共同世界的遭遇记录；不会包含其他旅人的原文或密码、会话哈希。文件可能含私人内容，请妥善保存。账号删除的底层代码和页面已部署，但公开入口仍关闭；历史加密备份期限、公开运营信息和适用运营要求核实前，不能对外开放。即使将来删除在线原文，也无法自动收回其他旅人此前收到的生成回复；当前状态以[上线验收记录](docs/plans/2026-09-24-public-launch.plan.md)为准。

精灵会参考近期的共同遭遇；当你提起足够明确的旧线索时，它也会从更早的相遇中找回相关片段。这不是完整、无遗漏的长期记忆。每个人只能在自己的会话列表中查看自己的原始对话，但不要输入不希望被精灵转述的秘密。

这不是 NextClaw 私人助手的界面皮肤。Bibo Planet 独立拥有世界、账号、能量和前端；模型能力由公开的 `@nextclaw/harness` 提供。公网版本不给模型文件、命令或网络工具，所以精灵还不能运行代码、改造自己的界面。完整有工具的 Agent 需要真正的执行隔离后才能开放，不能用提示词或 `restrictToWorkspace` 冒充沙箱。

网页对话区和精灵回复旁会直接标明 AI 生成身份。对话区标题旁按当前后端模型显示名称与官方资料；未核实的新模型备案号不会借用旧模型的公示信息。精灵有性格与共同经历，但并非真人；模型资料不等于 Bibo Planet 应用自身已完成可能需要的登记。这些提示不替代[正式开放验收](docs/plans/2026-09-24-public-launch.plan.md)中尚未完成的隐私、备案与公开 AI 服务要求。

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
BIBO_MODEL=deepseek/deepseek-flash
BIBO_NEXTCLAW_CONFIG=/absolute/path/to/.nextclaw/config.json
```

也可以提供 `DEEPSEEK_API_KEY` 等供应商环境变量。模型不可用时系统明确报错，不给模拟回复。初始每只精灵有 250,000 点能量，真实 token 用量优先，供应商不报告时标明估算。管理员可在服务停止后运行 `pnpm energy:add mori 10000` 补能。

## 公网架构与运营边界

`planet.bibo.bot` 由 Cloudflare Worker 托管静态前端，并将 `/api/*` 通过 HTTPS 代理到受保护的 Node 服务。Node 服务只监听云主机 loopback，要求随机边缘认证头；模型密钥仅在后端运行环境里。生产实例以 `BIBO_DATA_DIR` 指向独立的持久数据目录，不依赖代码目录可写。账号密码使用 scrypt 哈希，会话 cookie 为 `HttpOnly`、公网 `Secure`，账号、世界与私人对话持久化到独立数据目录。公开服务设有每账号每天最多 12 次成功唤醒、18 次业务层模型尝试和全星球 240 次业务层模型尝试，以及单 IP 和全站注册/登录节流；当天最多成功注册 240 个新账号，名额耗尽时明确报错，不执行昂贵密码哈希。失败的模型尝试不伪造成成功对话，但会占用尝试预算。适配器可能对一次尝试自动重试，所以该上限不是供应商 HTTP 请求数或账单金额保证；它们是成本/滥用保护，不是精灵世界的所有权规则。

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
