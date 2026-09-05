# 更新日志 / CHANGELOG

本文件记录 CipherChat 各版本的主要变更。

## v1.8.1（当前）

> 双主题：**合并 v1.7.1 部署可靠性修复与 v1.8.0 自检系统**（两条平行开发线正式汇合）、**修复并发上传竞态与 standalone 部署数据目录脑裂**（本次审计新发现的三个真实缺陷）。

### 版本合并（v1.7.1 ⊕ v1.8.0）

- v1.7.1（部署可靠性热修复）与 v1.8.0（自检系统大版本）均基于 v1.7.0 平行开发，互不包含对方改动；本版本将二者完整合并。合并基线为 v1.8.0，全量合入 v1.7.1 的部署可靠性修复，二者改动区域互补、无逻辑冲突（仅 `src/store/chat.ts` 双方同时改动，已逐处手工合并：v1.7.1 的自动重连自愈与 v1.8.0 的连接失败提示共存）。
- **合入的 v1.7.1 内容**：数据库自举三件套（`db-bootstrap.ts` / `instrumentation.ts` / session 路由兜底）、relay 启动前自举 + `chat:join` 异常触发补自举、客户端 `chat:error(server)` 可见提示 + 3 次退避自动重连 + 发送被拒集中反馈（`notifySendRejected`）、`start-all` 单命令同拉 web+relay、`postbuild` 布局自适应构建、`relay-probe` / `e2e-relay-verify` 探针、Dockerfile / docker-entrypoint / deploy/ / .env 系列部署文件回归。
- **保留的 v1.8.0 内容**：管理员一键自检系统（12 项真实世界检查 + 一键修复 + CLI 医生）、网盘存储统计根因修复与历史坏数据重算、全链路静默失败清理（统一错误翻译器）等全部功能。
- `package.json` 启动链采用 v1.7.1 方案（`start` = `start-all` 单命令；`build` = `next build` + `postbuild`；另提供 `start:web` / `start:relay`）。

### 修复：并发上传分块序号竞态（上传必失败 BUG）

- **根因**：`uploadEncryptedFile` 的并发 worker 循环中，`while (nextIndex < totalChunks)` 检查与 `nextIndex++` 领取之间夹着 `await waitIfPaused()` 挂起点 —— 两个 worker 同时通过检查后先后领取，后领取者拿到 `totalChunks` 本身（越界），服务端以「分块序号超出范围」400 拒绝，整个上传失败。
- **触发面**：并发度 ≥ 2 时，**≤1 块的文件（≤4MiB，即最常见的图片/小文件）100% 触发**；多块文件在 worker 于边界处碰头时间歇触发。聊天与网盘上传共用该函数，全部受影响。v1.7.1 与 v1.8.0 均携带此缺陷（继承自 v1.5.0 暂停功能引入的挂起点），此前所有测试均未覆盖「单块 + 并发」组合。
- **修复**：领取动作与循环条件检查放入同一同步块（中间零 await），领取即原子；暂停等待移到领取之后。
- **回归测试**：新增单块/多块并发上传竞态单测（模拟服务端 400 语义，断言全部块恰好各上传一次且无越界），vitest 56 → 58。

### 修复：standalone 部署数据目录脑裂（隐私泄露 + 三类功能失效）

- **根因**：`DATA_DIR=data` 相对路径依赖各进程 CWD 解析 —— web（standalone `server.js` 启动即 `process.chdir(__dirname)` → `.next/standalone`）与 relay（CWD = 项目根）解析出**两个不同的数据目录**。web 写入的密文，relay 永远删不到。
- **实际后果**（修复前全部真实发生）：消息删除/清频道的密文留在磁盘（“已删除”的数据永不消失）；闪照「阅后即焚」假焚毁；`cleanupStaleUploads` 定时清理永不命中；自检的磁盘检查路径也指错目录。
- **修复**：① `start-all` 注入 `CIPHERCHAT_ROOT` 绝对路径锚点（按脚本位置推导，不依赖调用方 CWD），web/relay 两进程共享同一项目根；② `getProjectRoot()` 优先读取该锚点（原「向上找 prisma/schema.prisma」在 standalone 内含 prisma 副本时会定位到 `.next/standalone` 而非真实项目根）；③ `SERVER_CONFIG.dataDir` 一次性绝对化（相对路径基于项目根解析），filestore/selfcheck 的 `resolve(cwd, dataDir)` 从此与 CWD 无关；④ 备份目录、HTTPS 元数据目录同步改用同一根。

### 修复：一键备份静默丢库

- 旧备份命令固定打包 `<根>/db` —— 默认布局的库在 `prisma/dev.db`，平台注入 `DATABASE_URL` 时库可能在项目根之外，两种情况 tar 都会静默跳过（错误被 `2>/dev/null` 吞掉），产出的备份**不含数据库**，灾难恢复时才知道备份是坏的。
- 现按 `DATABASE_URL` 实际解析库文件（含 `-wal`/`-shm`），逐项存在才打包，多段 `-C` 兼容库在根内/根外两种布局；无可打包内容时明确报错而非产出空备份。

### 修复：自检首跑误报（全新部署）

- 「数据目录与磁盘空间」检查在 `data/` 尚未创建时（全新部署首次自检的必然状态）直接写探针文件失败 → 误报「不可写」，且推荐的修复动作 `vacuum-db` 与实际原因（目录不存在）完全无关。现按 filestore 同规则先 `mkdir recursive` 再探测，与真实应用行为一致。
- vitest 新增排除规则：`.next/standalone` 内的构建副本此前会被当测试文件跑，陈旧副本结果污染真实测试报告。

### 验证（真实部署 + 双浏览器模拟）

- `tsc --noEmit` 0 错误；ESLint 0 错误 0 警告；vitest 58/58。
- 网关真实路径（`/?XTransformPort=3003` → relay）双浏览器会话：双用户入频、实时消息互收、已读回执、正在输入、斜杠指令（/roll、/poll）、投票实时计票、文件上传（512KB 真实文件）与实时转发，全部通过。
- 协议级 E2E：聊天文件 3.5MiB/10MiB（单块/三块）上传→完结→下载→逐字节解密比对一致；闪照首看 200 / 再看 404 且密文真删；信箱注册→投递→取走即删；relay 探针 `code=auth`；双客户端 E2E 全链路。
- 消息删除后磁盘密文真实消失（脑裂修复的直接验证）；doctor 全量自检 9 正常 · 0 故障；一键备份产物含数据库 + 全部密文 + .env。

## v1.8.0

> 三大主题：**修复网盘存储统计严重缺陷（150MB 显示 4MB 的根因）**、**全链路消灭静默失败（失败必给原因与修复方式）**、**管理员一键自检系统（真实世界测试 + 一键修复 + 傻瓜化教程 + CLI 医生）**。

### 网盘存储统计缺陷修复（本次核心）

- **根因：`dirSizeBytesAsync` 并发丢失更新竞态** —— 旧实现的 `total += (await stat(...)).size` 在 Bun 运行时下，多分片并发 stat 时读-改-写被交错执行，38 个分片只累计出 1~2 块大小（实验复现：150MiB 文件统计为 2~4MiB 且结果随机）。这正是「上传 150MB、后台显示 4MB」的直接原因。修复为先在协程内求值每个 size，再 `reduce` 求和，与调度时机完全无关。
- **complete 不再静默吞错** —— 旧代码 `$increment` 配额累加失败被 `.catch(() => {})` 吞掉，配额永久漂移且用户无感知；现失败即返回明确原因 + 修复指引（管理员后台一键重算）。
- **DELETE 同理** —— 配额扣减失败不再静默，返回带修复指引的错误。
- **历史坏数据一键修复（`recalc-drive-usage`）** —— 升级前已存在的错误统计不会因代码修复而自愈；新增重算维护动作：以磁盘真实密文大小为唯一事实来源重写 `DriveFile.totalBytes` 与 `DriveRepo.usedBytes`，同时清理磁盘已丢失的「幽灵文件记录」，并汇报纠正偏差量。
- **统计一致性守护检查** —— 自检系统中的 `quota-consistency` 检查项持续核对 DB 统计 vs 磁盘真实，并区分「统计少记」（历史缺陷，可重算修复）与「磁盘数据缺失」（数据丢失，指引从备份恢复）两种性质完全不同的偏差。

### 管理员一键自检系统（全新）

- **模块化自检引擎 `src/lib/server/selfcheck.ts`** —— 12 项检查注册于统一注册表（新增检查 = 追加一个条目，零侵入）：数据库完整性（WAL + quick_check + 关键表）、数据目录与磁盘空间、文件存储真实 IO（写→读→比对→删）、**网盘全链路真实调用**（HTTP 自调用：建仓→init→分块→完结→下载→逐字节比对→清理→统计核对）、存储统计一致性、聊天文件完整性（缺块/孤儿）、WebSocket 中继（TCP + Socket.IO 握手）、TURN 可达性（TCP 探测）、HTTPS 证书、会话健康度、备份状态、功能开关总览。
- **每项失败自带三件套**：失败原因（一句话）+ 一键修复动作（对应维护端点）+ 傻瓜化分步教程；纯环境类问题（如 TURN 未配置）明确标注「无自动修复」并只给教程。
- **管理后台新增「自检」页签** —— 一键运行、分类分组展示红绿灯、指标卡片、可折叠明细、失败项内嵌「一键修复」按钮（修复后自动复查该单项）、报告导出 JSON、CLI 用法提示。
- **维护页新增三个一键动作** —— 重算网盘占用 / 清理孤儿文件 / 整理数据库（VACUUM + WAL checkpoint）。
- **CLI 服务器医生 `scripts/doctor.mjs`** —— 与后台共用同一套引擎：`bun scripts/doctor.mjs --key 超级密钥` 全量自检；`--fix-all` 自动修复全部可修复项并复查；`--recalc` / `--cleanup` / `--backup` / `--vacuum` / `--cleanup-sessions` 直连修复；`--json` 供脚本消费；密钥用与网页端完全一致的 PBKDF2 参数派生（原文不落日志）。
- **健壮性设计** —— 自检引擎级兜底（任何检查抛异常转为 fail 结果，绝不让自检崩溃）；建仓限流（每 IP 每小时 3 个）被自检频繁触发时优雅降级为「注意」并说明非故障；自检端点独立限流（6 次/10 分钟）。

### 静默失败清理（聊天频道 / 网盘 / 语音全链路）

- **统一错误翻译器 `src/lib/errors.ts`** —— 网络/HTTP 状态码/浏览器媒体权限/超时各类失败统一翻译为「标题 + 原因 + 处理方式」三段式；sonner toast 描述两段式呈现。
- **聊天频道** —— 加入失败（ChatJoin）不再裸抛英文原始错误；历史消息加载失败（原 `!res.ok` 静默返回）toast 告知原因与处理；**WebSocket 中继断连不再无声转圈**（`connect_error` 首次失败即 toast 原因 + 三步修复指引，恢复后自动重置提示开关）。
- **网盘** —— 列表加载失败不再静默（会话过期自动锁定）；上传失败条目与 toast 均带原因；删除失败带修复指引；**下载/预览失败从 `catch { /* ignore */ }` 改为完整提示**（用户点下载无响应的问题）；用户主动取消保存对话框不再误报错误。
- **语音** —— 语音消息气泡三处静默点全部补齐：autoplay 被浏览器策略拦截（提示点击重试即恢复）、`<audio>` 解码失败（提示换浏览器或录音损坏）、下载/解密失败（区分会话过期/网络/密钥问题）；手动点击播放失败同样告知。
- **录音** —— 麦克风失败按 NotAllowedError/NotFoundError/NotReadableError 细分原因（权限被拒/无设备/被占用），各配系统级修复步骤（此前一律「权限被拒绝」误导用户）。
- **TTS 朗读** —— 不支持 speechSynthesis、引擎异常均明确提示（此前静默返回，用户以为在读）；返回布尔结果供调用方感知。
- **WebRTC/TURN** —— ICE 配置获取失败、TURN 凭证签发失败不再静默回退直连（toast 告知影响与处理）；**time-limited 短期 TURN 凭证 45 分钟自动轮换**（过期前 15 分钟拉新，修复「语音突然全断且不知原因」的隐患）。

### 其他修复

- **`deleteFileDir` 安全护栏** —— 空/非法 fileId 会把 `join(root, '')` 解析成命名空间根目录导致误删整个 `data/chat` 或 `data/drive`；现校验 fileId 合法性 + 解析结果必须是根的子目录（双保险）。
- **信箱投递原子化** —— `mailboxItem` 容量检查从 count-then-create（并发下轻微超容 200）改为事务内原子操作。
- **自检测试数据零残留** —— 上传管线测试的临时仓库/文件/会话全部自动清理，且孤儿检测可兜底捕获任何残留。

## v1.7.0

> 本版本由 AI 代码审查 + 全自动优化产出：服务端 15 项安全/正确性修复、客户端 12 项性能/健壮性优化、5 个全新玩法，单元测试 50 → 106 个。

### 新增玩法（v1.7.0）

- **加密投票 `/poll`** —— `/poll 周末去哪|爬山|看电影` 一键发起：题目与选项随消息整体端到端加密，服务器只存「谁投了第几项」（新增 `ChatPollVote` 表，与 emoji 回应同级元数据颗粒度）；点选投票、实时计票条、可改票、旁听禁投（限流 30 次/10 秒）；历史消息 reload 后票数完整还原。
- **井字棋对战 `/ttt <昵称>`** —— 频道内双人博弈全员围观：发起者执 X 先手，任何人点棋盘格子即可接招落子；走子经合法性校验（占格/越界/轮次）后作为新加密消息广播，旧棋盘自动只读、仅最新局面可操作；三连判定/平局由纯函数实现并全量单测覆盖。
- **闪照（阅后即焚图片）** —— 输入栏 ⚡ 按钮开启闪照模式后发送文件：服务器首次有人开始下载即原子锁定（`viewOnceBurnedAt`），密文流读取完成后**真实删除磁盘分块与数据库记录**；第二个人再点直接「已焚毁」，反复拉流试探也会触发焚毁。闪照永不自动预览。
- **全屏特效 `/confetti` `/fireworks`** —— `/confetti 生日快乐！`、`/fireworks` 全频道同屏庆祝：彩带飘落带左右摆动与旋转，烟花三连发火箭升空后爆裂成 60+ 火花（纯 Canvas 2D + rAF，零依赖，粒子结束自动回收）；特效文案气泡居中展示，每条消息只播一次。
- **心情状态 `/mood <表情>`** —— `/mood 🌙` 设置后随 presence 加密广播（服务端不可读），成员面板昵称旁展示心情徽章；重进频道自动携带，空参数清除。

### 服务端安全修复

- **修复跨频道已读回执泄露** —— `chat:readers` 此前仅按 messageId 查询，任何频道成员可探测其他频道消息的读者列表与阅读时间；现 join `ChatMessage` 并限定 channelKeyId（schema 补齐 relation）。
- **修复 IP 伪造绕过限流** —— `X-Real-IP`/`X-Forwarded-For` 此前无条件信任，直连后端端口时可随意轮换伪造头绕过所有按 IP 限流；新增 `TRUST_PROXY` 环境开关（`off` 时回退 TCP 对端地址），`reqIp`/relay `socketIp` 同步支持回退。
- **TURN 凭证收敛** —— 公开 `/api/config` 不再下发静态长期 TURN 凭证，统一由 `/api/voice/turn-credentials` 签发（独立限流，会话优先）；客户端 `fetchIceServers` 改为按需获取。
- **修复磁盘填充绕过** —— 聊天/网盘上传此前允许 40000/100000 块 × 4MiB 分块（理论 160–400GB）而只校验 1/5GiB 字节上限；现分块数上限由字节上限推导并交叉校验「分块数 × 块上限 ≤ 声明大小」，新增网盘 init/chunk/complete 限流。
- **修复权限 fail-open** —— 发送消息的角色检查抛异常时此前按允许处理（DB 故障窗口内被吊销成员可继续发言），现 fail-closed。
- **密钥轮换权限门** —— start/finish 需 owner 角色（此前旁听也能发起并吊销全频道会话）；文件换绑去掉重复 updateMany。
- **私聊真定向** —— `chat:whisper` 此前名义定向实为全房间广播（全员可收到信封与 from/to 元数据），改为按 pubId 单播目标 socket；语音/私聊管理员开关现于 relay 服务端强制执行（此前只存不查）。
- **修复取消轮换孤儿文件** —— cancelRotation 此前只删 `ready=false` 行，已就绪文件被清了磁盘块却留记录（消息在但文件永久打不开）；现统一整行删除。
- **邀请兑换原子化** —— maxUses 名额改为条件 `updateMany` 原子抢占（并发兑换不再超限）；`getInviteKey` 竞态收敛：多行主密钥自动统一到最早一行。
- **修复历史接口 500** —— `?limit=abc`/`?before=garbage` 产生 NaN/Invalid Date 直传 Prisma；现严格校验参数。
- **网盘配额原子化** —— complete/delete 的 usedBytes 读-改-写改为 `$increment`/`$decrement`（并发下不再丢失更新、配额漂移）。
- **未完成上传定时清理** —— `cleanupStaleUploads` 原为死代码从未被调用，中断上传永久残留；relay 现每小时清理 24h 前的半成品（磁盘目录 + 数据库行）。
- **全局自毁补清语音状态** —— wipe 纪元变化时同时清空 `voiceState`/`voiceLobbyState`（此前被毁频道仍广播语音参会者并持有内存）。
- **chat:nick 限流** —— 昵称/头像/心情更新补 15 次/10 秒限流（此前单连接可无限触发全频道 presence 查询+广播）。
- **PRAGMA 就绪保证** —— SQLite WAL/busy_timeout 设置暴露为 promise，relay 启动监听前 await（首查不再与 PRAGMA 竞态）。

### 服务端性能

- 文件分块写入/完整性校验/目录大小统计全面异步化（`fs/promises` + 单次 readdir 替代逐块 statSync），4MiB 分块写盘不再阻塞事件循环。
- 清空频道不再把全频道密文拉进内存（select 仅取 fileId）；批量删除消息的权限校验由 N 次查询合并为 1 次 findMany。
- 新增索引：`ChatSession.pubId`、`ChatMessage.senderId`、`ChatReadReceipt.readerId`、`ChatMember.pubId`、`InviteToken.createdBy`（审计/历史路径告别全表扫描）。
- geo 内存缓存加上限（4096 条 FIFO 驱逐）；管理员路由收敛：TURN 凭证签发限流、drive init/chunk/complete 限流补齐。

### 客户端优化

- **重渲染治理** —— Composer/ChatScreen/MessageBubble/FileBubble/VoiceBubble 等由整店订阅改为细粒度 selector/useShallow；`MessageBubble` React.memo 化（此前任何上传进度/typing/presence 变化都会重渲染全部气泡）。
- **回复预览 O(n²) → O(n)** —— 每个气泡各自 `messages.find()` 改为 ChatScreen 统一构建 Map 传入。
- **发送竞态修复** —— 所有发送动作局部捕获 socket 引用（此前 await 加密期间 `leave()` 置空 socket 会 TypeError 崩溃）+ 15 秒 ack 超时（消息不再永远卡「发送中」）。
- **历史加载纪元守卫** —— join/leave 推进 epoch，慢响应不再把旧频道消息并入新频道（跨频道串台）。
- **本地消息上限** —— 内存中保留最近 2000 条（自动裁剪最旧），防长时间驻留内存无界增长。
- **删除回滚** —— deleteMessages/clearChannel 失败时恢复本地快照（此前两端视图不一致）。
- **头像解密缓存** —— 按 avatarEnc 密文缓存解密结果（上限 128），presence 事件不再触发全列表 O(n) 次 WebCrypto 解密。
- **成员面板并行解密** —— 昵称/设备/心情由串行 for-await 改为 Promise.all 并行；网盘列表元数据同步并行化。
- **图片懒解密** —— 自动预览阈值 15MB → 5MB，且滚入视口（IntersectionObserver）才下载解密；翻历史不再几十张图并行解密烫手。
- **按住说话修复** —— 录音中不再禁用按钮 + `setPointerCapture`（此前 Chrome 吞掉 pointerup 导致录音卡死到 60s 自动发送）。
- **杂项** —— 草稿保存 300ms 防抖；解密失败消息显示「🔒 无法解密」而非空白气泡；`maximumScale:1` 移除恢复捏合缩放（WCAG）；断点续传键修剪（≤20）；TTS voices 预热；保存好友 try/catch；语音暂停进度条显示修复；`timeAgo` 未来时间防护。
- **井字棋身份判定补丁** —— 棋子归属按 `challengerId`（对局发起者）判定而非当前消息发送者（双人走子后双方视角会算反棋子）。

### 工程

- 单元测试 50 → 106 个（新增 /poll 解析、井字棋校验/胜负判定、特效解析全量覆盖；邀请/轮换 mock 同步升级原子语义）。
- `tsc --noEmit` 严格模式零错误、ESLint 零错误零警告（项目源码范围）。

## v1.6.0

### 新增功能
- **表情回应（Reactions）** —— 悬浮消息点笑脸或右键菜单即可回应 👍❤️😂😮😢🙏，双击消息快速点赞；回应按 emoji 聚合计数、再点取消，服务端持久化（新增 `ChatReaction` 表，消息删除级联清理），历史消息与实时广播全链路支持；旁听角色禁止回应，限流 60 次/10 秒。
- **频道玩具箱（斜杠指令）** —— 结果在发送端随机生成、以普通加密消息广播，服务器依旧零知识：
  - `/roll [3d6]` 掷骰子（支持 NdM、修饰符如 2d20+1，骰子入场动画）；
  - `/coin`（别名 `/flip` `/硬币`）抛硬币；
  - `/rps [石头/剪刀/布]` 猜拳，带出招自动判胜负；
  - `/decide 火锅|烧烤|面条`（别名 `/choose`，支持 |/顿号/逗号/空格分隔）帮你做选择；
  - `/8ball <问题>` 神奇魔球答疑。输入 `/` 自动弹出指令提示，Tab 补全。
- **剧透遮罩** —— 消息中用 `||秘密||` 包裹的内容默认模糊，点击才揭示，未闭合标记按普通文本处理。
- **频道草稿箱** —— 未发送内容按频道自动保存到本地，刷新、切换频道后自动恢复。
- **未读标题提醒** —— 页面在后台时收到消息，浏览器标签标题显示 `(N) 密讯 · 频道`，回到页面自动清零。
- **引用跳转** —— 点击消息里的引用条平滑滚动到原消息并脉冲高亮。
- **屏幕安全模式** —— 头部菜单开启后，切后台/窗口失焦自动模糊消息区防偷窥，回前台或点击遮罩恢复（偏好本地持久化）。
- **快捷键** —— Ctrl/Cmd+F 聚焦频道内搜索，Esc 取消搜索/回复。

### 修复（真实运行时缺陷）
- 修复「正在输入…」指示器永不消失：过期清理误用当前用户自己的设备 ID，已改为闭包捕获发送者 ID。
- 修复取消密钥轮换（cancelRotation）调用未导入函数导致运行必崩的问题。
- 修复语音通话信令（voice:signal/lobby:signal/呼叫类事件）向整个房间广播的隐私问题，改为按 socketId 定向单播，对方离线时明确回错。
- 修复「全局自毁」漏清 8 张表（离线信件、成员关系、DMS、邀请令牌、设备身份、轮换记录、已读回执等会残留，免密邀请甚至可重建频道）。
- 修复离线设备 presence 无视 IP 披露档位直接下发完整 IP 的隐私泄漏。
- 修复管理后台功能开关 allowHiddenGeo / dmsEnabled 刷新后永远显示默认值。
- 修复文件下载缺块时静默跳过、拼出必然解密失败的坏流：下载前校验分块完整性，缺块返回 409 并带 Content-Length。
- 修复历史消息不返回 fileId/burnAt 导致语音消息刷新后缺元数据、倒计时丢失。

### 性能与工程
- 历史消息解密由串行 await 改为并行（首屏加载显著加快），并补齐 voice/burnAt/reactions 映射。
- 密钥轮换迁移 200 条消息各开一个事务、chat:read 逐条 upsert 的 N+1 合并为单事务（失败逐条降级兜底）。
- 热路径 roles 动态 import 改为顶层静态导入；relay 增加 SIGTERM/SIGINT 优雅退出。
- 移除 geo.ts 对 `Array.prototype.unique` 的全局污染与重复国家键。
- 清理 openMailboxEnvelope 双重 JSON.parse 死代码；修正 crypto 层 TypedArray 泛型与 BlobPart 类型。
- `next.config` 不再忽略 TS 错误；tsconfig 升级 target ES2022；**`tsc --noEmit` 零错误**，单元测试由 29 个增至 50 个（玩具解析、剧透解析全量覆盖）。

## v1.5.0

### 新增
- **成员级已读回执链** —— 「谁读了我发的消息」：悬浮/触屏点按消息的已读状态即可查看读者列表与时间；新增 `ChatReadReceipt` 表与 `chat:readers` 查询。
- **阅后即焚** —— 发送框 🔥 按钮可选消息保留时长（5分钟~24小时，默认永久）；到期服务端自动焚毁（含文件密文）并广播占位提示；新增 `burnAt` 字段 + 定时清理器。
- **频道角色体系** —— owner / admin / member / observer 四级权限：
  - 修复越权隐患：此前任何成员可清空频道、删除他人消息；
  - 现在清空仅限 owner、删他人消息需 admin+、observer 只读；
  - 邀请链接可指定角色；owner 可任命/罢免 admin。
- **P2P 离线信箱** —— 对方离线也能留言：X25519+AES-256-GCM 双信封加密，服务器零知识、取走即删；私钥永不出设备。
- **安全审计页（/security）** —— 用户侧透明化：活跃会话一览（一键吊销陌生设备）、我创建的邀请、频道角色、信箱身份状态。
- **Dead Man's Switch** —— 连续 N 天无活动自动「通知联系人」或「全局自毁」；开关默认对用户隐藏，需管理员后台开放。
- **实时变声面具** —— 语音大厅 AudioWorklet 实时 pitch shift（颗粒合成），全部本地处理，保护声音身份。
- **密钥轮换完成通知** —— 在线成员实时收到「密钥已更换」提示并获知需重新加入。

### PWA
- manifest + Service Worker：可安装到主屏幕；仅缓存静态外壳，API/WebSocket 一律直通不缓存（隐私优先）。

### 文件体验
- 断点续传：上传中断后重发同一文件自动跳过已完成分块；
- 大文件（>50MB）自动限速 2MB/s，防止占满家庭带宽。

## v1.4.3

### 新增
- 聊天频道连接方式选择（P2P/中继，加入前选定，同 ID 不同模式完全隔离），附模式差异说明与「成员必须同模式才可见」红字提醒；语音大厅补充同样提醒。
- IP 信息披露三档（完整/仅地区/不披露），hidden 由管理员后台 allowHiddenGeo 控制，服务端强制裁决。
- ChatJoin 扫码加入入口（Barcode Detection API + 图片识别兜底）。
- Dockerfile 多阶段构建 + 单容器入口脚本（web:3000 + relay:3003）。

### 修复
- cancelRotationRemote 未传 rotationId 导致「取消并回滚」永远 409 —— 服务端增加按频道回退查找兜底。

## v1.4.0

### 新增
- 独立消息回执（每条消息独立显示发送中/送达/已读，修复连发多条只有一个勾的 BUG）
- TTS 文本朗读 + 自动朗读开关
- 二维码/邀请链接（免密钥令牌：服务端主密钥 AES-GCM 二次加密；仅频道 ID 两种模式）+ 分享进入页
- 语音大厅文字副频道（端到端加密侧栏）
- 屏幕共享（getDisplayMedia → WebRTC 视频轨注入）
- 密钥轮换 4 阶段协议（start→migrate→files→finish）

### 安全加固
- 6 个 API 补齐频率限制；全站安全响应头（CSP/XFO/nosniff/HSTS）
- vitest 单元测试：加密核心（派生/seal/open/分块 AAD）与服务端轮换/邀请逻辑。
- 关键路径空 catch 补充 console.warn 日志；`.env.example` 配置模板。

## v1.3.0

### 新增
- 语音开黑大厅（Discord 风格 lobby）：VAD 自由讲话 / PTT 按键讲话（可自定义按键）/ 静音 / 8 人 mesh。
- 大厅传输双模式隔离：`relay` 与 `p2p` 相同 lobbyId 互不可见。
- WebRTC 连接质量徽章（P2P / 中继 / 连接中 / 失败），ICE gathering 超时提示。
- 管理员后台 TURN 中继配置（static 长期凭证 / time-limited HMAC 短期凭证），客户端动态注入 ICE 服务器。
- 私聊 1v1 音频通话（invite/accept/reject/end 信令 + DMCallModal）。
- 设备高精度信息采集（UA-CH 真实机型），加密后随 presence 广播。

## v1.0.0

### 初始版本
- 加密聊天频道：频道 ID + 密码 → 浏览器本地 PBKDF2(310k) 派生 AES-256-GCM 密钥；文字/贴纸/文件（分块加密上传，AAD 绑定 fileId:index）/语音条；回复、正在输入、已读回执、消息删除/清空。
- 在线设备一览（IP 归属地 / UA / 局域网标识）、昵称与头像（加密广播）。
- 隐私网盘：随机 ID + 个人密钥，创建需管理员超级密钥授权；5GB 单文件分块流式加解密。
- 自毁密钥：任何密码入口探测命中即全局销毁（库表+磁盘密文+吊销会话）并实时广播清屏（wipeEpoch 轮询）。
- 好友系统（好友码导入）、whisper 私聊、P2P DataChannel 文字模式。
- WebSocket 中继服务（Socket.IO，零知识转发）；管理员后台功能开关。
- SQLite (Prisma) 存储，仅存哈希与密文；WAL 模式多进程并发优化。

## v1.9.0-bridge（CipherZip 协同）

- 新增桌面客户端桥接模块 `src/lib/server/client-bridge.ts`
- 新增 API：
  - `POST /api/client/register`
  - `POST /api/client/heartbeat`
  - `POST /api/client/archive/announce`
  - `GET  /api/client/archive/lookup`
  - `POST /api/client/signal/offer|answer`
  - `GET  /api/client/signal/poll`
- 仅存储密文指纹与能力宣告，不接收密码/明文
