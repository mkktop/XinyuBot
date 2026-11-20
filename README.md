<div align="center">

<img src="docs/logo.svg" width="110" alt="新雨机器人" />

# 新雨机器人 · XinyuBot

**跑在 DeepSeek Harness 上的 B 站自主运营小号** —— 自己刷 B 站、发现好内容、在评论区 @ 大号推荐；任何人 @ 小号提问，它都会到楼下认真作答。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg)](https://nodejs.org/)
[![零运行时依赖](https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-0-orange.svg)](#快速开始)
[![测试](https://img.shields.io/badge/tests-node:test%20%2B%20smoke-9cf.svg)](#测试)

</div>

---

## 这是什么

新雨是一个 B 站小号，但不是爬虫，也不是定时发布器：它以 Agent 会话的方式**自主决定**看什么、搜什么、怎么查证，遇到值得推荐的视频就去评论区 **@大号** 说明亮点；**任何人**在视频评论区 **@小号**，它会阅读原视频（字幕、官方摘要、简介）后在对应评论楼下回答或介绍。

它默认活在 **审批制**（`dry_run`）下：所有公开发言先经过三层写闸门判定，进入待审队列或按配额自动发布，每一条（包括被拒绝的）都落审计日志。

> 核心实现为 dsh 插件 [`dsh-xinyu-bilibili`](plugins/xinyu-bilibili/README.md)（v0.1.16，约 4200 行 TypeScript），本仓库即其主仓库。

## 特性

- 🔍 **自主浏览**（默认每 120 分钟）：Agent 自选入口、搜索词与查证方法，推荐按 BV 号去重
- 💬 **提及回复**：收 `@` 与回复两类通知，去重合并；每条回复独立 Agent 会话，可查阅字幕/摘要/简介；支持并发处理
- 🚦 **三层写闸门**：作用域屏蔽 → 闸门工具 → 统一判定，公开互动只出不走样
- 🎛️ **精细节奏控制**：运行模式、动作级开关、每日配额、单视频/单线程上限、发言最小间隔、跨午夜静默时段、屏蔽词
- 🖥️ **Web 管理面板**：dsh 左侧栏内完成状态查看、审批、设置热编辑、活动日志、手动触发与诊断
- 📜 **全程审计**：每条公开发言（含拒绝与待审）进 `activity.jsonl`，配额按自然日滚动
- 🧯 **失败安全**：状态文件原子写（0600）；损坏时**拒绝启动**而非静默重置——发言状态丢失可能导致超发
- 📦 **零运行时依赖**：仅构建期使用 esbuild，产出宿主（Node ESM）与网页（dsh client 模块）双产物

## 工作原理

```
                        dsh web profile
┌───────────────────────────────────────────────────────────────┐
│   网页面板 lib/client.js            管理路由 (owner-only)      │
│   状态 · 审批 · 设置 · 日志          /api/xinyu/manage         │
└──────────────┬─────────────────────────────▲──────────────────┘
               │ 注入                         │ Fetch
┌──────────────▼─────────────────────────────┴──────────────────┐
│                     宿主半边 lib/index.js                       │
│                                                               │
│   Scheduler ──► JobBridge ──► dsh agents/sessions             │
│   (browse /        │           xinyu-operator preset 会话      │
│    mention job)    │                                          │
│                    ▼                                          │
│   XinyuCore：scan / notifications / guard / services / store  │
│   （收件去重 · 三层闸门 · 串行发布 · 审计落盘）                  │
└──────────────────────────┬────────────────────────────────────┘
                           │ streamable-http（Bearer，环境变量注入）
┌──────────────────────────▼────────────────────────────────────┐
│          未雨 MCP（127.0.0.1:8787）—— B 站搜索/评论/通知        │
└──────────────────────────┬────────────────────────────────────┘
                           ▼
                         哔哩哔哩
```

**两个定时任务**

| 任务 | 行为 |
| --- | --- |
| browse job | Agent 会话自主浏览，产出候选 → 走 `xinyu_share` 闸门工具提交推荐 |
| mention job | 收件（`@` + 回复源合并去重）→ 每条提及起独立会话 → 起草正文 → 插件核对目标并提交 |

**公开发言的唯一通道**

```
Agent 产出 ─► ① 作用域屏蔽 tools.restrict / tools.guard（6 个原生写工具不可见）
          ─► ② 闸门工具 xinyu_share / 回复草稿（插件核对评论目标）
          ─► ③ evaluateGuard 判定：总开关 → 动作开关 → 静默时段 → 每日配额
              → 单视频/单线程上限 → 发言间隔 → 屏蔽词
          ─► post（自动）/ queue（待审）/ reject
          ─► 串行发布路径 ─► activity.jsonl 审计
```

自动发布与人工批准**共用**同一条串行发布路径，不存在旁路。

## 仓库结构

```
XinyuBot/
└── plugins/xinyu-bilibili/     # 核心插件（本仓库唯一包）
    ├── src/                    # 宿主半边：调度、闸门、收件、存储、管理路由
    │   └── client/             # 网页半边：dsh 侧栏设置面板（React）
    ├── lib/                    # 构建产物（git 忽略，npm run build 生成）
    ├── tools/                  # node:test 单测 + mock MCP 冒烟脚本
    ├── cordis.patch.yml        # dsh bundle 挂载声明（preset 会话 + MCP）
    └── README.md               # 📖 详细文档：安装 / 全参数表 / 管理接口 / 会话模式
```

## 快速开始

本地开发与测试（无需 dsh 宿主，MCP 以 mock 驱动）：

```bash
git clone https://github.com/mkktop/XinyuBot.git
cd XinyuBot/plugins/xinyu-bilibili
npm install
npm test        # 构建 → node:test 单测 → mock MCP 冒烟
```

## 部署

面向 dsh（DeepSeek Harness）web profile，依赖同机部署的未雨 MCP（0.4.0+，评论写入已开启）。令牌经 systemd drop-in 环境变量注入，不落仓库。

```bash
dsh plugin --profile web add "link:/opt/xinyu-bot/plugins/xinyu-bilibili"
sudo systemctl restart gm800-dsh
```

安装后打开 dsh 左侧栏「新雨机器人」完成初始配置。**默认 `dry_run` 审批制——先在面板里看几轮待审内容，再考虑放开自动发布。** 完整步骤、参数表与故障排查见 [插件文档](plugins/xinyu-bilibili/README.md)。

## 安全模型

- **默认最小权限**：preset 会话仅有 time + MCP + compaction，无 bash/文件/网络/调度能力；公开发言只能经插件闸门
- **自动 ≠ 失控**：`auto` 模式仍受动作开关、配额、间隔、静默时段、屏蔽词多层约束；每个动作可单独要求审批
- **宁可停机**：设置/状态文件损坏时插件拒绝启动，杜绝"状态丢失 → 超发"；
- **可追溯**：`activity.jsonl` 记录每条公开发言的前因后果（含被闸门拒绝的）

## 测试

单测（node:test）覆盖：通知增量与翻页、跨通知源去重、裸 @ 的内容介绍、带问题的回复、会话隔离、回复并发、楼中楼定位、审批流与并发分享；冒烟脚本以 mock 未雨 MCP 走通完整链路。闸门与调度器为纯逻辑模块（无 IO、可注入假时钟），判定路径可穷举测试。

## 路线图

- [ ] 动态、专栏等通知类型的回复（等待 MCP 侧评论写入能力）
- [ ] 消息中心收件成为主路径（现为兼容路径 + 评论区扫描降级）
- [ ] 浏览任务多入口并行

## License

[MIT](LICENSE) © 2026 mkktop

> 本项目与哔哩哔哩无关联；使用时请遵守 B 站社区规范，对小号的发言行为保持监督（这正是审批制与审计日志存在的意义）。
