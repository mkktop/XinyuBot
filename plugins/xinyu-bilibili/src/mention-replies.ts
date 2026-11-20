import type { JobBridge } from './bridge.js'
import { mentionQuestion } from './notifications.js'
import { replyPrompt, shortenReplyPrompt, type QueuedMention } from './prompts.js'
import { MENTION_REPLY_LIMIT, XinyuCore, XinyuGuardError } from './services.js'
import type { XinyuSettings } from './settings.js'
import type { MentionItem } from './scan.js'

interface VideoInfo {
  bvid?: string
  title?: string
  owner_name?: string
  owner_mid?: number
  desc?: string
  duration?: number
  pages?: Array<{ cid?: number }>
}

const DEFERRED_CODES = new Set(['mode_off', 'action_disabled', 'quiet_hours', 'quota_exhausted', 'rate_limited'])

function summaryText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function describeVideo(video: VideoInfo, title: string): string {
  const fields = [`《${title}》`]
  const author = summaryText(video.owner_name, 80)
  if (author) fields.push(`UP 主：${author}`)
  const duration = Math.floor(Number(video.duration))
  if (Number.isFinite(duration) && duration > 0) {
    const min = Math.floor(duration / 60)
    const sec = duration % 60
    fields.push(`时长：${min ? `${min} 分 ` : ''}${sec} 秒`)
  }
  const desc = summaryText(typeof video.desc === 'string' ? video.desc.replace(/https?:\/\/[^\s]+/g, '') : '', 1000)
  return fields.join(' · ') + (desc ? `\n简介：${desc}` : '')
}

function readDraft(text: string, rpid: number): string | undefined {
  const json = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].at(-1)?.[1] ?? text
  let best: string | undefined
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed?.replies)) {
      for (const reply of parsed.replies) {
        const rawId = reply?.rpid
        const replyId = typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : rawId
        if (replyId !== rpid || typeof reply.message !== 'string') continue
        const message = reply.message.trim()
        if (!message) continue
        if (message.length <= MENTION_REPLY_LIMIT) return message
        if (!best || message.length < best.length) best = message
      }
    }
  } catch { /* 下一轮重新起草缺失的回复。 */ }
  return best
}

function fitReply(message: string): string {
  if (message.length <= MENTION_REPLY_LIMIT) return message
  // 改写仍超长时尽量在完整的句子或段落后截断，并保留完整的 Unicode 字符。
  const prefix = message.slice(0, MENTION_REPLY_LIMIT - 1).replace(/[\uD800-\uDBFF]$/u, '').trimEnd()
  return `${prefix.replace(/([。！？!?\n])[^。！？!?\n]{0,140}$/u, '$1').trimEnd()}…`
}

interface MentionReplyResult {
  posted: number
  queued: number
  retry: number
  waiting?: string
  error?: string
  timeout?: boolean
}

/** 每条评论独立起草，队列限制同时起草的数量，实际发言仍由 core 串行发布。 */
export async function replyToQueuedMentions(
  core: XinyuCore,
  bridge: Pick<JobBridge, 'runJob'>,
  settings: XinyuSettings,
  options: { active?: Set<number>; stopped?: () => boolean } = {},
): Promise<MentionReplyResult> {
  const result: MentionReplyResult = { posted: 0, queued: 0, retry: 0 }
  const bot = core.botIdentity()
  const mcp = core.mcpClient()
  const videos = new Map<string, Promise<VideoInfo>>()
  const active = options.active ?? new Set<number>()
  const attempted = new Set<number>()
  const tasks = new Set<Promise<void>>()
  const reportError = (rpid: number, error: unknown) => {
    result.retry += 1
    const message = error instanceof Error ? error.message : String(error)
    core.store.appendActivity({ event: 'mention_reply_error', rpid, error: message })
    core.store.deferMentions(new Set([rpid]))
  }

  const replyToItem = async (item: MentionItem) => {
    try {
      const ref = item.bvid || (item.aid ? `av${item.aid}` : '')
      if (!ref) throw new Error('缺少原视频标识')
      let lookup = videos.get(ref)
      if (!lookup) {
        lookup = mcp.read<VideoInfo>('parse_video', { url: ref })
        videos.set(ref, lookup)
      }
      const info = await lookup
      const bvid = item.bvid ?? info?.bvid
      if (!bvid || !/^BV[A-Za-z0-9]{4,18}$/.test(bvid) || (info?.bvid && info.bvid !== bvid)) throw new Error('未能确认原视频的 BV 号')
      const title = summaryText(info.title || item.videoTitle, 200) || bvid
      const target: QueuedMention = {
        bvid, rpid: item.rpid, uname: item.uname,
        question: item.question ?? mentionQuestion(item.text, bot.name),
        videoInfo: describeVideo(info, title),
        cid: info.pages?.[0]?.cid || undefined,
        up_mid: info.owner_mid || undefined,
      }
      const session = { rpid: item.rpid }
      const turn = await bridge.runJob(session, {
        prompt: replyPrompt(settings, target),
        timeoutMs: 10 * 60_000,
        buildTools: () => [],
      }, settings.llm)
      if (turn.kind !== 'completed') {
        if (turn.kind === 'timeout') result.timeout = true
        result.error ??= turn.error ?? '起草评论回复失败'
        throw new Error(turn.error ?? '起草评论回复失败')
      }
      let response = readDraft(turn.text, item.rpid)
      if (!response) {
        result.error ??= '模型未返回该评论的有效回复'
        throw new Error('模型未返回该评论的有效回复')
      }
      if (response.length > MENTION_REPLY_LIMIT) {
        const revision = await bridge.runJob(session, {
          prompt: shortenReplyPrompt({ rpid: item.rpid, question: target.question, message: response }),
          timeoutMs: 90_000,
          buildTools: () => [],
        }, settings.llm)
        const shorter = revision.kind === 'completed' ? readDraft(revision.text, item.rpid) : undefined
        response = fitReply(shorter && shorter.length < response.length ? shorter : response)
      }
      if (options.stopped?.()) return
      const outcome = await core.replyToMention(item.rpid, bvid, response)
      if (outcome.code === 'posted') result.posted += 1
      if (outcome.code === 'queued') result.queued += 1
    } catch (error) {
      if (error instanceof XinyuGuardError && DEFERRED_CODES.has(error.code)) {
        result.waiting = error.message
        return
      }
      if (error instanceof XinyuGuardError && error.code === 'thread_limit') {
        core.store.resolveMention(item.rpid)
        core.store.appendActivity({ event: 'mention_reply_skipped', rpid: item.rpid, reason: error.message })
        return
      }
      reportError(item.rpid, error)
    }
  }

  while (attempted.size < 10 && !options.stopped?.()) {
    const [item] = core.store.takeMentions(1, bot.mid, new Set([...active, ...attempted]))
    if (!item) break
    if (active.size >= core.settings.get().schedule.mentionConcurrency) {
      if (tasks.size === 0) break
      await Promise.race(tasks)
      continue
    }
    const availability = core.replyAvailability()
    if (!availability.allowed) {
      result.waiting = availability.reason
      break
    }
    attempted.add(item.rpid)
    active.add(item.rpid)
    const task = replyToItem(item).finally(() => {
      active.delete(item.rpid)
      tasks.delete(task)
    })
    tasks.add(task)
  }
  await Promise.all(tasks)
  return result
}
