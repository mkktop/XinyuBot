// 运行期状态存储（与设置分离）：
//   state.json    —— 已看视频、我方评论记录、配额用量、扫描水位、最近任务
//   pending.json  —— 待审批队列（dry_run/审批动作的草稿）
//   activity.jsonl —— 追加式审计日志（谁在什么时候做了什么、为什么）
// 全部原子写（tmp+rename，0600）；损坏拒绝加载，绝不静默重置——
// 发言状态一旦丢失可能导致超配额公开发言，宁可拒绝启动。
// 形态参照 yusheng 的持久化纪律（settings 边车 / durable 回执）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { ActionKind } from './settings.js'
import { todayKey, type GuardStateView } from './guard.js'
import type { MentionItem } from './scan.js'
import type { MentionFeed } from './notifications.js'

export type PendingStatus = 'pending' | 'approved' | 'rejected' | 'posted' | 'failed'

export interface PendingItem {
  id: string
  createdAt: string
  kind: ActionKind
  bvid: string
  message?: string
  mentions?: Array<{ mid: number; name: string }>
  parent?: number
  root?: number
  multiply?: number
  /** agent/扫描给出的理由，进审计日志与审批界面 */
  reason: string
  status: PendingStatus
  decidedAt?: string
  postedAt?: string
  rpid?: number
  error?: string
}

export interface MyComment {
  bvid: string
  /** 0 = 尚未知（pending 中）；发出后回填真实 rpid */
  rpid: number
  kind: ActionKind
  root?: number
  parent?: number
  ts: string
}

export interface JobRecord {
  kind: 'browse' | 'mention'
  trigger: 'schedule' | 'manual'
  startedAt: string
  endedAt?: string
  status: 'running' | 'ok' | 'error' | 'timeout'
  summary?: string
  error?: string
}

interface QueuedMentionItem extends MentionItem {
  queuedAt: string
  attempts: number
  replySessionId?: string
}

export interface XinyuState {
  version: 1
  /** bvid → 首见/末见时间与已执行动作（防重复推荐的软去重） */
  seenVideos: Record<string, { firstSeen: string; lastSeen: string; actions: string[] }>
  myComments: MyComment[]
  /** 扫描去重水位：已处理过的评论 rpid（环形封顶） */
  seenCommentRpids: number[]
  /** 每个登录小号的 @ / 回复通知水位。 */
  mentionFeedHeads: Record<string, Partial<Record<MentionFeed, number>>>
  quotasUsed: { date: string; share: number; author: number; reply: number; like: number; coin: number }
  /** 上一次公开发言（含 queue → post 落地）时间 */
  lastPostAt: string | null
  /** bvid → 上次扫描时间 */
  lastScan: Record<string, string>
  lastJobs: JobRecord[]
  /** 浏览会话和最近使用的提及会话，用于管理面板。 */
  sessions: { browse?: string; mention?: string }
  /** 待回应的提及队列（扫描落队，job 消费；带重试上限） */
  mentionQueue: QueuedMentionItem[]
}

const MENTION_MAX_ATTEMPTS = 3

export function emptyState(): XinyuState {
  return {
    version: 1,
    seenVideos: {},
    myComments: [],
    seenCommentRpids: [],
    mentionFeedHeads: {},
    quotasUsed: { date: '', share: 0, author: 0, reply: 0, like: 0, coin: 0 },
    lastPostAt: null,
    lastScan: {},
    lastJobs: [],
    sessions: {},
    mentionQueue: [],
  }
}

const MY_COMMENTS_CAP = 500
const SEEN_RPID_CAP = 5000
const JOBS_CAP = 30
const SEEN_VIDEOS_CAP = 2000

function trimJobs(jobs: JobRecord[]): JobRecord[] {
  const counts = { browse: 0, mention: 0 }
  return jobs.slice().reverse().filter((job) => counts[job.kind]++ < JOBS_CAP).reverse()
}

export class Store {
  readonly dir: string
  state: XinyuState

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.state = this.loadState()
  }

  private statePath(): string { return `${this.dir}/state.json` }
  private pendingPath(): string { return `${this.dir}/pending.json` }
  private activityPath(): string { return `${this.dir}/activity.jsonl` }

  private loadState(): XinyuState {
    const path = this.statePath()
    if (!existsSync(path)) return this.writeState(emptyState())
    let raw: unknown
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
      throw new Error(`xinyu-bilibili: 状态文件损坏且拒绝加载（不静默重置，请人工检查 ${path}）：${error instanceof Error ? error.message : String(error)}`)
    }
    const base = emptyState()
    const raw_obj = (raw ?? {}) as Record<string, unknown>
    if (raw_obj.version !== 1) throw new Error(`xinyu-bilibili: 状态文件版本不识别：${path}`)
    const state: XinyuState = {
      version: 1,
      seenVideos: isRecord(raw_obj.seenVideos) ? raw_obj.seenVideos as XinyuState['seenVideos'] : base.seenVideos,
      myComments: Array.isArray(raw_obj.myComments) ? raw_obj.myComments as MyComment[] : base.myComments,
      seenCommentRpids: Array.isArray(raw_obj.seenCommentRpids) ? raw_obj.seenCommentRpids.filter((x) => typeof x === 'number') as number[] : base.seenCommentRpids,
      mentionFeedHeads: isRecord(raw_obj.mentionFeedHeads) ? raw_obj.mentionFeedHeads as XinyuState['mentionFeedHeads'] : base.mentionFeedHeads,
      quotasUsed: isRecord(raw_obj.quotasUsed) ? { ...base.quotasUsed, ...raw_obj.quotasUsed as Record<string, unknown> } as XinyuState['quotasUsed'] : base.quotasUsed,
      lastPostAt: typeof raw_obj.lastPostAt === 'string' ? raw_obj.lastPostAt : null,
      lastScan: isRecord(raw_obj.lastScan) ? raw_obj.lastScan as Record<string, string> : base.lastScan,
      lastJobs: Array.isArray(raw_obj.lastJobs) ? trimJobs(raw_obj.lastJobs as JobRecord[]) : base.lastJobs,
      sessions: isRecord(raw_obj.sessions) ? raw_obj.sessions as XinyuState['sessions'] : base.sessions,
      mentionQueue: Array.isArray(raw_obj.mentionQueue) ? raw_obj.mentionQueue as XinyuState['mentionQueue'] : base.mentionQueue,
    }
    return state
  }

  private writeState(state: XinyuState): XinyuState {
    const temporary = `${this.statePath()}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, this.statePath())
    return state
  }

  /** 原子写成功后再更新内存状态。 */
  mutate<T>(fn: (state: XinyuState) => T): T {
    const next = structuredClone(this.state)
    const result = fn(next)
    this.state = this.writeState(next)
    return result
  }

  // ---- 配额 ----

  /** 跨天滚动：日期变了就清零。 */
  rolloverQuotas(now: Date) {
    const today = todayKey(now)
    if (this.state.quotasUsed.date !== today) this.mutate((state) => resetQuotas(state, today))
  }

  quotaUsed(kind: ActionKind): number { return this.state.quotasUsed[kind] }

  countQuota(kind: ActionKind, now: Date) {
    this.rolloverQuotas(now)
    this.mutate((state) => { state.quotasUsed[kind] += 1 })
  }

  /** guard 需要的状态视图（只读投影）。 */
  guardView(now: Date): GuardStateView {
    this.rolloverQuotas(now)
    const commentsByVideo: Record<string, number> = {}
    const repliesByThread: Record<string, number> = {}
    for (const c of this.state.myComments) {
      if (c.kind === 'share' || c.kind === 'author') {
        commentsByVideo[c.bvid] = (commentsByVideo[c.bvid] ?? 0) + 1
      }
      if (c.kind === 'reply') {
        const key = String(c.root ?? c.parent ?? 0)
        if (key !== '0') repliesByThread[key] = (repliesByThread[key] ?? 0) + 1
      }
    }
    return {
      usedToday: {
        share: this.state.quotasUsed.share,
        author: this.state.quotasUsed.author,
        reply: this.state.quotasUsed.reply,
        like: this.state.quotasUsed.like,
        coin: this.state.quotasUsed.coin,
      },
      commentsByVideo,
      repliesByThread,
      lastPostAt: this.state.lastPostAt,
    }
  }

  // ---- 我方评论 ----

  recordMyComment(comment: MyComment, postedAt?: Date) {
    this.mutate((state) => {
      state.myComments.push(comment)
      if (state.myComments.length > MY_COMMENTS_CAP) state.myComments = state.myComments.slice(-MY_COMMENTS_CAP)
      markSeen(state, comment.bvid, comment.kind)
      if (postedAt) {
        resetQuotas(state, todayKey(postedAt))
        state.quotasUsed[comment.kind] += 1
        state.lastPostAt = postedAt.toISOString()
        if (comment.kind === 'reply' && comment.parent) {
          state.mentionQueue = state.mentionQueue.filter((item) => item.rpid !== comment.parent)
        }
      }
    })
  }

  /** pending 落地后回填真实 rpid。 */
  attachRpid(bvid: string, kind: ActionKind, ts: string, rpid: number, root?: number, parent?: number) {
    this.mutate((state) => {
      // 从后往前找最近一条同视频同类型、rpid 还是 0 的记录
      for (let i = state.myComments.length - 1; i >= 0; i -= 1) {
        const c = state.myComments[i]
        if (c.bvid === bvid && c.kind === kind && c.rpid === 0) {
          state.myComments[i] = { ...c, rpid, root, parent, ts }
          return
        }
      }
      state.myComments.push({ bvid, rpid, kind, root, parent, ts })
      if (state.myComments.length > MY_COMMENTS_CAP) state.myComments = state.myComments.slice(-MY_COMMENTS_CAP)
    })
  }

  /** 我方参与过的视频（去重，最新在前），供扫描遍历。 */
  participatedVideos(limit: number): string[] {
    const seen: string[] = []
    for (let i = this.state.myComments.length - 1; i >= 0 && seen.length < limit; i -= 1) {
      const bvid = this.state.myComments[i].bvid
      if (!seen.includes(bvid)) seen.push(bvid)
    }
    return seen
  }

  myRpids(): Set<number> {
    return new Set(this.state.myComments.filter((c) => c.rpid > 0).map((c) => c.rpid))
  }

  // ---- 待审批 ----

  loadPending(): PendingItem[] {
    const path = this.pendingPath()
    if (!existsSync(path)) return []
    let raw: unknown
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
      throw new Error(`xinyu-bilibili: 待审队列文件损坏且拒绝加载（不静默重置，请人工检查 ${path}）：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(raw)) throw new Error(`xinyu-bilibili: 待审队列文件格式不正确：${path}`)
    return raw as PendingItem[]
  }

  savePending(items: PendingItem[]) {
    const temporary = `${this.pendingPath()}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, this.pendingPath())
  }

  addPending(item: Omit<PendingItem, 'id' | 'createdAt' | 'status'>): PendingItem {
    const items = this.loadPending()
    const full: PendingItem = { ...item, id: randomUUID(), createdAt: new Date().toISOString(), status: 'pending' }
    items.push(full)
    // 只保留未决 + 最近 200 条已决
    const open = items.filter((x) => x.status === 'pending')
    const decided = items.filter((x) => x.status !== 'pending').slice(-200)
    this.savePending([...open, ...decided])
    this.appendActivity({ event: 'pending_added', kind: full.kind, bvid: full.bvid, id: full.id, reason: full.reason })
    return full
  }

  updatePending(id: string, patch: Partial<Pick<PendingItem, 'status' | 'decidedAt' | 'postedAt' | 'rpid' | 'error'>>): PendingItem | undefined {
    const items = this.loadPending()
    const item = items.find((x) => x.id === id)
    if (!item) return undefined
    Object.assign(item, patch)
    this.savePending(items)
    this.appendActivity({ event: 'pending_update', id, status: patch.status, rpid: patch.rpid, error: patch.error })
    return item
  }

  // ---- 扫描水位 / 已看视频 ----

  markScan(bvid: string, now: Date, seenRpids: number[] = []) {
    this.mutate((state) => {
      state.lastScan[bvid] = now.toISOString()
      for (const rpid of seenRpids) if (!state.seenCommentRpids.includes(rpid)) state.seenCommentRpids.push(rpid)
      if (state.seenCommentRpids.length > SEEN_RPID_CAP) state.seenCommentRpids = state.seenCommentRpids.slice(-SEEN_RPID_CAP)
    })
  }

  recordSeenVideo(bvid: string, action?: string) {
    this.mutate((state) => { markSeen(state, bvid, action) })
  }

  // ---- 任务记录 ----

  beginJob(record: JobRecord): JobRecord {
    this.mutate((state) => {
      state.lastJobs.push(record)
      if (state.lastJobs.length > JOBS_CAP) state.lastJobs = trimJobs(state.lastJobs)
    })
    return record
  }

  endJob(kind: string, startedAt: string, status: JobRecord['status'], summary?: string, error?: string) {
    this.mutate((state) => {
      const job = [...state.lastJobs].reverse().find((x) => x.kind === kind && x.startedAt === startedAt)
      if (job) { job.endedAt = new Date().toISOString(); job.status = status; if (summary) job.summary = summary.slice(0, 4000); if (error) job.error = error.slice(0, 2000) }
    })
  }

  rememberSession(target: 'browse' | number, sessionId: string) {
    this.mutate((state) => {
      if (target === 'browse') {
        state.sessions.browse = sessionId
      } else {
        state.sessions.mention = sessionId
        const item = state.mentionQueue.find((mention) => mention.rpid === target)
        if (item) item.replySessionId = sessionId
      }
    })
  }

  // ---- 提及队列（扫描落队 → job 消费）----

  addMentions(items: MentionItem[]) {
    return this.enqueueMentions(items).length
  }

  commitMentionFeed(botMid: number, feed: MentionFeed, newestId: number, items: MentionItem[]): MentionItem[] {
    return this.enqueueMentions(items, { botMid, feed, newestId })
  }

  private enqueueMentions(items: MentionItem[], checkpoint?: { botMid: number; feed: MentionFeed; newestId: number }): MentionItem[] {
    const key = checkpoint ? String(checkpoint.botMid) : ''
    if (items.length === 0 && (!checkpoint || this.state.mentionFeedHeads[key]?.[checkpoint.feed] === checkpoint.newestId)) return []
    const added = this.mutate((state) => {
      const queued = new Set(state.mentionQueue.map((item) => item.rpid))
      const seen = new Set(checkpoint ? state.seenCommentRpids : [])
      for (const comment of state.myComments) if (comment.kind === 'reply' && comment.parent) seen.add(comment.parent)
      const inserted: MentionItem[] = []
      for (const item of items) {
        if (queued.has(item.rpid) || seen.has(item.rpid)) continue
        queued.add(item.rpid)
        state.mentionQueue.push({ ...item, queuedAt: new Date().toISOString(), attempts: 0 })
        inserted.push(item)
      }
      if (checkpoint) {
        const heads = state.mentionFeedHeads[key] ??= {}
        heads[checkpoint.feed] = Math.max(heads[checkpoint.feed] ?? 0, checkpoint.newestId)
        state.seenCommentRpids = [...new Set([...state.seenCommentRpids, ...items.map((item) => item.rpid)])].slice(-SEEN_RPID_CAP)
      }
      return inserted
    })
    if (added.length > 0) this.appendActivity({ event: 'mentions_queued', count: added.length, rpids: added.slice(0, 20).map((x) => x.rpid) })
    return added
  }

  /** 取一批待回应提及，发布或提交审批后才移出队列。 */
  takeMentions(max: number, botMid?: number, excluded?: ReadonlySet<number>): QueuedMentionItem[] {
    return this.state.mentionQueue.filter((x) => x.attempts < MENTION_MAX_ATTEMPTS &&
      (!botMid || !x.botMid || x.botMid === botMid) && !excluded?.has(x.rpid)).slice(0, max)
  }

  deferMentions(rpids: Set<number>) {
    if (rpids.size === 0) return
    this.mutate((state) => {
      const retry = state.mentionQueue.filter((item) => rpids.has(item.rpid))
      state.mentionQueue = state.mentionQueue.filter((item) => !rpids.has(item.rpid)).concat(retry)
    })
  }

  resolveMention(rpid: number) {
    this.mutate((state) => { state.mentionQueue = state.mentionQueue.filter((x) => x.rpid !== rpid) })
  }

  bumpMention(rpid: number) {
    this.mutate((state) => {
      const item = state.mentionQueue.find((x) => x.rpid === rpid)
      if (!item) return
      item.attempts += 1
      if (item.attempts >= MENTION_MAX_ATTEMPTS) {
        state.mentionQueue = state.mentionQueue.filter((x) => x.rpid !== rpid)
        this.appendActivity({ event: 'mention_dropped', rpid, reason: '超过重试上限' })
      }
    })
  }

  mentionQueueSize(): number { return this.state.mentionQueue.length }

  // ---- 审计日志 ----

  appendActivity(entry: Record<string, unknown>) {
    try {
      appendFileSync(this.activityPath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
    } catch { /* 日志失败不阻塞主流程 */ }
  }

  readActivity(limit: number): Array<Record<string, unknown>> {
    const path = this.activityPath()
    if (!existsSync(path)) return []
    try {
      const raw = readFileSync(path, 'utf8')
      const lines = raw.split('\n').filter((line) => line.trim().length > 0)
      return lines.slice(-limit).map((line) => { try { return JSON.parse(line) } catch { return { ts: '', event: 'corrupt_line', raw: line.slice(0, 500) } } })
    } catch { return [] }
  }
}

function resetQuotas(state: XinyuState, today: string) {
  if (state.quotasUsed.date !== today) state.quotasUsed = { date: today, share: 0, author: 0, reply: 0, like: 0, coin: 0 }
}

function markSeen(state: XinyuState, bvid: string, action?: string) {
  const now = new Date().toISOString()
  const existing = state.seenVideos[bvid]
  if (existing) {
    existing.lastSeen = now
    if (action && !existing.actions.includes(action)) existing.actions.push(action)
  } else {
    state.seenVideos[bvid] = { firstSeen: now, lastSeen: now, actions: action ? [action] : [] }
  }
  const bvids = Object.keys(state.seenVideos)
  if (bvids.length > SEEN_VIDEOS_CAP) {
    // 分享记录用于防止重发。只淘汰最近浏览记录。
    const sorted = bvids.filter((key) => !state.seenVideos[key].actions.includes('share'))
      .sort((a, b) => state.seenVideos[a].lastSeen.localeCompare(state.seenVideos[b].lastSeen))
    for (const key of sorted.slice(0, bvids.length - SEEN_VIDEOS_CAP)) delete state.seenVideos[key]
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
