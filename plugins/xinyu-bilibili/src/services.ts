// 核心服务装配（不依赖宿主 ctx，可本地测试）：
//   submit() —— agent 闸门工具与审批共用的唯一发言通道
//   approvePending()/rejectPending() —— 审批落地（不经 LLM）
//   probeLogin()/botIdentity() —— cookie 探活与小号身份
// 状态变更全部经 Store 原子落盘；所有动作进审计日志。

import { SettingsStore, resolveMcpToken, type ActionKind, type XinyuSettings } from './settings.js'
import { Store, type MyComment, type PendingItem } from './store.js'
import { evaluateGuard } from './guard.js'
import { McpToolError, WeiyuMcp } from './mcp.js'
import { scanMentions, type MentionItem } from './scan.js'
import { readMentionFeed } from './notifications.js'
import type { SubmitArgs, SubmitOutcome } from './tools-xinyu.js'

export const MENTION_REPLY_LIMIT = 1000

export class XinyuGuardError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

export interface ProbeResult {
  status: any
  user: any
  detected: { mid: number; name: string }
  ok: boolean
  message: string
}

interface MentionSyncResult { found: number; items: MentionItem[]; source: 'notifications' | 'scan' }

function sameCommentTarget(record: Pick<MyComment, 'kind' | 'bvid' | 'parent'>, kind: ActionKind, args: SubmitArgs): boolean {
  return record.kind === kind && record.bvid === args.bvid &&
    (kind === 'share' || (kind === 'reply' && Boolean(args.parent) && record.parent === args.parent))
}

export class XinyuCore {
  readonly settings: SettingsStore
  readonly store: Store
  private log: (level: 'info' | 'warn', message: string) => void
  /** 运行时探测到的小号身份（settings.accounts.bot 为空时的回落） */
  private detectedBot: { mid: number; name: string } = { mid: 0, name: '' }
  private readonly startedAt = Math.floor(Date.now() / 1000)
  private mentionSync?: Promise<MentionSyncResult>
  private actions: Promise<unknown> = Promise.resolve()
  lastProbe: { at: string; result: ProbeResult } | null = null

  constructor(settingsPath: string, stateDir: string, log: (level: 'info' | 'warn', message: string) => void = () => undefined) {
    this.settings = new SettingsStore(settingsPath)
    this.store = new Store(stateDir)
    this.log = log
  }

  settings_now(): XinyuSettings { return this.settings.get() }

  mcpClient(): WeiyuMcp {
    const s = this.settings.get()
    return new WeiyuMcp(s.mcp.url, resolveMcpToken(s), s.mcp.timeoutMs)
  }

  private async readLoggedInBot(mcp: WeiyuMcp) {
    const user = await mcp.read('get_current_user')
    const detected = { mid: Number(user?.mid ?? 0), name: String(user?.uname ?? '').trim() }
    if (!Number.isSafeInteger(detected.mid) || detected.mid <= 0 || !detected.name) throw new XinyuGuardError('bot_unknown', 'MCP 未返回已登录的小号身份')
    const expectedMid = this.settings.get().accounts.bot.mid
    if (expectedMid && expectedMid !== detected.mid) throw new XinyuGuardError('bot_mismatch', 'MCP 登录账号与设置中的小号不一致')
    this.detectedBot = detected
    return { user, detected }
  }

  /** cookie 探活 + 小号身份确认；结果缓存供状态页。 */
  async probeLogin(mcp = this.mcpClient()): Promise<ProbeResult> {
    try {
      const status = await mcp.read('get_login_status')
      let user: any = null
      let detected = { mid: 0, name: '' }
      if (status?.configured) {
        try {
          const login = await this.readLoggedInBot(mcp)
          user = login.user
          detected = login.detected
        } catch (error) {
          this.lastProbe = { at: new Date().toISOString(), result: { status, user, detected, ok: false, message: `登录态联网验证失败：${error instanceof Error ? error.message : String(error)}` } }
          return this.lastProbe.result
        }
      }
      const result: ProbeResult = {
        status, user, detected,
        ok: detected.mid > 0,
        message: detected.mid > 0 ? `已登录：${detected.name}` : '未配置 B 站 Cookie',
      }
      this.lastProbe = { at: new Date().toISOString(), result }
      return result
    } catch (error) {
      const result: ProbeResult = { status: null, user: null, detected: { mid: 0, name: '' }, ok: false, message: `MCP 不可达：${error instanceof Error ? error.message : String(error)}` }
      this.lastProbe = { at: new Date().toISOString(), result }
      return result
    }
  }

  /** 小号身份：设置优先，回落最近一次探测结果。 */
  botIdentity(): { mid: number; name: string } {
    const s = this.settings.get()
    if (s.accounts.bot.mid > 0 && s.accounts.bot.name) return { mid: s.accounts.bot.mid, name: s.accounts.bot.name }
    return this.detectedBot
  }

  private serializeAction<T>(action: () => T | Promise<T>): Promise<T> {
    const run = this.actions.then(action)
    this.actions = run.catch(() => undefined)
    return run
  }

  private shareArgs(args: SubmitArgs, settings: XinyuSettings): SubmitArgs {
    const { mid, name: rawName } = settings.accounts.owner
    const name = rawName.trim()
    if (mid <= 0 || !name) throw new XinyuGuardError('owner_not_configured', '尚未配置大号 mid/昵称，无法 @大号')
    let text = args.message?.trim() || args.reason
    for (const previous of [args.mentions?.[0]?.name, name]) {
      if (previous && text.startsWith(`@${previous} `)) {
        text = text.slice(previous.length + 2).trim()
        break
      }
    }
    return {
      bvid: args.bvid, message: `@${name} ${text}`.slice(0, 1000),
      mentions: [{ mid, name }], reason: args.reason,
    }
  }

  private alreadyPublished(kind: ActionKind, args: SubmitArgs): boolean {
    return (kind === 'share' && Boolean(this.store.state.seenVideos[args.bvid]?.actions.includes('share'))) ||
      this.store.state.myComments.some((comment) => sameCommentTarget(comment, kind, args))
  }

  replyAvailability() {
    const now = new Date()
    return evaluateGuard({ kind: 'reply', now, settings: this.settings.get(), state: this.store.guardView(now), bvid: '' })
  }

  /** 回复目标取自持久化通知，模型提供的只有回复正文。 */
  replyToMention(rpid: number, bvid: string, message: string): Promise<SubmitOutcome> {
    return this.serializeAction(() => {
      const item = this.store.state.mentionQueue.find((notice) => notice.rpid === rpid)
      if (!item || (item.bvid && item.bvid !== bvid) || (item.botMid && item.botMid !== this.botIdentity().mid)) {
        throw new XinyuGuardError('mention_target_changed', '待回复评论不存在或与本轮目标不一致')
      }
      const text = message.trim()
      if (!text || text.length > MENTION_REPLY_LIMIT) {
        throw new XinyuGuardError('invalid_reply', `回复正文必须在 1–${MENTION_REPLY_LIMIT} 字符内`)
      }
      const reason = item.via === 'mentioned_us' ? '回复评论中的 @' : '回应对小号评论的回复'
      return this.submitAction('reply', { bvid, message: text, parent: item.rpid, root: item.root || undefined, reason }, item.via === 'mentioned_us')
    })
  }

  /**
   * 唯一发言通道：guard 判定 → queue（待审）/ post（直发）。
   * 拒绝时抛 XinyuGuardError（agent 能看到拒绝原因）。
   */
  submit(kind: ActionKind, args: SubmitArgs): Promise<SubmitOutcome> {
    return this.serializeAction(() => this.submitAction(kind, args))
  }

  private async submitAction(kind: ActionKind, args: SubmitArgs, explicitMention = false): Promise<SubmitOutcome> {
    const s = this.settings.get()
    const now = new Date()
    if (this.alreadyPublished(kind, args)) {
      if (kind === 'reply' && args.parent) this.store.resolveMention(args.parent)
      return { channel: 'post', code: 'already_posted', message: '该评论目标已处理' }
    }
    const thread = args.root || args.parent
    const threadKey = !explicitMention && thread ? String(thread) : undefined
    if (kind === 'share' && s.accounts.owner.mid > 0 && s.accounts.owner.name.trim()) args = this.shareArgs(args, s)
    const verdict = evaluateGuard({
      kind, now, settings: s, state: this.store.guardView(now), bvid: args.bvid,
      message: args.message, threadKey, multiply: args.multiply,
    })
    if (!verdict.allowed) {
      this.store.appendActivity({ event: 'guard_reject', kind, bvid: args.bvid, code: verdict.code, reason: verdict.reason })
      throw new XinyuGuardError(verdict.code, verdict.reason)
    }
    if (kind === 'share' || kind === 'reply') {
      const existing = this.store.loadPending().find((item) => item.status === 'pending' && sameCommentTarget(item, kind, args))
      if (existing) {
        if (kind === 'reply' && args.parent) this.store.resolveMention(args.parent)
        return { channel: 'queue', code: 'already_queued', message: '该评论目标已在待审队列', pendingId: existing.id }
      }
    }
    if (verdict.channel === 'queue') {
      const item = this.store.addPending({
        kind, bvid: args.bvid, message: args.message, mentions: args.mentions,
        parent: args.parent, root: args.root, multiply: args.multiply, reason: args.reason,
      })
      // reply 草稿一旦入待审队列就从提及队列移除，避免重复起草
      if (kind === 'reply' && args.parent) this.store.resolveMention(args.parent)
      return { channel: 'queue', code: 'queued', message: verdict.reason, pendingId: item.id }
    }
    const { rpid } = await this.executeAction(kind, args)
    return { channel: 'post', code: 'posted', message: '已发布', rpid }
  }

  /** 真正调用 MCP 执行动作并回填状态（auto 直发与审批落地共用）。 */
  private async executeAction(kind: ActionKind, args: SubmitArgs): Promise<{ rpid?: number }> {
    const mcp = this.mcpClient()
    const now = new Date()
    if (kind === 'like') {
      await mcp.call('like_video', { bvid: args.bvid, like: true })
      this.store.countQuota('like', now)
      this.store.recordSeenVideo(args.bvid, 'like')
      this.store.appendActivity({ event: 'posted', kind, bvid: args.bvid, reason: args.reason })
      return {}
    }
    if (kind === 'coin') {
      await mcp.call('coin_video', { bvid: args.bvid, multiply: args.multiply ?? 1, like_too: false })
      this.store.countQuota('coin', now)
      this.store.recordSeenVideo(args.bvid, 'coin')
      this.store.appendActivity({ event: 'posted', kind, bvid: args.bvid, multiply: args.multiply ?? 1, reason: args.reason })
      return {}
    }
    // 评论三型：share / author / reply
    const payload: Record<string, unknown> = { bvid: args.bvid, message: args.message }
    if (args.mentions && args.mentions.length > 0) payload.mentions = args.mentions
    if (args.parent !== undefined && args.parent > 0) payload.parent = args.parent
    if (args.root !== undefined && args.root > 0) payload.root = args.root
    const result = await mcp.call('post_comment', payload)
    const rpid = Number(result?.rpid ?? result?.data?.rpid ?? result?.comment_rpid ?? 0)
    if (!Number.isSafeInteger(rpid) || rpid <= 0) throw new McpToolError('missing_rpid', 'MCP 未返回发布后的评论 ID')
    const postedAt = new Date()
    this.store.recordMyComment({ bvid: args.bvid, rpid, kind, root: args.root, parent: args.parent, ts: postedAt.toISOString() }, postedAt)
    this.store.appendActivity({ event: 'posted', kind, bvid: args.bvid, rpid, parent: args.parent, root: args.root, reason: args.reason })
    return { rpid }
  }

  /** 审批落地：mode=off 拒绝；配额耗尽拒绝；静默时段放行（人工决策优先）。 */
  approvePending(id: string): Promise<{ ok: true; item: PendingItem } | { ok: false; message: string }> {
    return this.serializeAction(() => this.publishPending(id))
  }

  private async publishPending(id: string): Promise<{ ok: true; item: PendingItem } | { ok: false; message: string }> {
    const item = this.store.loadPending().find((x) => x.id === id)
    if (!item) return { ok: false, message: '待审条目不存在' }
    if (item.status !== 'pending') return { ok: false, message: `该条目已是 ${item.status} 状态` }
    const s = this.settings.get()
    if (s.general.mode === 'off') return { ok: false, message: '运营总开关为 off，不能发布；请先在设置中切换模式' }
    if (!s.actions[item.kind].enabled) return { ok: false, message: '该动作已停用，不能发布' }
    if (this.alreadyPublished(item.kind, item)) return { ok: false, message: '该评论目标已处理' }
    const now = new Date()
    this.store.rolloverQuotas(now)
    const limits: Record<ActionKind, number> = {
      share: s.quotas.sharePerDay, author: s.quotas.authorPerDay, reply: s.quotas.replyPerDay,
      like: s.quotas.likePerDay, coin: s.quotas.coinPerDay,
    }
    const used = this.store.quotaUsed(item.kind)
    if (used >= limits[item.kind]) return { ok: false, message: `今日「${item.kind}」配额已用完（${used}/${limits[item.kind]}），不能批准` }
    try {
      let args: SubmitArgs = {
        bvid: item.bvid, message: item.message, mentions: item.mentions,
        parent: item.parent, root: item.root, multiply: item.multiply, reason: `审批通过：${item.reason}`,
      }
      if (item.kind === 'share') args = this.shareArgs(args, s)
      const { rpid } = await this.executeAction(item.kind, args)
      const postedAt = new Date().toISOString()
      const updated = this.store.updatePending(id, { status: 'posted', decidedAt: postedAt, postedAt, rpid })
      return { ok: true, item: updated ?? item }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.updatePending(id, { status: 'failed', decidedAt: now.toISOString(), error: message })
      return { ok: false, message: `发布失败：${message}` }
    }
  }

  rejectPending(id: string): Promise<{ ok: boolean; message: string }> {
    return this.serializeAction(() => {
      const item = this.store.loadPending().find((entry) => entry.id === id)
      if (!item || item.status !== 'pending') return { ok: false, message: '该条目已处理或不存在' }
      this.store.updatePending(id, { status: 'rejected', decidedAt: new Date().toISOString() })
      return { ok: true, message: '已拒绝' }
    })
  }

  /** 定时任务和管理面板共用一个收件轮次。 */
  scanMentionsNow(maxVideos = 15): Promise<MentionSyncResult> {
    return this.mentionSync ??= this.collectMentions(maxVideos).finally(() => { this.mentionSync = undefined })
  }

  private async collectMentions(maxVideos: number): Promise<MentionSyncResult> {
    const mcp = this.mcpClient()
    let identity: { mid: number; name: string }
    if (this.settings.get().safety.cookieProbe) {
      const probe = await this.probeLogin(mcp)
      if (!probe.ok) throw new XinyuGuardError('bot_unknown', `cookie 探活未通过：${probe.message}`)
      identity = probe.detected
    } else {
      identity = (await this.readLoggedInBot(mcp)).detected
    }
    const heads = this.store.state.mentionFeedHeads[String(identity.mid)]
    let at
    try {
      at = await readMentionFeed(mcp, 'at', identity, heads?.at, this.startedAt)
    } catch (error) {
      if (!(error instanceof McpToolError) || error.code !== '-32602' || !error.message.includes('未知工具：get_at_feed')) throw error
      const items = await scanMentions(mcp, this.store, identity.name, identity.mid, maxVideos)
      return { found: items.length, items, source: 'scan' }
    }
    const items = this.store.commitMentionFeed(identity.mid, 'at', at.newestId, at.items)
    if (at.ignored > 0) this.store.appendActivity({ event: 'notifications_unreplyable', feed: 'at', count: at.ignored })
    try {
      const replies = await readMentionFeed(mcp, 'reply', identity, heads?.reply, this.startedAt)
      items.push(...this.store.commitMentionFeed(identity.mid, 'reply', replies.newestId, replies.items))
      if (replies.ignored > 0) this.store.appendActivity({ event: 'notifications_unreplyable', feed: 'reply', count: replies.ignored })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.appendActivity({ event: 'notifications_error', feed: 'reply', error: message })
      this.log('warn', `同步「回复我的」失败：${message}`)
    }
    return { found: items.length, items, source: 'notifications' }
  }

  /** agent 的运营笔记（xinyu_note 工具）：只进审计日志，无公开动作。 */
  note(bvid: string, text: string) {
    this.store.appendActivity({ event: 'agent_note', bvid: bvid || undefined, text: String(text).slice(0, 2000) })
  }
}

export { McpToolError }
