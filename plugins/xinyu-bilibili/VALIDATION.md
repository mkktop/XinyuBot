# VALIDATION — dsh-xinyu-bilibili

每次部署的验证记录。格式参照 yusheng：明确区分「本地验证 / 真机验证 / 未验证」。

## v0.1.15（2026-11-20，当前部署版本）

- 每条原评论独立启用 Agent 会话，重试与压缩按原评论恢复。裸 @ 结合可读资料介绍视频内容。回复并发数默认 2，可在调度设置中配置 1–10。
- 本地通过 43 项单测、12 项冒烟检查和服务端 TypeScript 严格检查。
- GM800 加载新版，生产收件连续通过。设备隔离验证用同一真实视频创建两条模拟提及，两个会话的执行时间重叠，记录分别持久化。纯 @ 查阅官方摘要与字幕后生成视频介绍，另一会话回答原问题，两条回复各自进入测试待审队列。管理接口成功保存并读回并发设置。
- 升级备份位于 GM800 的 `/opt/xinyu-bot/backups/before-0.1.15.2Vjimd/xinyu-bilibili`。

## v0.1.14（2026-11-20）

- 问题回复明确正文长度上限，超长草稿自动压缩一次。改写后仍超长时在发布上限内尽量保留完整句子。
- 本地通过 42 项单测、12 项冒烟检查和服务端 TypeScript 严格检查。
- GM800 加载 0.1.14，自动回评和每 60 秒加 0～15 秒随机抖动的收件已启用。B 站原评论下查到补发的小号回评，新闻摘要包含 15 条，待回复队列已清空。
- 升级备份位于 GM800 的 `/opt/xinyu-bot/backups/before-0.1.14.Ae0aAg/xinyu-bilibili`。

## v0.1.13（2026-11-20）

- 兼容未雨 MCP 0.4.1 的 `source_id`、`target_id` 和 `source_content` 字段，保留旧版通知兼容。
- 本地通过 42 项单测、11 项冒烟检查和服务端 TypeScript 严格检查。
- 在 GM800 通过未雨 MCP 定位两条实际漏收的通知，只将对应的两条原评论补入队列。B 站原评论下查到裸 @ 的视频信息回评。带问题的草稿超长，在 0.1.14 补回。
- 升级备份位于 GM800 的 `/opt/xinyu-bot/backups/before-0.1.13.Mdfg97/xinyu-bilibili`。

## v0.1.12（2026-11-20）

- 收件支持 1 分钟间隔和独立的秒级随机抖动。回复起草期间继续收件。收件和浏览各保留最近 30 次任务记录，用于重启后的排期。
- 本地通过 41 项单测、11 项冒烟检查、服务端 TypeScript 严格检查和并行收件联调。
- GM800 已设置每 60 秒加 0～15 秒随机抖动。真机连续两轮自动通过消息中心收件，启动间隔 67.035 秒。
- 升级备份位于 GM800 的 `/opt/xinyu-bot/backups/before-0.1.12.v1Ynuy/xinyu-bilibili`。

## v0.1.11（2026-11-20）

- 接入未雨 MCP 0.4.0 消息中心。裸 @ 回复视频资料，有正文的评论由 Agent 起草，插件定位并回复原评论。自主浏览使用专用分享工具 @ 设置中的大号。
- 本地通过 38 项单测、11 项冒烟检查、宿主联调和服务端 TypeScript 严格检查。
- 通过 MeatShell MCP 的已保存会话部署至 GM800。服务端和客户端构建产物与本地 SHA-256 一致，前缀分别为 `3f6f19a4` 和 `6ae046dd`。
- GM800 管理接口确认加载 0.1.11，自动分享和自动回复已启用。小号登录及评论写入探活通过。手动收件和提及任务均成功，两路通知水位已落盘。本轮新增 0 条，真实评论发布待下一条提及验证。
- 升级备份保存在 GM800 的 `/opt/xinyu-bot/backups/before-0.1.11.qwzRLa/xinyu-bilibili`。

## v0.1.10（2026-11-19）

**变更**：修复「归档任务会话后 job 静默空转」。用户在 dsh 界面归档 `xinyu-browse` 后，宿主 `archived-session-gate`（dsh-api-session-controller）在 `agent/pre-step` 拒绝归档会话的一切模型步——followup 不报错、turn 空文本秒完成，job 状态仍是 `ok`，表现为「归档旧会话后无法触发新会话」（当日 09:32:38 / 09:33:09 / 09:33:33 三次 0.3–0.6s 空转实锤）。

bridge.ts 双层修复：
1. `workspaceRegistry.archivedSessionIds` 归档检测（懒解析）：缓存命中前、候选 resume 前先查归档集；归档会话按「已存在」处理不复用，让 create 派生新 id。
2. **死回合兜底**（必需——真机实测 `root.get('workspaceRegistry')` 从插件作用域解析不到）：turn 零输出秒回（<60s）即判死会话，forget + exclude 该 id，自动开新会话重试一次（v0.1.9 只有第 1 层，真机仍空转）。

**验证**：38 项单测 + smoke 全绿；真机 sha256 `4ec67a28`；面板手动触发 browse——首撞归档会话空转 → 死回合检测 → 自动开 `xinyu-browse-r06b3e9f3` → **真实运行 76s** 并产出完整 JSON 摘要（推荐「12个大模型文明推演」share+like、ESP32 DIY 教程 author 评论，草稿入待审队列）✓。

## v0.1.9（2026-11-19，被 v0.1.10 取代）

只含 archive 检测第 1 层。真机部署（sha `db854e05`）后手动触发 browse 仍 1.6s 空转——`workspaceRegistry` 无法从插件作用域 get 到，检测形同虚设。教训：宿主服务可达性必须真机验证，不能只看控制器内部用法。

## v0.1.6（2026-11-19）

**变更**：
1. 部署运营者重构的设置面板（panel.tsx 380→672 行：组件拆分 SettingsPanel/Overview、useId 标签关联、列表草稿编辑、审批 decide 函数、dirty state 防轮询覆盖）。
2. 修复 mention「小号身份未知」循环报错：`scanMentionsNow` 在身份缺失时自动补一次登录探活，不再依赖 `safety.cookieProbe` 开关（运营者已将该开关关闭，重启后内存身份丢失导致 mention 连续报错 4 轮）。

**验证**：38 项单测 + smoke 全绿；真机重启后 mention job 09:07(UTC) `ok`「扫描完成：无新提及」✓；浏览器确认重构面板正常渲染（标题层级/账号与连接区/任务历史含旧错误审计）。

**运营实绩（2026-11-19）**：大号已配置（脉冲疯子 / mid 6292338897）；配额调至 share/author 20/天；当日已批准发布 18 条（share×5 全部真实 @ 到大号、author×3、like×9、失败×1），rpid 均已回填；发布间隔/单视频限制全程无超发。

## v0.1.4（2026-11-18）

**变更**：面板修复两 bug——(1) 输入被 8 秒轮询覆盖（加 dirty 标记，有未保存修改时轮询不覆盖表单）；(2) 面板无法滚动（dsh main slot 是固定高度 overflow hidden，面板根补 `height:100%; overflow-y:auto`）。
**验证**：本地构建部署后浏览器实测 `.xy-root` overflowY=auto、scrollHeight 1824 > clientHeight 720 可滚动 ✓；mid 输入框跨轮询保持值。

## v0.1.3（2026-11-18）

**变更**：产品显示名由「心语B站运营」更正为「**新雨机器人**」（运营者确认的正确名称，Xinyu=新雨）；影响 locale 标题、侧边栏入口 label、agent preset 名称、任务提示词中的人格称呼（你是「新雨」）。preset id 仍为 `xinyu-operator`（会话绑定不受影响）。
**验证**：38 项单测 + smoke 全绿；部署重启后浏览器确认侧边栏与面板以「新雨机器人」显示。

## v0.1.2（2026-11-18）

**产物**：`/opt/xinyu-bot/plugins/xinyu-bilibili/lib/index.js` sha256 前缀 `c0a98e2f`（本机打包 `/tmp/xinyu-bilibili-0.1.2.tgz`，98,960 字节）
**安装方式**：`dsh plugin --profile web add "link:/opt/xinyu-bot/plugins/xinyu-bilibili"` + `systemctl restart gm800-dsh`
**回滚**：`dsh plugin --profile web remove dsh-xinyu-bilibili` + 重启；profile patch 备份在 `/opt/yusheng-backups/cordis.patch.yml.before-xinyu-*`

### 本地验证（Windows 11 / Node 24）

| 项 | 结果 |
| --- | --- |
| `npm test`（构建 + 38 项 node:test 单测：settings/guard/store/scan） | ✅ 全绿 |
| `tools/smoke.mjs`（真实 HTTP mock MCP 全链路：探活→扫描检出→auto 直发回复→dry_run 入队→审批直发→间隔/屏蔽词/mode=off 拒绝→xinyu 工具身份校验） | ✅ 9/9 |
| `apply(root, null)` 桩宿主测试（config=null 不抛；设置文件创建；scheduler 启动） | ✅ |

### 真机验证（GM800 192.168.10.97，dsh 0.2.1-rc.2，2026-11-18）

| 项 | 结果 |
| --- | --- |
| 插件加载无报错（journal 无 xinyu 错误行；`~/.dsh/xinyu-bilibili/settings.json` + `state.json` 创建，0600） | ✅ |
| mention job 定时触发（boot+75s，trigger=schedule）→ cookie 探活通过 → 扫描完成（无新提及）→ 状态 ok | ✅ 审计：`state.json` lastJobs |
| browse job 定时触发（boot+5min）→ 会话 `xinyu-browse` 创建 → AI 刷 B 站审 4 候选 → 3 条草稿入待审队列（1 author 评论 + 2 like）→ 全程零公开发言 | ✅ dry_run 生效 |
| 品味判断抽查 | ✅ 推荐「自制幼年体DS」「EUV 光刻机科普」；跳过转载无互动稿、识别出疑似搬运号（同简介重复投稿） |
| 闸门正确拦截 | ✅ share 因「大号未配置」未执行（owner 尚未配置，符合预期） |
| share 未做真实 @ 通知测试 | ⏸ 待用户配置大号 mid/昵称后验证 |
| 审批发布真实公开测试 | ⏸ 待用户在面板批准 1 条（建议先批一条 like 观察再批评论） |
| mention 回应真实公开测试 | ⏸ 待用户用另一账号在任一视频下发一条 @bilblicopy 评论，触发 mention job 验证 |
| Web 面板（浏览器实测，进程入口 token URL） | ✅ 侧边栏「新雨机器人」入口出现（order 5）；状态页配额/调度/任务历史/健康探活全部正确渲染；待审批页 3 条草稿 + 批准/拒绝/打开视频按钮齐全；owner-only fetch 通信正常 |
| 管理路由安全 | ✅ 未认证 POST `/api/xinyu/manage` 挂起不泄露数据（dsh exact-fetch 行为，仅浏览器 owner 会话可达） |

### 已知事项

1. **调试临时值**：`settings.json` 的 `browseIntervalMin` 曾临时改为 15（已改回 120，**下次重启生效**）。
2. **author 评论里的 @ 作者**是纯文本 @（未走 mentions 参数，不产生真实通知）。是否要真实提及作者待运营者定夺；如需真实提及可让 agent 在 author 评论时带 `mentions`（需作者 mid，来自 parse_video）。
3. v0.1.0/v0.1.1 的两次 browse error（`session header cwd must be an absolute path`）已由 v0.1.2 修复（`resolveCwd` 严格校验 `/` 开头 + 回退 `process.cwd()`）；旧错误记录保留在 lastJobs 作为审计痕迹。
4. 服务在 16:37/16:51（安装前）就有重启记录，均为 systemd 优雅重启，非本插件导致；插件运行期间无崩溃。

### 历史版本

- **v0.1.0**（17:13 部署）：`apply(root, config)` 收到 null config 抛 `Object.keys(null)` TypeError → 插件加载失败。v0.1.1 修复。
- **v0.1.1**（17:30 部署）：加载成功、mention job 正常；browse 失败于 `resolveCwd` 未 await `fs.resolve` → cwd 无效。v0.1.2 修复。
