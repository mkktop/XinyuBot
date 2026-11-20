// @提及/回复扫描（确定性、插件侧、不耗 LLM）：
// 遍历小号参与过的视频评论区（time 排序第一页）+ 我方一级评论的楼中楼，
// 检测两类需要回应的目标：
//   a) 回复了我方评论（parent/root ∈ 我方 rpid 集合）
//   b) 正文 @ 了小号昵称（真实提及会在正文里出现 @昵称）
// 用于兼容缺少消息中心工具的旧版未雨 MCP。

import { McpToolError, WeiyuMcp } from './mcp.js'
import type { Store } from './store.js'

export interface MentionItem {
  bvid?: string
  aid?: number
  botMid?: number
  videoTitle?: string
  rpid: number
  parent: number
  root: number
  mid: number
  uname: string
  text: string
  /** 消息中心已去掉小号的 @ 标记。旧队列由回复任务按当前小号昵称处理。 */
  question?: string
  ts: string
  /** 检出原因，供提示词与审计 */
  via: 'reply_to_ours' | 'mentioned_us'
}

interface RawComment {
  rpid: number
  parent: number
  root: number
  mid?: number
  member?: { mid?: number; uname?: string }
  content?: { message?: string } | string
  ctime?: number
}

function commentMid(c: RawComment): number {
  return Number(c.mid ?? c.member?.mid ?? 0)
}

function commentUname(c: RawComment): string {
  return String(c.member?.uname ?? '')
}

function commentText(c: RawComment): string {
  if (typeof c.content === 'string') return c.content
  return String(c.content?.message ?? '')
}

function commentTs(c: RawComment): string {
  return typeof c.ctime === 'number' && c.ctime > 0 ? new Date(c.ctime * 1000).toISOString() : ''
}

function extractComments(payload: any): RawComment[] {
  // 兼容结构化与纯文本两种返回形态；列表字段可能是 replies/list
  if (Array.isArray(payload)) return payload as RawComment[]
  if (Array.isArray(payload?.replies)) return payload.replies as RawComment[]
  if (Array.isArray(payload?.list)) return payload.list as RawComment[]
  return []
}

/** 单个视频的一次扫描：返回新检出（未消费水位）的提及。 */
export async function scanVideo(mcp: WeiyuMcp, store: Store, botName: string, botMid: number, bvid: string): Promise<MentionItem[]> {
  const myRpids = store.myRpids()
  const seen = new Set(store.state.seenCommentRpids)
  const found: MentionItem[] = []
  const pageSeen: number[] = []

  const ingest = (raw: RawComment, via: MentionItem['via']) => {
    const rpid = Number(raw.rpid)
    if (!Number.isFinite(rpid) || rpid <= 0 || seen.has(rpid)) return
    const mid = commentMid(raw)
    if (mid === botMid) return // 自己的发言不触发
    pageSeen.push(rpid)
    seen.add(rpid)
    found.push({
      bvid,
      rpid,
      parent: Number(raw.parent ?? 0),
      root: Number(raw.root ?? 0),
      mid,
      uname: commentUname(raw),
      text: commentText(raw).slice(0, 600),
      ts: commentTs(raw),
      via,
    })
  }

  // 一级评论第一页（time 排序，最新在前）
  let top: RawComment[] = []
  try {
    const payload = await mcp.read('get_video_comments', { bvid, sort: 'time', page: 1 })
    top = extractComments(payload)
  } catch (error) {
    if (error instanceof McpToolError && error.code === 'mcp_tool_error') return [] // 无评论等业务性失败，跳过
    throw error
  }
  for (const raw of top) {
    const text = commentText(raw)
    const isReplyToOurs = (Number(raw.parent) > 0 && myRpids.has(Number(raw.parent))) || (Number(raw.root) > 0 && myRpids.has(Number(raw.root)))
    const mentionsUs = botName.length > 0 && text.includes(`@${botName}`)
    if (isReplyToOurs) ingest(raw, 'reply_to_ours')
    else if (mentionsUs) ingest(raw, 'mentioned_us')
  }

  // 我方一级评论的楼中楼（别人回复我们通常落在这里）
  const ourRoots = store.state.myComments.filter((c) => c.bvid === bvid && c.rpid > 0 && !c.root).map((c) => c.rpid)
  for (const rootRpid of ourRoots.slice(-5)) {
    try {
      const payload = await mcp.read('get_comment_replies', { bvid, root_rpid: rootRpid, page: 1 })
      for (const raw of extractComments(payload)) {
        const isReplyToOurs = Number(raw.parent) === rootRpid || Number(raw.root) === rootRpid ||
          myRpids.has(Number(raw.parent)) || myRpids.has(Number(raw.root))
        if (isReplyToOurs) ingest(raw, 'reply_to_ours')
        else if (botName.length > 0 && commentText(raw).includes(`@${botName}`)) ingest(raw, 'mentioned_us')
      }
    } catch (error) {
      if (error instanceof McpToolError && error.code === 'mcp_tool_error') continue // 楼中楼为空等
      throw error
    }
  }

  store.markScan(bvid, new Date(), pageSeen)
  return found
}

/** 扫描所有参与过的视频（水位内去重），并为命中的视频补标题供提示词引用。 */
export async function scanMentions(mcp: WeiyuMcp, store: Store, botName: string, botMid: number, maxVideos = 15): Promise<MentionItem[]> {
  const bvids = store.participatedVideos(maxVideos)
  const all: MentionItem[] = []
  for (const bvid of bvids) {
    try {
      all.push(...await scanVideo(mcp, store, botName, botMid, bvid))
    } catch (error) {
      // 单视频失败不拖垮整轮扫描
      store.appendActivity({ event: 'scan_video_error', bvid, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // 为命中视频补标题（每视频一次调用，只对命中的做）
  const titles = new Map<string, string | undefined>()
  for (const item of all) {
    if (!item.bvid || titles.has(item.bvid)) continue
    try {
      const info = await mcp.read('parse_video', { url: item.bvid })
      titles.set(item.bvid, String(info?.title ?? '').slice(0, 200) || undefined)
    } catch { titles.set(item.bvid, undefined) }
  }
  for (const item of all) if (item.bvid) item.videoTitle = titles.get(item.bvid)
  // 立即落队：水位已消费，草稿不能只留在内存里
  store.addMentions(all)
  return all
}
