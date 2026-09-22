# Bibo Planet AI 开发约定

本项目是一个**多人共享、没有主人**的 AI 精灵世界，不是 NextClaw 私人助手的皮肤。产品判断先读 `docs/thoughts/2026-09-22-shared-spirits-world.thought.md` 与 `docs/designs/2026-09-22-first-world.design.md`。不要硬编码主人、好感度、阵营或固定剧情。

开发时复用开发者全局安装的 `brainstorming`、`Code`、`writing-plans` 等通用 skills；项目内只维护本产品特化规则。不要复制 NextClaw 的 `AGENTS.md` 或深层导入其源码。共享 Agent 运行能力仅使用公开的 `@nextclaw/harness` 包。跨项目方法分层见 `docs/ai-development-system.md`。

工作区可能有用户改动，编辑前检查状态，保留无关 WIP。手工文件编辑用 `apply_patch`。新增功能需验证 TypeScript、测试、构建以及真实用户路径；不能把模拟回复当作真实模型验收。未经当前用户要求，不自行 commit、push 或部署。

本版服务必须保持 localhost-only。`restrictToWorkspace` 不等于沙箱，未经公开部署设计与验证，不放开监听、不开放代理。凭据只能通过运行时环境或 NextClaw secret file reference 使用，不得提交、回显或复制到源代码。
