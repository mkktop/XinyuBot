import type { WeiyuMcp } from './mcp.js'
import type { MentionItem } from './scan.js'

export type MentionFeed = 'at' | 'reply'

interface NotificationUser {
  mid?: number | string
  nickname?: string
}

interface Notification {
  id: number
  at_time?: number
  reply_time?: number
  time?: number
  user?: NotificationUser
  item?: {
    business_id?: number | string
    subject_id?: number | string
    subject_title?: string
    title?: string
    uri?: string
    root_id?: number | string
    parent_id?: number | string
    target_reply_id?: number | string
    source_id?: number | string
    target_id?: number | string
    message?: string
    source_content?: string
    time?: number
    at_details?: NotificationUser[]
  }
}

interface FeedPage {
  items: Notification[]
  cursor: { is_end: boolean; id?: number; time?: number }
}

interface BotIdentity { mid: number; name: string }

function positiveInt(value: unknown): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0
}

export function mentionQuestion(text: string, ...botNames: string[]): string {
  let remainder = text
  for (const name of botNames) {
    if (name) remainder = remainder.replaceAll(`@${name}`, ' ').replaceAll(`＠${name}`, ' ')
  }
  remainder = remainder.trim()
  return /[^\s\p{P}\p{Cf}]/u.test(remainder) ? remainder : ''
}

function toMention(notification: Notification, feed: MentionFeed, bot: BotIdentity, time: number): MentionItem | undefined {
  const item = notification.item
  const mid = positiveInt(notification.user?.mid)
  if (!item || !mid || mid === bot.mid) return

  const business = positiveInt(item.business_id)
  const link = /^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]{10}|av\d+)(?=[/?#]|$)/i.exec(item.uri ?? '')?.[1]
  if (business !== 1 && (business > 0 || !link)) return
  const bvid = link && /^bv/i.test(link) ? `BV${link.slice(2)}` : undefined
  const aid = positiveInt(item.subject_id) || positiveInt(link?.slice(2))
  if (!bvid && !aid) return

  const linkReply = link ? /#reply(\d+)$/.exec(item.uri ?? '')?.[1] : undefined
  // 现行消息中心用 source_id 指向发送者评论，旧版 @ 通知用 target_reply_id。
  const rpid = positiveInt(item.source_id) || (feed === 'at' ? positiveInt(item.target_reply_id) : 0) || positiveInt(linkReply)
  if (!rpid) return
  const parent = positiveInt(item.target_id) || (feed === 'at' ? positiveInt(item.parent_id) : 0)
  const root = positiveInt(item.root_id) || parent
  const text = String(item.source_content || item.message || '').slice(0, 1000)
  const mentioned = Array.isArray(item.at_details) ? item.at_details.find((user) => positiveInt(user?.mid) === bot.mid) : undefined
  return {
    bvid, aid, botMid: bot.mid, rpid, parent, root, mid, text,
    videoTitle: String(item.subject_title ?? item.title ?? '').slice(0, 200) || undefined,
    uname: String(notification.user?.nickname ?? '').slice(0, 80),
    ts: time > 0 && time < 8_640_000_000_000 ? new Date(time * 1000).toISOString() : '',
    via: feed === 'at' || mentioned ? 'mentioned_us' : 'reply_to_ours',
    question: mentionQuestion(text, String(mentioned?.nickname ?? ''), bot.name),
  }
}

/** 从首页增量读取。翻页游标与插件记录的最新通知 ID 分开维护。 */
export async function readMentionFeed(mcp: Pick<WeiyuMcp, 'read'>, feed: MentionFeed, bot: BotIdentity, previousId: number | undefined, startedAt: number) {
  const tool = feed === 'at' ? 'get_at_feed' : 'get_reply_feed'
  const items: MentionItem[] = []
  const cursors = new Set<string>()
  let args: Record<string, number> = {}
  let newestId = previousId ?? 0
  let ignored = 0

  for (;;) {
    const page = await mcp.read<FeedPage>(tool, args)
    if (!Array.isArray(page?.items) || typeof page.cursor?.is_end !== 'boolean') throw new Error(`${tool} 返回了无效的通知列表`)
    let reachedCheckpoint = false
    for (const notification of page.items) {
      const id = positiveInt(notification?.id)
      if (!id) throw new Error(`${tool} 返回了无效的通知 ID`)
      if (previousId !== undefined && id <= previousId) {
        reachedCheckpoint = true
        continue
      }
      newestId = Math.max(newestId, id)
      // 0.4.0 的 @ 列表可能只在 item.time 中保留单条通知的时间。
      const time = positiveInt(notification.at_time) || positiveInt(notification.reply_time) ||
        positiveInt(notification.time) || positiveInt(notification.item?.time) ||
        (id === page.cursor.id ? positiveInt(page.cursor.time) : 0)
      if (previousId === undefined && time < startedAt) continue
      const mention = toMention(notification, feed, bot, time)
      if (mention) items.push(mention)
      else ignored += 1
    }
    const nextId = positiveInt(page.cursor.id)
    const nextTime = positiveInt(page.cursor.time)
    if (page.cursor.is_end || reachedCheckpoint || (previousId === undefined && nextTime > 0 && nextTime < startedAt)) break
    const cursorKey = `${nextId}:${nextTime}`
    if (!nextId || !nextTime || cursors.has(cursorKey)) throw new Error(`${tool} 返回了无法继续的翻页游标`)
    cursors.add(cursorKey)
    args = { last_id: nextId, last_time: nextTime }
  }

  return { newestId, items: items.reverse(), ignored }
}
