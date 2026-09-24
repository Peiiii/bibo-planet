# Bibo Planet 线上运行手册

状态：2026-09-24 记录的实际部署；变更后须同步复核。上线地址为 <https://planet.bibo.bot>，源码为 <https://github.com/Peiiii/bibo-planet>。本手册只存放路径、流程和检查项，不存放任何密钥值或私人对话内容。

## 运行边界

- Cloudflare Worker `bibo-planet` 提供静态站，将 `/api/*` 通过 HTTPS 转发至 `https://nextclaw.net/__bibo/api/*`。Worker secret `BIBO_EDGE_SECRET` 与服务端 `/etc/bibo-planet/env` 中同名值一致；前端和 Git 都不能得到该值。
- 静态响应头由构建进 `dist/` 的 `public/_headers` 管理，覆盖首屏与指纹化资源；API 响应由 Worker 代码生成，不受该文件覆盖。2026-09-24 已在公网确认 HTML 与 JS 均带防嵌入、`nosniff`、Referrer/Permissions Policy、有限 CSP 与 HSTS；改动该文件时须同时检查真实页面可加载和 API 会话链路。Cloudflare 官方合同：<https://developers.cloudflare.com/workers/static-assets/headers/>。
- 阿里云杭州 ECS `i-bp11euxyc7o1ned0k8yd` 上的 Bibo 服务独立运行：源码 `/opt/bibo-planet`，Node `/opt/bibo-node/bin/node`，systemd 单元 `bibo-planet`，只监听 `127.0.0.1:3039`，运行身份 `bibo-planet`。Nginx 的 `nextclaw-net.conf` 包含独立片段 `/etc/nginx/bibo-location.conf`，旧站主页不应受影响。
- 用户数据在 `/var/lib/bibo-planet`，其中 `accounts.json` 含密码哈希和会话哈希，`spirits/*/state.json` 含所有旅人的原始对话及共同遭遇，均属敏感数据。服务端凭据在 root-only `/etc/bibo-planet/env`。不要把数据、环境文件、Cloud Assistant 输出或备份上传到仓库。
- 生产 unit 设置 `NODE_ENV=production`。自 `bef2fd8` 起，启动时若账号或任意一只精灵的状态文件缺失，进程会拒绝监听，不能靠自动新建空数据来“恢复”；先核对数据路径与挂载，按下方备份流程恢复，不能删除其余文件后重启。首次本地开发世界仍可显式初始化，生产不以此方式引导新世界。
- 生产模型当前配置为 DeepSeek 正式 API 的 `deepseek/deepseek-flash`，通过 NextClaw Harness 的无宿主工具模型能力调用。Flash 的特定备案号尚未核实，不能沿用旧 Chat 模型号。当前公开版不具备自写代码、文件/命令/网络工具或 mini-app 沙箱；不能在产品文案中宣称这些已交付。

## 日常健康检查

1. 从外网确认 `https://planet.bibo.bot/`、`/api/world`、`/api/session` 返回 200。匿名访问 `/api/spirits/mori/conversation` 应为 401；直接访问 `https://nextclaw.net/__bibo/api/world` 而不带内部密钥应为 403。
2. 在 ECS 确认 `systemctl is-active bibo-planet` 为 `active`，`nginx -t` 通过，`nextclaw.net` 原站首页仍为 200。只看 `journalctl -u bibo-planet` 的错误类型和状态；不回显请求正文或环境变量。
3. 确认 `/var/lib/bibo-planet` 有足够磁盘空间、服务内存未接近 `MemoryMax=900M`；观察模型 401/402/429/超时、每日尝试额度与供应商余额/账单。每账号每天最多 18 次业务层唤醒尝试与 12 次成功唤醒，全星球最多 240 次业务层尝试；调用前预留并持久化，失败也占尝试预算。**这不是供应商实际 HTTP 请求数或账单金额的硬上限**：已安装的 NextClaw 兼容适配器在瞬时错误下每个 API base 可重试最多 3 次，根路径配置还可能试 `/v1`；未来多实例也不会共享当前单机账本。监测真实余额/账单和[官方价格](https://api-docs.deepseek.com/quick_start/pricing/)，不能只看首页 200；必要时以受控测试账号发一条真实消息。

## 备份与恢复

每次服务端更新、数据结构迁移和高风险运维前，在 ECS 创建 root-only 备份目录。可靠备份时先短暂停止**仅 Bibo** 的写入，再一起归档 `accounts.json` 与整个 `spirits` 目录，随后启动服务；不能在有并发写入时分别复制这些文件并称其为一致快照。备份本身包含用户敏感内容，权限保持 600，目录保持 700，不上传公开对象存储。2026-09-24 已有 `/var/backups/bibo-planet/pre-restart-20260924-1025.tar.gz`（运行时无测试写入窗口，重启前保护）及 `/var/backups/bibo-planet/pre-update-20260924-1035.tar.gz`（Bibo 停写窗口，一致更新前快照）。后者已在隔离目录解包并用当前 `AuthStore`/`WorldStore` 成功读取三只精灵与五次遭遇；测试副本已删除，原归档保留。

首次离机副本位于阿里云杭州私有、同城冗余且启用 AES256 服务端加密的 `oss://bibo-planet-backups-peiiii-2026/2026-09-24/pre-update-1035.tar.gz.gpg`；加密对象 SHA-256 为 `fb25b051efe5eb9c50e6e6cf5e3818b285ff76c8b531f8d2e62bd39b73d68e50`。归档在 ECS 上先用 Bibo 专用公钥加密，之后才离开 ECS；本机 GPG 私钥在 `/Users/peiwang/.config/bibo-planet/backup-gnupg`（目录权限 700），指纹 `5F8E8F0ACD781073015DA60736B6237F21ECE2A9`，不要上传、打印或丢失该私钥。当前私钥无额外口令，仅依赖本机文件权限保护；应由用户另行安全保管恢复副本，不能把单机存放当成密钥灾备。该对象已从 OSS 下载、核对 SHA-256 并在本地流式解密读到完整归档列表；没有在本机落盘解密后的用户数据。它只覆盖当时的状态，后续自动备份机制见下段。

已新增每日 `bibo-planet-backup.timer`，北京时间 04:15 左右调用 `deploy/backup.sh`：检查世界文件和 GPG 公钥 → 仅停 Bibo 服务以取得一致归档 → 立刻重启 Bibo → 公钥加密 → 通过 `BiboPlanetBackupRole` 将加密文件上传 `oss://bibo-planet-backups-peiiii-2026/daily/`。RAM 角色只获准对这个前缀执行 `oss:PutObject`，没有 OSS 读取、列举或删除权，也没有长期 AccessKey；上传工具为 ECS 上校验官方 SHA-256 后安装的 `/opt/bibo-ossutil/bin/ossutil`。2026-09-24 10:57 手动启动**同一个 systemd 备份服务**成功，Bibo 自动恢复 active；新对象 `daily-2026-09-24-105745.eHMQDDOn.tar.gz.gpg` 已从 OSS 下载，SHA-256 `33f5cb84af8dc4e1d414545965a08dc360fe5dbf374c46704ec17deffcb96683` 与 ECS 一致，并可在本机流式解密读出 8 个归档条目。定时器已 enabled/active，下一次计划 2026-09-25 04:15 左右；**自然定时触发仍待明日观察**。

2026-09-24 12:53 使用有权读取桶配置的本机阿里云 CLI 查询 OSS `GetBucketLifecycle`，返回 `NoSuchLifecycle`；`daily/` 实际 4 个对象、15,495 字节。当前**没有**自动到期清理，ECS 上 `deploy/backup.sh` 成功上传后也会保留本地加密档案。删除策略和灾难恢复时防止已删除旅人数据回流须先设计、验证再配置；在此之前不要对访客承诺固定保留期或“删除后所有备份消失”。本次只读查询，没有改动桶和任何备份。

2026-09-24 17:20 补核对[阿里云 PutBucketLifecycle 规则](https://help.aliyun.com/en/oss/developer-reference/putbucketlifecycle)与[到期执行机制](https://help.aliyun.com/en/oss/analysis-of-the-reasons-why-the-oss-configuration-file-does-not-take-effect-after-its-lifecycle)：`Expiration.Days` 以对象最后修改时间计算，但 OSS 会按日执行，到期后可能延迟删除，规则初次加载也可有延迟；`PutBucketLifecycle` 会覆盖整个桶的现有规则。将来配置时必须先读取并保留其它规则，限定备份专用前缀而绝不覆盖不随快照回滚的 `deletions/`；核对实际对象清理结果并处理异常。页面不得承诺“最多 N 天”这样的硬上限，只能准确说明到期规则与可能延迟。当前仍未配置任何生命周期或执行删除。

2026-09-24 17:21 只读盘点发现上段只提 `daily/` 仍不完整：本地 `/var/backups/bibo-planet` 有 11 份 `daily-*.tar.gz.gpg`、早期 `pre-restart-20260924-1025.tar.gz` 与 `pre-update-20260924-1035.tar.gz` 两份**明文** root-only 归档，以及 `pre-update-20260924-1035.tar.gz.gpg` 一份密文；私有 OSS 共 14 个对象，其中 `daily/` 11 份、`2026-09-24/` 下早期密文 2 份、`deletions/` 初始化标记 1 份。配置到期规则时须覆盖 `daily/` 和旧日期前缀、并单独处理本地每日档案及早期明文/密文；不能给桶根前缀设统一删除而清掉墓碑。所有对象与本地文件目前原样保留，备份期限尚待用户确定。

2026-09-24 17:30 发布 `cdc5e2a` 的备份脚本可靠性修正：并发锁冲突现在返回失败，不能再把无新产物误记为成功；调用 `systemctl stop` 前就布置退出时重启保护。ECS 远端 `bash -n`、占锁拒绝路径、同一 systemd 服务手动正常备份路径均通过。新对象 `daily-2026-09-24-173010.Ag8MOaPm.tar.gz.gpg` 在 ECS 与 OSS 均为 14,075 字节，OSS ETag 与本地 MD5 同为 `719cf6efc3f48096997cd8b24ed82072`；Bibo 服务和 timer 均 active，`NRestarts=0`。这不代替首次自然定时触发，也不改变尚未配置的清理期限；前一段 17:21 的对象数量是当时快照，新对象使 `daily/` 至少增至 12 份。

### 账号删除记录的离机准备（2026-09-24 16:35，北京时间；尚未启用线上删除）

- 新增独立 RAM 策略 `BiboPlanetDeletionLedger` 并附加到现有 ECS 角色 `BiboPlanetBackupRole`：只允许对私有桶的 `deletions/` 前缀列举、读取、写入；无删除权，原 `daily/` 仍只有备份上传权。已从 RAM API 回读实际策略版本 `v1` 与附加关系。以服务身份 `bibo-planet` 实试写入、读回并同步 `deletions/schema-v1.json` 成功；反向列举 `daily/` 返回 403。该标记只有格式号，不含账号或对话。策略文件为 [`deploy/deletion-ledger-ram-policy.json`](../deploy/deletion-ledger-ram-policy.json)，标记内容为 [`deploy/deletion-ledger-marker.json`](../deploy/deletion-ledger-marker.json)。[阿里云前缀授权说明](https://help.aliyun.com/en/oss/user-guide/access-control-base-on-ram-policy)与[OSS 成功写入后的强一致性说明](https://help.aliyun.com/en/oss/user-guide/what-is-oss)是权限及重放设计依据。
- 原备份使用的 ossutil v1 保持不变。为删除记录的 `sync` 路径另在 `/opt/bibo-ossutil-v2/bin/ossutil` 安装官方 2.4.0 Linux amd64 包，下载包 SHA-256 与[阿里云公布值](https://help.aliyun.com/en/oss/developer-reference/ossutil-overview/) `85edf66b2fb7238f5c7e25cab820cf29312319fe4935b7c86a6b8485eb434f3c` 一致，安装脚本见 [`deploy/install-ossutil-v2.sh`](../deploy/install-ossutil-v2.sh)。旧 `/opt/bibo-ossutil` 曾为排查执行权限短暂开放目录遍历，发现 v2 有独立路径后已恢复 root-only `700`；原备份脚本仍用旧路径且未改。Bibo、备份 timer 和旧站均未因此重启。
- 2026-09-24 16:56 北京时间，在 ECS 上以 `bibo-planet` 身份，从已推送的 `codex/account-deletion` 分支的隔离临时克隆直接运行 `OssDeletionRemote`：先读取初始化标记得零条记录，再对不对应任何真实账号的固定测试 UUID 写入一条记录并重新读取，精确得到这一条；本机管理员只对该确切测试对象 `deletions/11111111-1111-4111-8111-111111111111.json` 进行 `stat` 后删除，复查前缀只剩 `schema-v1.json`。临时克隆自动清理；未改变现有账号、精灵、日备份对象或线上服务。它证明实际服务角色下适配器的读写回环，**不等于**旧快照与真实离机墓碑的集成恢复演练。
- 2026-09-24 16:58 北京时间补做**实际 OSS 适配器 + 旧快照隔离重放**：仍只在 ECS 的临时克隆/临时数据目录运行新代码，创建两名合成旅人，使三只精灵各有双方记录；保存删除前账号及三只精灵的旧快照，再经真实 `OssDeletionRemote` 删除一名测试旅人。把旧快照写回并移走本地墓碑目录后，重新构造 `AuthStore`、`WorldStore` 与删除协调者，从真实 OSS 同步墓碑并在启动前重放；检查被删旅人的会话/三只精灵遭遇均为零，另一旅人的账号、每只精灵两条私人消息和各一条共同遭遇仍存在。命令返回 `live-offsite-replay-ok`；隔离目录退出时清理。管理员随后对该合成账号的确切 OSS 墓碑对象先 `stat` 再删除，复查 `deletions/` 只剩标记；公网 Bibo 世界 API 与旧站均为 200。**这不是生产原位恢复，也没有删除或恢复任何真实旅人数据。**
- 账号删除代码与「账号与数据」页面已部署，但公开开关仍为 `enabled:false`，删除 POST 返回 503。生产环境已配置独立于快照目录的 `BIBO_DELETION_LEDGER_DIR=/var/lib/bibo-planet-deletions`、`BIBO_OSSUTIL_PATH=/opt/bibo-ossutil-v2/bin/ossutil`、`BIBO_DELETION_OSS_PREFIX=oss://bibo-planet-backups-peiiii-2026/deletions`、`BIBO_DELETION_OSS_ENDPOINT=oss-cn-hangzhou-internal.aliyuncs.com` 和 `BIBO_DELETION_OSS_REGION=cn-hangzhou`。启动时先从 OSS 同步完整墓碑并重放，异常则拒绝监听；不能通过删去配置绕过保护。部署与验证详情以[公网交付记录](plans/2026-09-24-public-launch.plan.md)的最新接续检查点为准，不能把代码上线等同于删除权已开放。
- 公开删除接口另由 `BIBO_ACCOUNT_DELETION_ENABLED=true` 显式开启，并要求 `BIBO_BACKUP_RETENTION_DAYS`、`BIBO_PUBLIC_OPERATOR_NAME` 与 `BIBO_PRIVACY_CONTACT` 非空。**这些变量本身不证明**本地/OSS 生命周期已按相同期限真实配置，也不替代旧备份 + 最新墓碑的隔离恢复演练、用户页面与当前版本浏览器验收。在用户确认保留期和公开运营信息、实际生命周期与恢复验证完成前保持关闭；目前没有删除任何现有旅人数据或历史备份。

2026-09-24 11:07 更新应用前再次手动运行同一备份 service，上传加密对象 `daily-2026-09-24-110754.nZkVicP6.tar.gz.gpg` 成功，服务器源文件 SHA-256 为 `9ce499fd6d5668734624fc7ceb00744b0c0c70860c91d71ac6aa3002e9980fc6`，Bibo 与定时器均恢复 active。第二个对象也已从 OSS 下载，SHA-256 与源文件一致，本机私钥流式解密后可列出 8 个归档条目；临时下载副本已删除。

2026-09-24 11:28 后端再次更新前用同一服务创建加密对象 `daily-2026-09-24-112757.1IRHOL1L.tar.gz.gpg`，源文件 SHA-256 为 `8e2ab0aa93ebedeccc9c4a3033b598184cb83a64579b14b0a0ba1c935c2557ab`。该对象也已从私有 OSS 取回，哈希一致，私钥流式解密可列出 8 个归档条目；临时副本已删除。只观察到同一 service 手动实跑，仍未观察到 2026-09-25 首次自然定时触发。

恢复时先停止**仅 Bibo** 的服务，保留故障时数据的另一个 root-only 快照，检查归档内容和目标路径，再恢复到 `/var/lib/bibo-planet`、校正 `bibo-planet` 所有权并启动服务。若用离机副本，先由持有上述私钥的本机下载、核对记录的 SHA-256 并解密到受控临时目录，再将解密后的档案通过可信通道恢复；不能把私钥复制到公网服务器。随后从公网检查账号会话、各精灵遭遇数、能量与私人历史。恢复会覆盖当前世界状态，不能在活跃用户仍在写入时盲目执行；如需回滚，只选择经过核对的精确归档，不删除其它备份。当前尚未进行生产原位覆盖恢复演练。

2026-09-24 14:16 对最新 `daily-2026-09-24-135753.xy6UmX2X.tar.gz.gpg` 完成**离机对象隔离恢复验证**：从私有 OSS 取回的 SHA-256 `edc9a83dcd1893efe54bcae50691649bb06e0a63dd3c5a8fe4744e83d3bbda0c` 与 ECS 原文件一致；本机私钥解密到权限受限的临时目录，用当前 `AuthStore`、`WorldStore` 加载出 5 个账号、3 只精灵、8/7/3 次遭遇、36 条私人消息。验证只输出聚合计数，不输出个人或对话内容；临时目录在同一进程中清理。这证明该精确对象可被当前代码读取，**不等于生产原位覆盖恢复**，也不等于每日 timer 已自然触发。

## 版本更新与回滚

1. 在本地完成 TypeScript、测试、构建、真实模型和差异审查，记录待发布 Git SHA。公开前端与后端的 API 合同要一起验证，不把未推送的本地文件当发布源。
2. 先备份数据。在 ECS 确认 `/opt/bibo-planet` 工作区干净、当前 SHA 和服务健康；从已推送仓库快进到待发布 SHA。使用 `/opt/bibo-node/bin` 下的 pnpm 按锁文件安装依赖，然后只重启 `bibo-planet`，确认其日志和公网 API。不要重启 NextClaw 原服务。
3. 若前端/Worker 发生变化，在本地用 Wrangler 发布同一 Git SHA 的 Cloudflare Worker。Worker secret 应保留；不可把它写进 `wrangler.jsonc`。发布后重新检查首页、账号、连续两轮真实对话、跨账号隔离与原站可用性。
4. 回滚应用代码时只对 `/opt/bibo-planet` 使用已知可工作的 SHA，并保留数据目录；只有数据结构不兼容且已评估用户新增数据损失时才按上一节恢复数据。Cloudflare Worker 可回退至已知版本；每次回退后必须从公网重验完整链路。

历史发布锚点（2026-09-24 14:02，北京时间）：ECS 后端应用与 Cloudflare 前端/Worker 源均为 Git `9046ef1`，Worker 版本 `85bc613c-115c-45e8-aa30-c2ef000c21d6`。本次发布前仅对 Bibo 启动专用备份服务并确认 success；新的加密档案 `daily-2026-09-24-132521.3Byfnthr.tar.gz.gpg` 已在私有 OSS 列表中确认存在。随后从 OSS 下载该精确对象，SHA-256 `ef6ce100821ab738951e75f899b5f4786034950026164f5b67085166a668fd55` 与 ECS 文件一致，本机私钥流式解密可完整读取 8 个归档条目；临时加密副本已清理、没有落盘明文。这不等于生产原位恢复演练，也不等于自然 timer 已触发。发布时只重启 Bibo 服务，Bibo 与备份 timer active、服务器工作区干净，原 `nextclaw.net` 主页 200。公网已有 `robots.txt`/`llms.txt`、受限 CSP、AI 来源标记、「导出我的数据」及对话标题旁的模型名称、备案号与官方来源。新档案由账号 Cookie 确定身份，包含本人账号基本资料、三只精灵的本人会话及本人贡献的共同遭遇；两个隔离 Chrome 旅人实际下载后核对各自原始记录分离、无密码或会话哈希，匿名接口 401，320px 页宽无溢出。该下载会包含私人内容，旅人应妥善保存。此前注册、真实模型连续对话、跨访客共享记忆、手机发送/恢复、键盘弹窗等验收证据详见[公网交付与验收记录](plans/2026-09-24-public-launch.plan.md)。首个自然定时备份、账号删除/完整隐私告知/权利路径、备案与境内公众 AI 服务要求仍未闭合，不能仅凭本节称为正式获客成品。 本次后端/Worker 更新前使用同一备份服务生成加密对象 `daily-2026-09-24-135753.xy6UmX2X.tar.gz.gpg`，服务返回 success，OSS 列表确认对象存在；随后已从私有 OSS 取回这一精确对象并完成隔离恢复验证，详见上方记录。生产配置只读核对为 `deepseek/deepseek-chat`，公网 `/api/world` 返回 `Deepseek Chat / Beijing-DeepseekChat-202404280016` 和 DeepSeek 官方来源。匿名 1440×900 与登录 320×700 Chrome 页面均显示该公示，桌面主操作仍完整、手机没有横向溢出；公网首页与世界 API、原站均 200，无边缘密钥源站路径 403。模型备案不等于本应用备案。

历史发布锚点（2026-09-24 14:32，北京时间）：ECS 后端 Git `b095bc9`，Cloudflare Worker `ae16925e-777c-4b66-b126-898179acb279`，静态 JS `index-WtFKkIZ1.js`。发布前仅对 Bibo 执行专用备份服务，systemd 返回 success；私有 OSS 已列出本次加密对象 `daily-2026-09-24-142648.RoNUEwOr.tar.gz.gpg`。此次对象仅确认上传存在，尚未取回解密；上方 `13:57` 对象已完成隔离恢复验证。远端升级过程中，pnpm 子进程因未找到 `node` 导致第一次远端 TypeScript 检查停止，**当时没有重启服务**；随后用 `/opt/bibo-node/bin/node` 直接运行 TypeScript 编译器通过，才重启 Bibo。Bibo 与备份 timer 均 active，公网首页、世界 API 与原 `nextclaw.net` 首页均 200；无密钥的源站 Bibo 路径仍为 403。隔离本地浏览器验过新版即时显示回复及刷新持久性；公网 API 用新旅人实测 DeepSeek 连续两轮、同编号重放不重复计数/扣额、私人历史 4 条。公网浏览器自动控制本次超时，不能把本地 UI 加公网 API 说成已完成公网浏览器复验。首个自然定时备份、数据权利/备案和境内 AI 服务要求仍未闭合，不能称为正式获客成品。

当前发布锚点（2026-09-24 14:40，北京时间）：ECS 后端 Git `bef2fd8`；前端/Worker 沿用 Git `b095bc9` 与 Worker 版本 `ae16925e-777c-4b66-b126-898179acb279`，本次未改动或重部署前端。更新前核对四份生产状态文件非空、systemd `NODE_ENV=production`、Bibo/备份 timer active 且代码区干净；仅对 Bibo 执行备份服务并确认 success，私有 OSS 列表中确认加密对象 `daily-2026-09-24-143853.gKch4XDF.tar.gz.gpg`。该新对象只证实上传存在，尚未取回解密；较早 `13:57` 对象的隔离恢复证据见上文。远端 TypeScript 检查通过后只重启 Bibo；公网三只精灵的能量/相遇数未回退，首页/世界 API 与原站均 200，无密钥的源站 Bibo 路径为 403。公网新旅人实际完成注册、会话读取与塞拉真实模型一轮对话，本人历史 2 条、塞拉相遇 `3→4`。生产缺失数据路径在隔离空目录验证为启动失败且不新建空状态，尚未在生产故意移除状态文件或执行原位恢复。首次自然定时备份及 AC-10/AC-11 仍未完成。

当前前端发布锚点（2026-09-24 15:13，北京时间）：ECS 后端仍为 `bef2fd8`，前端/Worker 源码 Git `53fc153`，Cloudflare Worker 版本 `510cf954-4f8f-4dad-b4d2-34146f184d8a`，静态资产 `index-CABBpF2h.js` / `index-BZ1BJUsa.css`。只发布 Cloudflare，没有重启 Bibo 或同机旧站；公网匿名桌面和 320px 手机真实 Chrome 确认共享记忆的直白告知及注册弹窗可读、无横向溢出。公网首页、世界 API、会话 API、原 `nextclaw.net` 首页均 200，无密钥源站路径 403。用户对话的原文可能经精灵共享记忆间接影响他人的回答，这条界面提示不等于完整隐私协议或保密保证；AC-10/AC-11 与自然备份触发仍待闭合。

当前模型迁移发布锚点（2026-09-24 15:34，北京时间）：ECS 后端与 Cloudflare 前端/Worker 源码 Git 均为 `24e74dc`，Worker 版本 `f478fe10-3340-4975-9626-62711c10a0d1`，静态 JS `index-AE5DR_XF.js`。更新前对 Bibo 专用备份服务执行 success，私有 OSS 独立列出新加密对象 `daily-2026-09-24-152812.QlCNZtPA.tar.gz.gpg`；此新对象尚未取回解密，较早备份的隔离恢复证据见上文。ECS 代码区干净并快进到该 SHA，TypeScript 检查通过；只将 `/etc/bibo-planet/env` 中 Bibo 的 `BIBO_MODEL` 从 `deepseek/deepseek-chat` 改为 `deepseek/deepseek-flash`，文件仍为 root:root、600，只重启 `bibo-planet`。服务与备份 timer active。目标 ECS 在独立临时目录以相同供应商凭据真实调用 Flash 成功，临时目录已清理；发布后公网 `/api/world` 显示 DeepSeek Flash、无未经核实的备案号。两名新旅人经公网 API 完成 A 连续两轮、B 跨旅人线索一轮，私人历史分别 4/2 条，墨里相遇 `14→17`、额度按成功回复扣减。公网首页与世界/会话 API、原站均 200，无边缘密钥源站路径 403；静态资源包含「模型资料」链接文案。本次浏览器控制连接超时，**尚无新发布版本的浏览器操作证据**，需补验；不能把 API 成功冒充 UI 完成。AC-06 首次自然 timer、AC-10/AC-11 及最终 AC-08 仍未闭合。

当前尝试预算发布锚点（2026-09-24 15:50，北京时间）：ECS 后端和 Cloudflare 前端/Worker 源均为 Git `f402a00`，Worker 版本 `6e704e07-d179-4133-820c-15eda0dedf4d`，静态 JS `index-msSQyIEg.js`。部署前同一 Bibo 专用备份服务 success，私有 OSS 独立列出加密对象 `daily-2026-09-24-154626.orIJXJ7s.tar.gz.gpg`；该新对象尚未独立取回解密。远端代码快进后 TypeScript 检查和既有 `AuthStore` 只读加载通过，生产 11 条未带尝试字段的账号行按旧成功次数兼容；只重启 Bibo，服务与备份 timer active。公网新旅人实际获得皮可 Flash 回复，个人档案尝试/成功各 1，私人会话 2 条、皮可相遇 `7→8`；相同请求编号重放只返回持久化结果，尝试/成功/相遇均不再增加。首页、世界/会话 API、原站复查为 200，无边缘密钥源站路径 403；本机公网 CLI 偶有 SSL/HTTP2 传输错误，重试后成功，尚未定位来源。浏览器控制本轮仍超时，当前版本页面实际交互、手机文案换行未复验，不得称为完成。AC-06、AC-10、AC-11 和最终 AC-08 仍未闭合。

当前删除底层的**关闭门控发布**（2026-09-24 17:17，北京时间）：Git `015dc21` 已快进 `origin/master`，ECS `/opt/bibo-planet` 同 SHA、工作区干净；Cloudflare Worker 版本 `3fc580cb-7465-4707-8ede-afbcaa0f1fd8`，静态资产 `index-C-jzwFeW.js` / `index-OaS0jd_A.css`。部署前 Bibo 专用备份 service 返回 `Result=success/ExecMainStatus=0`（oneshot 结束后 `inactive` 是正常状态，不是失败），OSS 新密文 `daily-2026-09-24-170658.yyZnWJva.tar.gz.gpg` 从 OSS 精确取回，SHA-256 `223b86bb515ddbce3e6f82137761670f81874a287f1fd7cda462503a873eb47f` 与 ECS 原件一致；本机私钥流式解密能列出账号和三只精灵状态，下载临时副本已清理。远端更新前后均检查四份状态文件非空、工作区无改动，更新后 TypeScript 与 unit 解析通过；新 `/var/lib/bibo-planet-deletions` 为 `bibo-planet:bibo-planet 700`，unit 的 `ReadWritePaths` 只含原世界目录和该独立目录。旧 unit 备份为 root-only `/etc/systemd/system/bibo-planet.service.pre-015dc21`。只重启 Bibo 后服务 active、`NRestarts=0`，备份 timer active，下一次自然触发预计 2026-09-25 04:19 北京时间。公网页面、世界 API、原站均 200，无密钥回源 403；删除策略 API 为 `enabled:false`，删除 POST 为 503。公网新合成旅人注册、塞拉两轮真实 Flash 回复、个人数据导出 API 四条、退出/重登后历史四条，相遇 `4→6`。本轮浏览器控制再次超时，不能把 API/静态发布当作当前版本浏览器点击验收；没有删除任何真实旅人或备份，AC-10/AC-11/最终 AC-08 仍开放。

2026-09-24 16:00 北京时间对上述 `15:46` 对象补做**精确离机对象隔离恢复**：从私有 OSS 取回的密文 SHA-256 `38053ad385f50e19333b1de02ee13b229f74a3163d0fc2ede4247219e163b141` 与 ECS 原文件一致；本机受限临时目录解密后，用当前 `AuthStore` 和 `WorldStore` 加载出 11 个账号、3 只精灵，相遇数 17/7/4、共 56 条私人消息。只输出聚合计数，未输出旅人身份与对话，下载密文和临时明文在同一命令的退出清理中删除，后续检查无残留临时目录。这证明该对象能被当前代码读取，**不代表生产原位覆盖恢复**，也不代表明日定时器已自然触发。

同一时段对公网链路做五次/路径的小样本诊断：本机默认代理 HTTP/2 与 HTTP/1.1 各有 1/5 次 TLS 握手失败，绕过代理直连 5/5 成功、约 1.63–6.21 秒；杭州 ECS 经公网域名 5/5 成功、约 1.10–5.48 秒。此前还见到本机 HTTP/2 framing 错误。此结果只能提示本机代理可能参与失败，不能排除 Cloudflare 或地区网络问题，更不能外推真实国内用户延迟。若出现公网偶发故障，先区分本机代理、边缘和源站，再决定是否改部署入口；不要仅因本机一次 `curl` 错误重启 Bibo。

## 故障分层

- 首页不通：先检查 Cloudflare 自定义域名、Worker 部署与静态资源。
- 首页通、`/api/world` 不通：检查 Worker secret、到 `nextclaw.net` 的 HTTPS、Nginx 片段、systemd 与 loopback 端口。
- 注册/登录失败：区分 400 输入、401 凭据、403 Origin/边缘认证、429 IP 限流与 5xx 持久化故障。不要通过关闭来源检查或边缘密钥来“修复”。
- 对话失败：区分账号/世界额度、精灵能量、模型供应商余额/凭据/限流/超时；不返回模拟 AI 文字冒充成功。
- 只有一个访客异常：先看浏览器会话与该账号的个人额度；不要导出其他访客原始对话辅助排查。
- Bibo 反复启动失败且提示账号或精灵状态缺失：按数据丢失事件处理，保持服务不对外写入；核对 `/var/lib/bibo-planet` 路径、文件和最近成功的精确加密备份，先隔离验证再决定是否原位恢复。禁止改成开发模式绕过缺失检查。

未完成的正式验收项和每轮证据以[公网交付与验收记录](plans/2026-09-24-public-launch.plan.md)为准。
