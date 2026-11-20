// Agent 作用域内的闸门工具。自主浏览通过 xinyu_share 推荐给配置的大号。
// 原生 MCP 写工具（post_comment 等 6 个）已在 agent 作用域被 restrict/guard 屏蔽——
// 这是 agent 唯一的写作通道，所有调用都会：
//   1) 过 guard.ts 判定（模式/开关/配额/频控/静默/去重/屏蔽词）
//   2) queue（dry_run 或需审批）→ 入待审队列，工具结果如实告知 agent
//   3) post（auto 且无需审批）→ 直连 MCP 发送并回填 rpid
// 工具带 reason 参数，进审计日志。

import type { ActionKind } from './settings.js'

export interface SubmitOutcome {
  channel: 'post' | 'queue'
  code: string
  message: string
  pendingId?: string
  rpid?: number
}

export interface SubmitArgs {
  bvid: string
  message?: string
  mentions?: Array<{ mid: number; name: string }>
  parent?: number
  root?: number
  multiply?: number
  reason: string
}

/** 由 index.ts 装配注入：guard 判定 + 队列/发送 + 状态回填。 */
export interface XinyuSubmitter {
  submit(kind: ActionKind, args: SubmitArgs): Promise<SubmitOutcome>
  note(bvid: string, text: string): void
}

interface ToolSpec {
  name: string
  title: string
  description: string
  buildParameters(): Record<string, unknown>
}

const SHARE: ToolSpec = {
  name: 'xinyu_share',
  title: 'Share to Owner',
  description: '在该视频评论区真实 @ 设置中的大号并附上推荐理由。由插件填写提及目标，同一视频只分享一次。',
  buildParameters: () => ({
    type: 'object',
    properties: {
      bvid: { type: 'string', description: '推荐视频的 BV 号' },
      reason: { type: 'string', description: '写给大号的一两句话，说明这个视频哪里好玩、为什么值得看' },
    },
    required: ['bvid', 'reason'],
    additionalProperties: false,
  }),
}

const SPECS: ToolSpec[] = [
  {
    name: 'xinyu_post_comment',
    title: 'PostComment',
    description: '以小号身份在视频评论区发表评论或回复（真实公开操作）。闸门会检查配额/频控/审批要求：结果为 queued 表示已进入待审队列（尚未公开），posted 表示已发布。发新评论只需 bvid+message；回复对方评论传 parent=对方rpid（楼中楼再传 root=根rpid）；mentions 用 mid+name 把正文里的 @昵称 变成真实提及。reason 必填（一句话理由，进入审计日志，用户不可见）。',
    buildParameters: () => ({
      type: 'object',
      properties: {
        bvid: { type: 'string', description: '视频 BV 号' },
        message: { type: 'string', description: '评论正文，最多 1000 字符' },
        mentions: {
          type: 'array', description: '需要真实 @ 的用户；正文里必须同时写 @昵称',
          items: { type: 'object', properties: { mid: { type: 'integer' }, name: { type: 'string' } }, required: ['mid', 'name'], additionalProperties: false },
        },
        parent: { type: 'integer', description: '回复目标评论的 rpid' },
        root: { type: 'integer', description: '楼中楼根评论 rpid；必须与 parent 同时传' },
        reason: { type: 'string', description: '一句话理由（审计用）' },
      },
      required: ['bvid', 'message', 'reason'],
      additionalProperties: false,
    }),
  },
  {
    name: 'xinyu_like',
    title: 'Like',
    description: '给视频点赞（真实账号操作）。闸门检查开关与每日配额。',
    buildParameters: () => ({
      type: 'object',
      properties: { bvid: { type: 'string' }, reason: { type: 'string', description: '一句话理由（审计用）' } },
      required: ['bvid', 'reason'],
      additionalProperties: false,
    }),
  },
  {
    name: 'xinyu_coin',
    title: 'Coin',
    description: '给视频投币（消耗账号真实硬币）。默认在设置中停用；需要审批。',
    buildParameters: () => ({
      type: 'object',
      properties: { bvid: { type: 'string' }, multiply: { type: 'integer', enum: [1, 2], description: '投 1 或 2 枚，默认 1' }, reason: { type: 'string', description: '一句话理由（审计用）' } },
      required: ['bvid', 'reason'],
      additionalProperties: false,
    }),
  },
  {
    name: 'xinyu_note',
    title: 'Note',
    description: '记录一条运营笔记（只写审计日志，不产生任何 B 站动作）。用于说明浏览结论、跳过原因等。',
    buildParameters: () => ({
      type: 'object',
      properties: { bvid: { type: 'string', description: '相关视频，可空' }, note: { type: 'string', description: '笔记内容' } },
      required: ['note'],
      additionalProperties: false,
    }),
  },
]

function fail(message: string): never {
  const error = new Error(message) as Error & { code?: string }
  error.code = 'xinyu_args'
  throw error
}

function sanitizeMessage(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) fail('message 不能为空')
  if (raw.length > 1000) fail('message 超过 1000 字符')
  return raw.trim()
}

function sanitizeBvid(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9]{6,20}$/.test(raw.trim())) fail('bvid 格式不正确')
  return raw.trim()
}

function sanitizeReason(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) fail('reason 不能为空')
  return raw.trim().slice(0, 500)
}

function sanitizeMentions(raw: unknown): Array<{ mid: number; name: string }> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || raw.length > 5) fail('mentions 最多 5 个')
  return raw.map((entry: any) => {
    const mid = Math.round(Number(entry?.mid))
    if (!Number.isFinite(mid) || mid <= 0) fail('mentions[].mid 必须是正整数')
    if (typeof entry?.name !== 'string' || !entry.name.trim()) fail('mentions[].name 必填')
    return { mid, name: entry.name.trim().slice(0, 80) }
  })
}

/** post_comment 的动作分类：楼中楼回复=reply；带 mentions=share（@大号）；否则=author。可由装配层覆盖。 */
export function defaultClassifyComment(args: SubmitArgs): ActionKind {
  if ((args.parent ?? 0) > 0 || (args.root ?? 0) > 0) return 'reply'
  if (args.mentions && args.mentions.length > 0) return 'share'
  return 'author'
}

function renderOutcome(outcome: SubmitOutcome) {
  return {
    result: JSON.stringify({
      status: outcome.channel === 'post' ? 'posted' : 'queued',
      code: outcome.code,
      message: outcome.message,
      pendingId: outcome.pendingId,
      rpid: outcome.rpid,
    }),
  }
}

function agentTool(spec: ToolSpec, expectedAgent: unknown, run: (args: any) => Promise<{ result: string }>) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.buildParameters(),
    output: {
      schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value?.result ?? '') }],
    },
    async execute(args: any, exec: any) {
      if (exec?.agent !== expectedAgent) fail('工具调用身份不符')
      exec?.signal?.throwIfAborted()
      if (!args || typeof args !== 'object' || Array.isArray(args)) fail('参数必须是对象')
      return run(args)
    },
  }
}

export function xinyuBrowseTools(submitter: XinyuSubmitter, expectedAgent: unknown) {
  return [agentTool(SHARE, expectedAgent, async (args) => {
    const reason = sanitizeReason(args.reason)
    return renderOutcome(await submitter.submit('share', { bvid: sanitizeBvid(args.bvid), message: reason, reason }))
  })]
}

/** 兼容原有调用方。后台任务各自注册本轮所需的工具。 */
export function xinyuTools(submitter: XinyuSubmitter, expectedAgent: unknown, classify: (args: SubmitArgs) => ActionKind = defaultClassifyComment) {
  return SPECS.map((spec) => agentTool(spec, expectedAgent, async (args) => {
    if (spec.name === 'xinyu_note') {
      const note = sanitizeReason(args.note)
      submitter.note(typeof args.bvid === 'string' ? args.bvid.trim().slice(0, 40) : '', note)
      return { result: '已记录（仅审计日志，无公开动作）' }
    }

    const bvid = sanitizeBvid(args.bvid)
    const reason = sanitizeReason(args.reason)
    if (spec.name === 'xinyu_post_comment') {
      const submitArgs: SubmitArgs = {
        bvid,
        message: sanitizeMessage(args.message),
        mentions: sanitizeMentions(args.mentions),
        parent: args.parent === undefined || args.parent === null ? undefined : Math.round(Number(args.parent)),
        root: args.root === undefined || args.root === null ? undefined : Math.round(Number(args.root)),
        reason,
      }
      const outcome = await submitter.submit(classify(submitArgs), submitArgs)
      return renderOutcome(outcome)
    }
    if (spec.name === 'xinyu_like') {
      const outcome = await submitter.submit('like', { bvid, reason })
      return renderOutcome(outcome)
    }
    if (spec.name === 'xinyu_coin') {
      const multiply = args.multiply === undefined || args.multiply === null ? 1 : Math.round(Number(args.multiply))
      const outcome = await submitter.submit('coin', { bvid, multiply, reason })
      return renderOutcome(outcome)
    }
    fail(`未知工具 ${spec.name}`)
  }))
}
