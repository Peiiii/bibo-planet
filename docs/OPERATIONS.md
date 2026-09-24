# Bibo Planet 线上运行手册

状态：2026-09-24 记录的实际部署；变更后须同步复核。上线地址为 <https://planet.bibo.bot>，源码为 <https://github.com/Peiiii/bibo-planet>。本手册只存放路径、流程和检查项，不存放任何密钥值或私人对话内容。

## 运行边界

- Cloudflare Worker `bibo-planet` 提供静态站，将 `/api/*` 通过 HTTPS 转发至 `https://nextclaw.net/__bibo/api/*`。Worker secret `BIBO_EDGE_SECRET` 与服务端 `/etc/bibo-planet/env` 中同名值一致；前端和 Git 都不能得到该值。
- 静态响应头由构建进 `dist/` 的 `public/_headers` 管理，覆盖首屏与指纹化资源；API 响应由 Worker 代码生成，不受该文件覆盖。2026-09-24 已在公网确认 HTML 与 JS 均带防嵌入、`nosniff`、Referrer/Permissions Policy、有限 CSP 与 HSTS；改动该文件时须同时检查真实页面可加载和 API 会话链路。Cloudflare 官方合同：<https://developers.cloudflare.com/workers/static-assets/headers/>。
- 阿里云杭州 ECS `i-bp11euxyc7o1ned0k8yd` 上的 Bibo 服务独立运行：源码 `/opt/bibo-planet`，Node `/opt/bibo-node/bin/node`，systemd 单元 `bibo-planet`，只监听 `127.0.0.1:3039`，运行身份 `bibo-planet`。Nginx 的 `nextclaw-net.conf` 包含独立片段 `/etc/nginx/bibo-location.conf`，旧站主页不应受影响。
- 用户数据在 `/var/lib/bibo-planet`，其中 `accounts.json` 含密码哈希和会话哈希，`spirits/*/state.json` 含所有旅人的原始对话及共同遭遇，均属敏感数据。服务端凭据在 root-only `/etc/bibo-planet/env`。不要把数据、环境文件、Cloud Assistant 输出或备份上传到仓库。
- 生产模型为 DeepSeek 正式 API，通过 NextClaw Harness 的无宿主工具模型能力调用。当前公开版不具备自写代码、文件/命令/网络工具或 mini-app 沙箱；不能在产品文案中宣称这些已交付。

## 日常健康检查

1. 从外网确认 `https://planet.bibo.bot/`、`/api/world`、`/api/session` 返回 200。匿名访问 `/api/spirits/mori/conversation` 应为 401；直接访问 `https://nextclaw.net/__bibo/api/world` 而不带内部密钥应为 403。
2. 在 ECS 确认 `systemctl is-active bibo-planet` 为 `active`，`nginx -t` 通过，`nextclaw.net` 原站首页仍为 200。只看 `journalctl -u bibo-planet` 的错误类型和状态；不回显请求正文或环境变量。
3. 确认 `/var/lib/bibo-planet` 有足够磁盘空间、服务内存未接近 `MemoryMax=900M`；观察模型 401/402/429/超时与世界每日额度。首页 200 不能证明推理服务可用，必要时以受控测试账号发一条真实消息。

## 备份与恢复

每次服务端更新、数据结构迁移和高风险运维前，在 ECS 创建 root-only 备份目录。可靠备份时先短暂停止**仅 Bibo** 的写入，再一起归档 `accounts.json` 与整个 `spirits` 目录，随后启动服务；不能在有并发写入时分别复制这些文件并称其为一致快照。备份本身包含用户敏感内容，权限保持 600，目录保持 700，不上传公开对象存储。2026-09-24 已有 `/var/backups/bibo-planet/pre-restart-20260924-1025.tar.gz`（运行时无测试写入窗口，重启前保护）及 `/var/backups/bibo-planet/pre-update-20260924-1035.tar.gz`（Bibo 停写窗口，一致更新前快照）。后者已在隔离目录解包并用当前 `AuthStore`/`WorldStore` 成功读取三只精灵与五次遭遇；测试副本已删除，原归档保留。

首次离机副本位于阿里云杭州私有、同城冗余且启用 AES256 服务端加密的 `oss://bibo-planet-backups-peiiii-2026/2026-09-24/pre-update-1035.tar.gz.gpg`；加密对象 SHA-256 为 `fb25b051efe5eb9c50e6e6cf5e3818b285ff76c8b531f8d2e62bd39b73d68e50`。归档在 ECS 上先用 Bibo 专用公钥加密，之后才离开 ECS；本机 GPG 私钥在 `/Users/peiwang/.config/bibo-planet/backup-gnupg`（目录权限 700），指纹 `5F8E8F0ACD781073015DA60736B6237F21ECE2A9`，不要上传、打印或丢失该私钥。当前私钥无额外口令，仅依赖本机文件权限保护；应由用户另行安全保管恢复副本，不能把单机存放当成密钥灾备。该对象已从 OSS 下载、核对 SHA-256 并在本地流式解密读到完整归档列表；没有在本机落盘解密后的用户数据。它只覆盖当时的状态，后续自动备份机制见下段。

已新增每日 `bibo-planet-backup.timer`，北京时间 04:15 左右调用 `deploy/backup.sh`：检查世界文件和 GPG 公钥 → 仅停 Bibo 服务以取得一致归档 → 立刻重启 Bibo → 公钥加密 → 通过 `BiboPlanetBackupRole` 将加密文件上传 `oss://bibo-planet-backups-peiiii-2026/daily/`。RAM 角色只获准对这个前缀执行 `oss:PutObject`，没有 OSS 读取、列举或删除权，也没有长期 AccessKey；上传工具为 ECS 上校验官方 SHA-256 后安装的 `/opt/bibo-ossutil/bin/ossutil`。2026-09-24 10:57 手动启动**同一个 systemd 备份服务**成功，Bibo 自动恢复 active；新对象 `daily-2026-09-24-105745.eHMQDDOn.tar.gz.gpg` 已从 OSS 下载，SHA-256 `33f5cb84af8dc4e1d414545965a08dc360fe5dbf374c46704ec17deffcb96683` 与 ECS 一致，并可在本机流式解密读出 8 个归档条目。定时器已 enabled/active，下一次计划 2026-09-25 04:15 左右；**自然定时触发仍待明日观察**。

2026-09-24 12:53 使用有权读取桶配置的本机阿里云 CLI 查询 OSS `GetBucketLifecycle`，返回 `NoSuchLifecycle`；`daily/` 实际 4 个对象、15,495 字节。当前**没有**自动到期清理，ECS 上 `deploy/backup.sh` 成功上传后也会保留本地加密档案。删除策略和灾难恢复时防止已删除旅人数据回流须先设计、验证再配置；在此之前不要对访客承诺固定保留期或“删除后所有备份消失”。本次只读查询，没有改动桶和任何备份。

2026-09-24 11:07 更新应用前再次手动运行同一备份 service，上传加密对象 `daily-2026-09-24-110754.nZkVicP6.tar.gz.gpg` 成功，服务器源文件 SHA-256 为 `9ce499fd6d5668734624fc7ceb00744b0c0c70860c91d71ac6aa3002e9980fc6`，Bibo 与定时器均恢复 active。第二个对象也已从 OSS 下载，SHA-256 与源文件一致，本机私钥流式解密后可列出 8 个归档条目；临时下载副本已删除。

2026-09-24 11:28 后端再次更新前用同一服务创建加密对象 `daily-2026-09-24-112757.1IRHOL1L.tar.gz.gpg`，源文件 SHA-256 为 `8e2ab0aa93ebedeccc9c4a3033b598184cb83a64579b14b0a0ba1c935c2557ab`。该对象也已从私有 OSS 取回，哈希一致，私钥流式解密可列出 8 个归档条目；临时副本已删除。只观察到同一 service 手动实跑，仍未观察到 2026-09-25 首次自然定时触发。

恢复时先停止**仅 Bibo** 的服务，保留故障时数据的另一个 root-only 快照，检查归档内容和目标路径，再恢复到 `/var/lib/bibo-planet`、校正 `bibo-planet` 所有权并启动服务。若用离机副本，先由持有上述私钥的本机下载、核对记录的 SHA-256 并解密到受控临时目录，再将解密后的档案通过可信通道恢复；不能把私钥复制到公网服务器。随后从公网检查账号会话、各精灵遭遇数、能量与私人历史。恢复会覆盖当前世界状态，不能在活跃用户仍在写入时盲目执行；如需回滚，只选择经过核对的精确归档，不删除其它备份。当前尚未进行生产原位覆盖恢复演练。

## 版本更新与回滚

1. 在本地完成 TypeScript、测试、构建、真实模型和差异审查，记录待发布 Git SHA。公开前端与后端的 API 合同要一起验证，不把未推送的本地文件当发布源。
2. 先备份数据。在 ECS 确认 `/opt/bibo-planet` 工作区干净、当前 SHA 和服务健康；从已推送仓库快进到待发布 SHA。使用 `/opt/bibo-node/bin` 下的 pnpm 按锁文件安装依赖，然后只重启 `bibo-planet`，确认其日志和公网 API。不要重启 NextClaw 原服务。
3. 若前端/Worker 发生变化，在本地用 Wrangler 发布同一 Git SHA 的 Cloudflare Worker。Worker secret 应保留；不可把它写进 `wrangler.jsonc`。发布后重新检查首页、账号、连续两轮真实对话、跨账号隔离与原站可用性。
4. 回滚应用代码时只对 `/opt/bibo-planet` 使用已知可工作的 SHA，并保留数据目录；只有数据结构不兼容且已评估用户新增数据损失时才按上一节恢复数据。Cloudflare Worker 可回退至已知版本；每次回退后必须从公网重验完整链路。

当前发布锚点（2026-09-24，北京时间）：ECS 后端应用 Git `2e4ee55`，Cloudflare 前端/Worker 源 Git `7d98c80`、Worker 版本 `10a034f5-8cb2-4667-b1ce-66c032d2daf0`。前端、`robots.txt`/`llms.txt`、受限 CSP、AI 来源标记和本人对话导出按钮均已在公网；ECS 后端未因这些静态资源修正而重启。公网世界接口含最近相遇时间；服务端会根据明确线索从更早共同遭遇中找回少量片段，不增加模型调用或新持久状态。跨 10 次遭遇的语义由隔离世界中的真实模型试验证明。两个隔离 Chrome 浏览器身份已完成注册、跨访客共享记忆、私人原文隔离、退出重登；手机视口完成真实发消息与回复、断网失败恢复、历史排版复验，弹窗焦点循环、Esc 回归与密码清理由真实浏览器操作验证。1440×900 桌面首屏可见完整主操作，320px/390px 手机三卡和主操作可见，桌面和手机 Lighthouse 均为四项 100、47 项通过/0 失败。新的 AI 来源提示在桌面和 320px/390px 手机由真实 Chrome 验证，既有精灵回复也逐条标注。两个隔离浏览器账号导出的 JSON 已分别核对只含本人历史；320px 顶栏无溢出，一份会话读取失败则无部分文件。首个自然定时备份、删除/隐私/备案与境内公众 AI 服务要求仍未闭合，不能仅凭本节称为正式获客成品。

## 故障分层

- 首页不通：先检查 Cloudflare 自定义域名、Worker 部署与静态资源。
- 首页通、`/api/world` 不通：检查 Worker secret、到 `nextclaw.net` 的 HTTPS、Nginx 片段、systemd 与 loopback 端口。
- 注册/登录失败：区分 400 输入、401 凭据、403 Origin/边缘认证、429 IP 限流与 5xx 持久化故障。不要通过关闭来源检查或边缘密钥来“修复”。
- 对话失败：区分账号/世界额度、精灵能量、模型供应商余额/凭据/限流/超时；不返回模拟 AI 文字冒充成功。
- 只有一个访客异常：先看浏览器会话与该账号的个人额度；不要导出其他访客原始对话辅助排查。

未完成的正式验收项和每轮证据以[公网交付与验收记录](plans/2026-09-24-public-launch.plan.md)为准。
