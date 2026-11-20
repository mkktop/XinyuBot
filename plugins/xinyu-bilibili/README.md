# dsh-xinyu-bilibili —— 新雨机器人

DeepSeek Harness（dsh）的 B 站小号插件。新雨自主浏览和推荐内容，遇到值得看的视频就在评论区 **@大号** 并说明亮点。任意用户在视频评论区 **@小号** 后，新雨会在对应评论下介绍视频或回答问题。

## 能力一览

- **browse job**（默认每 120 分钟，可配）：Agent 自选入口、搜索词和查证方法，发现值得推荐的视频就调用 `xinyu_share`。插件绑定设置中的大号，并按 BV 号去重。
- **mention job**（收件间隔最低 1 分钟，抖动以秒配置）：通过未雨 MCP 的 `get_at_feed` 和 `get_reply_feed` 收件，合并同一条评论的重复通知。每条回复有独立 Agent 会话。裸 @ 介绍视频讲了什么，有正文时回答提问或回应评论内容。Agent 可查阅字幕、官方摘要和简介。回复并发数可在「设置 → 调度」修改，生成期间照常收件。插件使用原评论的 rpid 和楼中楼的根评论 ID 发布。
- **Web 设置面板**（dsh 左侧栏「新雨机器人」）：状态卡、待审批列表（批准/拒绝）、全部设置表单、活动日志、手动触发与诊断。
- **审计**：每条公开发言（含拒绝与待审）都进 `activity.jsonl`；配额按自然日滚动。

## 三层写闸门

1. agent 作用域 `tools.restrict` 屏蔽 6 个原生 MCP 写工具 + `tools.guard` 名称模式兜底；
2. 浏览 Agent 用 `xinyu_share` 提交推荐。回复 Agent 只起草正文，插件核对评论目标并提交；
3. 自动发布与人工批准共用串行发布路径。

公开发言受运行模式、动作开关、静默时段、每日配额、发言间隔和屏蔽词设置管控。真实 @ 按原评论去重，同一楼中楼里不同人的 @ 可以各获一次回复。暂时无法发布的回复留在队列里。

## 安装（GM800）

```bash
# 依赖：dsh web profile，未雨 MCP 0.4.0+（127.0.0.1:8787，评论写入已开）
# systemd drop-in 环境变量 WEIYU_MCP_TOKEN（已有，yusheng 语音在用）
dsh plugin --profile web add "link:/opt/xinyu-bot/plugins/xinyu-bilibili"
sudo systemctl restart gm800-dsh
```

安装后在 dsh 左侧栏打开「新雨机器人」。自动回复使用 `auto` 模式，启用「回复提及」并取消该动作的「需要审批」，开启「定时收件并回复」。如需自动分享，填写大号 MID 和昵称，启用「@大号分享」并取消该动作的审批。可在「维护」里点「仅收件」同步消息，或点「收件并回复」立即处理。

首次同步会建立通知水位。插件启动前的历史通知作为基线，之后的新增通知进入回复队列。

## 设置（全参数，面板热编辑）

持久化 `$DSH_HOME/xinyu-bilibili/settings.json`（0600）。group / 字段 / 默认值：

| 组 | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| general | mode | `dry_run` | `off` 全停 / `dry_run` 审批制 / `auto` 全自动 |
| actions.share | enabled/approval | true/true | @大号+总结 |
| actions.author | enabled/approval | true/true | 给作者评论 |
| actions.reply | enabled/approval | true/false | 回复@提及 |
| actions.like | enabled/approval | true/false | 点赞 |
| actions.coin | enabled/approval | false/true | 投币（默认关） |
| quotas | sharePerDay / authorPerDay / replyPerDay / likePerDay / coinPerDay | 2/2/8/10/0 | 每日配额 |
| quotas | maxCommentsPerVideo / maxRepliesPerThread / minPostIntervalMin | 1/2/20 | 单视频一级评论、普通回复的单线程上限、发言最小间隔（分钟） |
| schedule | browseEnabled / browseIntervalMin | true/120 | 刷B站任务 |
| schedule | mentionEnabled / mentionIntervalMin / mentionJitterSec | true/30/15 | 定时收件开关、间隔（分钟）和最大随机抖动（秒） |
| schedule | mentionConcurrency | 2 | 同时处理的提及回复数量，范围 1–10 |
| schedule | jitterMin | 10 | 浏览任务的最大随机抖动（分钟） |
| schedule | quietFrom / quietTo | 01:00/08:00 | 发言静默时段（跨午夜 from>to） |
| content | keywords | AI、大模型、编程、嵌入式、开源硬件、效率工具 | 可供延伸的兴趣线索 |
| content | sources | recommend/dynamicFeed/ranking/weekly 开、hotSearch 关 | 浏览源开关 |
| content | interestBrief | "" | 自然语言兴趣说明 |
| persona | tone / commentStyle / replyStyle / extraNotes | （见默认） | 人设与文风，原样进提示词 |
| accounts | owner.mid/name | 0/"" | **大号（share 必须）** |
| accounts | bot.mid/name | 0/"" | 小号，0=探活自动检测 |
| safety | blockedWords / cookieProbe | []/true | 屏蔽词（命中拒绝）/每轮探活 |
| mcp | url / token / timeoutMs | 127.0.0.1:8787/mcp / ""(读 env WEIYU_MCP_TOKEN) / 60000 | 未雨 MCP 连接 |
| llm | provider / model / reasoningEffort | ""（宿主默认） | 覆盖 job 会话模型 |

## 管理接口（owner-only，复用 dsh 登录态）

单路由 `POST /api/xinyu/manage`，envelope `{path, method, body}`：

- `GET /status`、`GET /settings`（token 脱敏）、`PUT /settings`
- `GET /pending`、`POST /pending/{id}/approve|reject`
- `GET /activity`（tail）、`POST /jobs/browse|mention`、`POST /scan`
- `POST /sessions/browse/reset`、`POST /diagnostics/login`

## 数据目录

`$DSH_HOME/xinyu-bilibili/`：`settings.json`（0600）、`state.json`（配额/我方评论/水位/任务记录）、`pending.json`（待审队列）、`activity.jsonl`（审计）。原子写，损坏拒绝加载（不静默重置——发言状态丢失可能超发）。

## 会话模式

preset `xinyu-operator`（最小权限：time + mcp-weiyu + compaction；无 bash/fs/web/schedule/skills）。浏览任务复用 `xinyu-browse`。提及任务按原评论创建 `xinyu-mention-<rpid>`，同一条评论的重试和压缩沿用该会话。每轮完成后释放运行实例，保留 dsh 会话记录。权限预设 `danger-full-access` 用于无人值守执行，公开发言由插件统一发布。

## 本地开发

```bash
npm install && npm test   # 构建、单测及 mock MCP 冒烟测试
```

测试覆盖通知增量与翻页、跨通知源去重、裸 @ 的视频内容介绍、带问题的回复、会话隔离、回复并发、楼中楼定位、审批和并发分享。

## 边界与已知限制

- 公开回复覆盖视频评论和楼中楼。动态、专栏等其他类型的通知会记录在活动日志里，等待对应的 MCP 评论写入能力。
- 使用缺少 `get_at_feed` 的旧版未雨 MCP 时，插件从小号参与过的视频评论区收件。消息中心路径能收取其他视频的真实 @ 通知。
