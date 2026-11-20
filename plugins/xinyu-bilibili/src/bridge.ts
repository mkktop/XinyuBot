// 进程内 dsh 会话驱动（job 专用精简版）：
// 会话恢复次序、preset 挂载时机、durable followup、收敛等待与 flush 全部
// 参照 yusheng voice 的 AgentBridge（即官方 headless runner 的公开模式）。
// 会话创建和恢复需要遵守三个宿主约定：
//   1) preset 挂载必须发生在 agents.create 的 setup 里（agentPresets.mount）：
//      事后 select 不报错，但 preset 子树工具不会进入请求工具清单（2026-11-18 实测）。
//   2) 盲目 resume→create 会对已存在会话撞 "already exists"：
//      先查进程内实例，再 sessionQuery 探测持久会话，存在才 resume。
//   3) 用户在 dsh 界面归档任务会话后，宿主 archived-session-gate 会在
//      agent/pre-step 拒绝其一切模型步（"loop ends as blocked without a
//      request"）：followup 不报错、whenIdle 立即返回、turn 空文本秒完成，
//      表现为 job "ok" 但什么都没做。归档会话必须整体跳过（resume 也会
//      照常成功，只是永远空转），并按"已存在"处理让 create 派生新 id。
//      归档状态查 workspaceRegistry.archivedSessionIds；但该服务不一定能
//      从插件作用域解析到（2026-11-19 真机实测 root.get 为 undefined），
//      所以另有行为特征兜底：turn 零输出秒回即判死会话，弃用并重试一次。

import { randomUUID } from 'node:crypto'
import type { Store } from './store.js'

/** 原生 MCP 写工具名（不含可能的 provider 前缀）——agent 作用域必须屏蔽的一批。 */
export const NATIVE_WRITE_TOOLS = ['post_comment', 'like_video', 'coin_video', 'favorite_video', 'add_watch_later', 'remove_watch_later'] as const
/** 已知可能的 MCP 工具名前缀（各宿主实现不一，探测后用实测定 deny 名单）。 */
const NAME_PREFIXES = ['', 'weiyu_', 'mcp_weiyu_', 'mcp__weiyu__']

export interface JobTurnOptions {
  prompt: string
  timeoutMs: number
  /** 每轮注册的闸门工具工厂（拿到 agent 实例以做轮次身份校验绑定） */
  buildTools: (agent: unknown) => Array<Record<string, unknown>>
}

export interface JobResult {
  kind: 'completed' | 'error' | 'timeout' | 'cancelled'
  text: string
  error?: string
}

interface AnyAgent {
  session: { seq: number; id?: string }
  options?: { provider?: string; model?: string }
  followup(message: unknown): unknown
  whenIdle(): Promise<unknown>
  status?: string
  abort?: (reason?: unknown) => unknown
  cancel?: (cause: { kind: 'user' }) => void
  ctx?: any
}

type Log = (level: 'info' | 'warn', message: string) => void
type JobTarget = 'browse' | { rpid: number }
type ModelOverride = { provider: string; model: string; reasoningEffort: string }
type TurnResult = JobResult & { stalledSessionId?: string }

interface JobAgent {
  agent: AnyAgent
  sessionId: string
  dispose?: () => Promise<void>
}

function sessionIdFor(target: JobTarget): string {
  return target === 'browse' ? 'xinyu-browse' : `xinyu-mention-${target.rpid}`
}

export class JobBridge {
  private ctx: any
  private agents: any
  private sessions: any
  private store: Store
  private log: Log
  private presetId: string
  private browseAgent?: JobAgent
  private leases = new Map<string, Promise<JobResult>>()

  constructor(ctx: any, store: Store, presetId: string, log: Log) {
    this.ctx = ctx
    this.agents = ctx.get('agents')
    this.sessions = ctx.get('sessions')
    this.store = store
    this.log = log
    this.presetId = presetId
    if (this.agents === undefined) throw new Error('xinyu-bilibili: profile 未提供 agents 服务')
    if (this.sessions === undefined) throw new Error('xinyu-bilibili: profile 未提供 sessions 服务')
  }

  /** 会话是否被用户在 dsh 界面归档（宿主闸门会静默拒绝其一切模型步）。
   *  workspaceRegistry 未必能从插件作用域解析（懒解析，解析不到就交给死回合兜底）。 */
  private isArchived(sessionId: string): boolean {
    try {
      const ws = this.ctx.get?.('workspaceRegistry') ?? (this.ctx as any).workspaceRegistry
      const archived = ws?.archivedSessionIds
      return Array.isArray(archived) && archived.includes(sessionId)
    } catch { return false }
  }

  busy(kind: 'browse' | 'mention'): boolean {
    if (kind === 'browse') return this.leases.has(sessionIdFor('browse'))
    return [...this.leases.keys()].some((id) => id.startsWith('xinyu-mention-'))
  }

  /** 默认模型：settings.llm 覆盖优先，否则宿主默认。返回 undefined 表示交给宿主默认。 */
  private modelOptions(override: ModelOverride): { provider: string; model: string; reasoningEffort?: string } | undefined {
    if (override.provider && override.model) {
      return { provider: override.provider, model: override.model, ...(override.reasoningEffort ? { reasoningEffort: override.reasoningEffort } : {}) }
    }
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model, ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
    }
    return undefined
  }

  /**
   * 与 headless runner 相同的 cwd 解析：经挂载的 fs 服务取规范绝对路径（异步）。
   * 严格要求 "/" 开头——某些宿主服务的失败路径会返回字符串 "undefined"。
   */
  private async resolveCwd(): Promise<string> {
    const log = (message: string) => { try { this.ctx.get('logger')?.info?.(`xinyu-bilibili: ${message}`) } catch { /* 忽略 */ } }
    try {
      const fs = this.ctx.get('fs')
      if (fs !== undefined) {
        const resolved = await fs.resolve('.')
        const processed = typeof fs.processPath === 'function' ? fs.processPath(resolved) : undefined
        log(`cwd 诊断: fs.resolve=${JSON.stringify(resolved)} processPath=${JSON.stringify(processed)}`)
        if (typeof processed === 'string' && processed.startsWith('/')) return processed
      } else {
        log('cwd 诊断: fs 服务不可用')
      }
    } catch (error) {
      log(`cwd 诊断: fs 失败 ${error instanceof Error ? error.message : String(error)}`)
    }
    const fallback = process.cwd()
    return typeof fallback === 'string' && fallback.startsWith('/') ? fallback : '/root'
  }

  /**
   * 会话恢复次序（与 headless runner 相同）：进程内在实例 → sessionQuery 探测
   * 持久会话（存在才 resume，盲目 resume 会撞 already-exists）→ create。
   * preset 挂载发生在 create 的 setup 里。
   * exclude：本轮明确弃用的会话 id（如死回合检测命中的），按已存在处理绝不复用。
   */
  private async agentFor(target: JobTarget, modelOverride: ModelOverride, exclude?: string): Promise<JobAgent> {
    const isolated = target !== 'browse'
    const derived = sessionIdFor(target)
    const cached = isolated ? undefined : this.browseAgent
    if (cached !== undefined) {
      // 归档/排除检查必须在缓存命中之前：宿主在归档后仍保留进程内 agent，
      // 但其一切 followup 会被 archived-session-gate 静默拒绝（空转）。
      if (exclude !== cached.sessionId && !this.isArchived(cached.sessionId)) return cached
      this.browseAgent = undefined
    }
    const presets = this.ctx.get('agentPresets')
    const saved = isolated
      ? this.store.state.mentionQueue.find((item) => item.rpid === target.rpid)?.replySessionId
      : this.store.state.sessions.browse
    const adopted = typeof saved === 'string' && (!isolated || saved === derived || saved.startsWith(`${derived}-r`))
      ? saved : undefined
    const preferred = isolated ? adopted ?? derived : derived
    const candidates = !isolated && adopted && adopted !== derived ? [adopted, derived] : [preferred]
    const existed = new Set<string>()
    const model = this.modelOptions(modelOverride)

    let agent: AnyAgent | undefined
    let handle: { agent: AnyAgent; dispose?: () => Promise<void> } | undefined
    let usedId = derived
    for (const sessionId of candidates) {
      // 归档/排除的会话照常"存在"（resume 也成功），但永远空转：按已存在
      // 处理、不复用，让下方 create 派生新 id。
      if (exclude === sessionId || this.isArchived(sessionId)) {
        existed.add(sessionId)
        this.log('info', `xinyu-bilibili: 跳过已归档或弃用的会话 ${sessionId}`)
        continue
      }
      try {
        const live = this.agents.get?.(sessionId)
        if (live !== undefined) { agent = live; usedId = sessionId; break }
      } catch { /* get 不可用则跳过 */ }
      const query = this.ctx.get('sessionQuery')
      if (query === undefined) break
      let persisted = false
      try {
        await query.observeSession(sessionId)
        persisted = true
      } catch (error) {
        const message = String((error as any)?.message ?? '')
        const notFound = (error as any)?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || message.includes('SESSION_QUERY_SESSION_NOT_FOUND') || message.toLowerCase().includes('not found')
        if (notFound) continue
        persisted = true
        this.log('warn', `observeSession("${sessionId}") failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!persisted) continue
      existed.add(sessionId)
      try {
        const resumed = await this.agents.resume({ resumeSessionId: sessionId, ...(model ? { agentOptions: model } : {}) })
        agent = resumed?.agent ?? resumed
        handle = resumed
        usedId = sessionId
        break
      } catch (error) {
        this.log('warn', `resume("${sessionId}") failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (agent === undefined) {
      // preset 只对全新会话生效（首轮后锁定）；挂载必须在 create 的 setup 里
      const createId = existed.has(preferred) ? `${derived}-r${randomUUID().slice(0, 8)}` : preferred
      const setup = async (agentCtx: any, createdAgent: AnyAgent) => {
        if (presets !== undefined) {
          try { await presets.mount(agentCtx, this.presetId) }
          catch (error) { throw new Error(`无法挂载会话模式 ${this.presetId}: ${error instanceof Error ? error.message : String(error)}`) }
        }
        this.probeWriteToolNames(agentCtx, createdAgent)
      }
      const created = await this.agents.create({
        sessionId: createId,
        meta: { cwd: await this.resolveCwd() },
        ...(model ? { agentOptions: model } : {}),
        setup,
      })
      agent = created?.agent ?? created
      handle = created
      usedId = createId
      if (presets !== undefined) {
        try { await (presets as any).select(agent, this.presetId) }
        catch (error) { this.log('warn', `select("${this.presetId}") after setup mount failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    if (!agent) throw new Error('宿主未返回任务会话的 Agent')
    const picked: JobAgent = { agent, sessionId: usedId, dispose: isolated ? handle?.dispose?.bind(handle) : undefined }
    try {
      this.store.rememberSession(isolated ? target.rpid : 'browse', usedId)
    } catch (error) {
      await this.release(picked)
      throw error
    }
    if (!isolated) this.browseAgent = picked
    return picked
  }

  private async release(picked: JobAgent) {
    // 提及会话已 flush。释放运行实例，保留可恢复的会话记录。
    try { await picked.dispose?.() }
    catch (error) { this.log('warn', `无法释放会话 ${picked.sessionId}：${error instanceof Error ? error.message : String(error)}`) }
  }

  /**
   * 探测宿主里 MCP 写工具的实际注册名（各宿主可能加前缀），一次即可：
   * 用于确认 restrict deny 名单是否需要修正。探测结果写进日志。
   */
  private probeWriteToolNames(agentCtx: any, agent: AnyAgent) {
    try {
      const tools = agentCtx?.get?.('tools')
      if (!tools?.get) return
      const found: string[] = []
      for (const base of NATIVE_WRITE_TOOLS) {
        for (const prefix of NAME_PREFIXES) {
          const name = `${prefix}${base}`
          try { if (tools.get(name, agent) !== undefined) { found.push(name); break } } catch { /* 不存在 */ }
        }
      }
      this.log('info', `xinyu-bilibili: 会话内可见原生写工具：${found.length > 0 ? found.join(', ') : '（未探测到， restrict 将按运行时名单执行）'}`)
    } catch { /* 探测失败不阻塞 */ }
  }

  /** 同一条评论或同一浏览任务一次只执行一轮，不同评论可并行。 */
  async runJob(target: JobTarget, options: JobTurnOptions, modelOverride: ModelOverride): Promise<JobResult> {
    const key = sessionIdFor(target)
    if (this.leases.has(key)) return { kind: 'error', text: '', error: '该会话已有任务在执行中' }
    const execution = this.runTurn(target, options, modelOverride)
    this.leases.set(key, execution)
    try {
      const result = await execution
      if (!result.stalledSessionId) return result
      this.log('warn', `会话 ${result.stalledSessionId} 未返回正文，使用新会话重试一次`)
      if (target === 'browse') this.forgetBrowseSession()
      return await this.runTurn(target, options, modelOverride, result.stalledSessionId)
    } finally {
      this.leases.delete(key)
    }
  }

  private async runTurn(target: JobTarget, options: JobTurnOptions, modelOverride: ModelOverride, exclude?: string): Promise<TurnResult> {
    let picked: JobAgent
    try {
      picked = await this.agentFor(target, modelOverride, exclude)
    } catch (error) {
      return { kind: 'error', text: '', error: error instanceof Error ? error.message : String(error) }
    }
    const { agent, sessionId } = picked
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const stops: Array<() => void> = []
    let cancelled = false
    let failure: unknown
    let fullText = ''
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      try {
        if (agent.cancel) agent.cancel({ kind: 'user' })
        else Promise.resolve(agent.abort?.('xinyu-bilibili: job timeout')).catch(() => undefined)
      } catch { /* 等真实收尾 */ }
    }
    const onTimeout = () => cancel()
    timeout.addEventListener('abort', onTimeout, { once: true })

    try {
      if (agent.status !== undefined && agent.status !== 'idle') {
        return { kind: 'error', text: '', error: '宿主会话尚未空闲' }
      }
      stops.push(this.ctx.on('agent/assistant-stream', ({ agent: subject, frame }: any) => {
        if (subject !== agent || cancelled) return
        const chunk = frame?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          fullText = (fullText + chunk.text).slice(-64_000)
        }
      }))
      stops.push(this.ctx.on('agent/error', ({ agent: subject, error }: any) => { if (subject === agent && failure === undefined) failure = error }))

      const registry = agent.ctx?.get?.('tools')
      if (!registry?.register) throw new Error('宿主缺少工具注册接口')
      // 第一层屏蔽：作用域级 restrict（本层自有注册不受影响）。deny 名单用
      // 探测过的实际名；失败不阻塞（还有 guard 兜底）。
      const actualNames: string[] = []
      for (const base of NATIVE_WRITE_TOOLS) {
        for (const prefix of NAME_PREFIXES) {
          const name = `${prefix}${base}`
          try { if (registry.get?.(name, agent) !== undefined) { actualNames.push(name); break } } catch { /* 不存在 */ }
        }
      }
      if (actualNames.length > 0) {
        try { stops.push(registry.restrict({ deny: actualNames })) }
        catch (error) { this.log('warn', `restrict deny 失败（guard 兜底仍在）：${error instanceof Error ? error.message : String(error)}`) }
      }
      // 第二层兜底：任何非 xinyu_ 前缀、命中原生写名（含常见前缀形态）一律拒绝。
      stops.push(registry.guard((exec: any) => {
        const name = String(exec?.name ?? '')
        if (name.startsWith('xinyu_')) return undefined
        for (const base of NATIVE_WRITE_TOOLS) {
          if (name === base || name.endsWith(`_${base}`) || name.endsWith(`__${base}`)) {
            return `xinyu-bilibili: 原生写入工具 ${name} 已被闸门停用，请改用 xinyu_* 工具`
          }
        }
        return undefined
      }))
      for (const definition of options.buildTools(agent)) stops.push(registry.register(definition as any))

      // 无人值守会话：审批策略必须 never，否则升权等待会永久挂起。
      const permissionPresets = this.ctx.get('permissionPresets')
      if (permissionPresets?.set !== undefined) {
        try {
          await permissionPresets.set(agent.session, 'danger-full-access')
          if (typeof permissionPresets.current === 'function' && permissionPresets.current(agent.session) !== 'danger-full-access') {
            throw new Error('permission preset did not take effect')
          }
        } catch (error) {
          return { kind: 'error', text: '', error: `无法应用会话权限，未提交任务：${error instanceof Error ? error.message : String(error)}` }
        }
      }

      // UserMessage 是带身份的 durable 值，必须带 UUID（宿主日志恢复校验依赖它）
      const turnStartedAt = Date.now()
      await agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: options.prompt }], source: { kind: 'user' } })
      while (true) {
        await agent.whenIdle()
        if (cancelled) break
        const children = this.ctx.get('subagents')
        const joined = children?.waitForChildren ? await children.waitForChildren(agent) : false
        if (!joined && (agent.status === undefined || agent.status === 'idle')) break
      }
      await this.sessions.flush(agent.session)
      if (timeout.aborted) return { kind: 'timeout', text: fullText, error: `任务超过 ${Math.round(options.timeoutMs / 60000)} 分钟被中止` }
      if (failure !== undefined) return { kind: 'error', text: fullText, error: failure instanceof Error ? failure.message : String(failure) }
      // 死回合检测：followup 秒回且全程零输出 = archived-session-gate 拒绝了
      // 一切模型步（会话被用户归档）或同等失效。workspaceRegistry 可能无法
      // 从插件作用域解析，用行为特征兜底：弃用该会话，开新会话重试一次。
      if (fullText.trim() === '' && Date.now() - turnStartedAt < 60_000) {
        return { kind: 'error', text: '', stalledSessionId: sessionId, error: `会话 ${sessionId} 空转，未返回正文` }
      }
      return { kind: 'completed', text: fullText }
    } catch (error) {
      return { kind: 'error', text: fullText, error: error instanceof Error ? error.message : String(error) }
    } finally {
      timeout.removeEventListener('abort', onTimeout)
      for (const stop of stops.splice(0)) {
        try { await stop() } catch (e) { this.log('warn', `cannot dispose turn contribution: ${e instanceof Error ? e.message : String(e)}`) }
      }
      await this.release(picked)
    }
  }

  /** 释放浏览会话缓存，下次运行时重新探测持久会话。 */
  forgetBrowseSession() {
    this.browseAgent = undefined
    this.store.mutate((state) => { delete state.sessions.browse })
  }
}
