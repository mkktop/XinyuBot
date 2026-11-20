// 写闸门（纯逻辑，无 IO，可用假时钟测试）：
// 所有公开发言/互动在真正发出前必须通过这里。判定顺序即优先级：
//   总开关 → 动作开关 → 静默时段 → 每日配额 → 单视频/单线程限制 →
//   发言间隔 → 屏蔽词 → share 依赖大号配置
// 最终产出通道：post（auto 且无需审批，直接发）/ queue（入待审队列）/ reject。
// 真正的发送在 index.ts 的服务装配层完成；本模块只做判定。

import type { ActionKind, XinyuSettings } from './settings.js'

export interface GuardStateView {
  /** 今天（本地日）已用量，kind → count */
  usedToday: Record<ActionKind, number>
  /** 我方已在哪些视频发过一级评论（bvid → 次数） */
  commentsByVideo: Record<string, number>
  /** 我方在某线程（root rpid 或自身一级 rpid）已回复次数 */
  repliesByThread: Record<string, number>
  /** 上一次公开发言时间（ISO）；null = 从未 */
  lastPostAt: string | null
}

export interface GuardInput {
  kind: ActionKind
  now: Date
  settings: XinyuSettings
  state: GuardStateView
  bvid: string
  message?: string
  /** reply 所属线程键：root rpid（楼中楼）或 parent rpid（一级回复） */
  threadKey?: string
  /** coin：投币数量（1 或 2） */
  multiply?: number
}

export interface GuardVerdict {
  allowed: boolean
  channel: 'post' | 'queue' | 'reject'
  code: string
  reason: string
}

const KIND_LABEL: Record<ActionKind, string> = {
  share: '@大号分享', author: '给作者评论', reply: '回复提及', like: '点赞', coin: '投币',
}

function quotaKey(kind: ActionKind): keyof XinyuSettings['quotas'] {
  switch (kind) {
    case 'share': return 'sharePerDay'
    case 'author': return 'authorPerDay'
    case 'reply': return 'replyPerDay'
    case 'like': return 'likePerDay'
    case 'coin': return 'coinPerDay'
  }
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => Number(x))
  return h * 60 + m
}

/** 静默时段判断；from === to 视为全天不静默。支持跨午夜（from > to）。 */
export function inQuietHours(now: Date, from: string, to: string): boolean {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(to)) return false
  if (from === to) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  const a = minutesOf(from), b = minutesOf(to)
  return a < b ? (minutes >= a && minutes < b) : (minutes >= a || minutes < b)
}

export function reject(code: string, reason: string): GuardVerdict {
  return { allowed: false, channel: 'reject', code, reason }
}

/** 本地日期键（YYYY-MM-DD），配额按自然日重置。 */
export function todayKey(now: Date): string {
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function evaluateGuard(input: GuardInput): GuardVerdict {
  const { kind, now, settings, state } = input
  if (settings.general.mode === 'off') return reject('mode_off', '运营总开关为 off，所有公开发言已停用')
  const action = settings.actions[kind]
  if (!action.enabled) return reject('action_disabled', `「${KIND_LABEL[kind]}」动作已在设置中停用`)
  if (inQuietHours(now, settings.schedule.quietFrom, settings.schedule.quietTo)) {
    return reject('quiet_hours', `当前处于静默时段 ${settings.schedule.quietFrom}–${settings.schedule.quietTo}，不发言`)
  }
  const limit = settings.quotas[quotaKey(kind)]
  const used = state.usedToday[kind] ?? 0
  if (used >= limit) return reject('quota_exhausted', `今日「${KIND_LABEL[kind]}」配额已用完（${used}/${limit}）`)

  if ((kind === 'share' || kind === 'author')) {
    const count = state.commentsByVideo[input.bvid] ?? 0
    if (count >= settings.quotas.maxCommentsPerVideo) {
      return reject('video_already_commented', `该视频已发过 ${count} 条一级评论，超过单视频上限`)
    }
  }
  if (kind === 'reply' && input.threadKey !== undefined) {
    const count = state.repliesByThread[input.threadKey] ?? 0
    if (count >= settings.quotas.maxRepliesPerThread) {
      return reject('thread_limit', `该评论线程已回复 ${count} 次，超过单线程上限`)
    }
  }
  if (kind === 'share' && (settings.accounts.owner.mid <= 0 || !settings.accounts.owner.name.trim())) {
    return reject('owner_not_configured', '尚未配置大号 mid/昵称，无法 @大号（请在设置面板填写）')
  }
  if (kind === 'coin' && input.multiply !== undefined && input.multiply !== 1 && input.multiply !== 2) {
    return reject('bad_coin', '投币数量只能是 1 或 2')
  }
  if (input.message !== undefined) {
    for (const word of settings.safety.blockedWords) {
      if (word && input.message.includes(word)) return reject('blocked_word', `发言内容命中屏蔽词（不列出具体词）`)
    }
  }
  // 发言间隔只约束会公开发言的动作；点赞不产生可见发言。
  if (kind !== 'like' && settings.quotas.minPostIntervalMin > 0 && state.lastPostAt) {
    const last = new Date(state.lastPostAt).getTime()
    if (Number.isFinite(last)) {
      const elapsedMin = (now.getTime() - last) / 60000
      if (elapsedMin < settings.quotas.minPostIntervalMin) {
        const wait = Math.ceil(settings.quotas.minPostIntervalMin - elapsedMin)
        return reject('rate_limited', `距离上次公开发言不足 ${settings.quotas.minPostIntervalMin} 分钟，约 ${wait} 分钟后可再发`)
      }
    }
  }

  const needsQueue = settings.general.mode === 'dry_run' || action.approval
  return {
    allowed: true,
    channel: needsQueue ? 'queue' : 'post',
    code: needsQueue ? 'queued' : 'posted',
    reason: needsQueue
      ? (settings.general.mode === 'dry_run' ? '审批制模式（dry_run）：已进入待审队列' : '该动作要求审批：已进入待审队列')
      : '全自动模式，已直接发布',
  }
}
