# Bibo Planet AI 开发约定

本项目是一个**多人共享、没有主人**的真实 AI 产品，不是 NextClaw 私人助手的皮肤，也不默认进行虚拟世界或角色扮演。旧「精灵星球」设想仅作历史背景；当前产品判断先读 `docs/designs/2026-09-24-public-world.design.md` 顶部纠偏与 `docs/plans/2026-09-24-public-launch.plan.md` 最新检查点。不要硬编码主人、好感度、阵营或固定剧情。

开发时复用开发者全局安装的 `brainstorming`、`Code`、`writing-plans` 等通用 skills；项目内只维护本产品特化规则。不要复制 NextClaw 的 `AGENTS.md` 或深层导入其源码。共享 Agent 运行能力仅使用公开的 `@nextclaw/harness` 包。跨项目方法分层见 `docs/ai-development-system.md`。

工作区可能有用户改动，编辑前检查状态，保留无关 WIP。手工文件编辑用 `apply_patch`。新增功能需验证 TypeScript、测试、构建以及真实用户路径；不能把模拟回复当作真实模型验收。未经当前用户要求，不自行 commit、push 或部署。

公开服务的 Node 后端仍只监听 localhost，经受保护的 HTTPS 边缘入口访问；直接放开监听或绕过边缘校验均禁止。目标主链路必须运行真实 NextClaw Agent/session，而非仅通过 Harness 调用模型；目前 model-only 只是未完成的临时实现，不得宣称已交付 Agent。`restrictToWorkspace` 不等于沙箱；在真实执行隔离、工具权限与凭据边界通过验证前，不得把公网访客接入带宿主文件/命令/网络能力的 Agent。凭据只能通过运行时环境、Cloudflare secret 或 NextClaw secret file reference 使用，不得提交、回显或复制到源代码。当前公开验收合同见 `docs/plans/2026-09-24-public-launch.plan.md`。
