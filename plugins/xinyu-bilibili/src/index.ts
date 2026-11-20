// dsh-xinyu-bilibili —— B 站小号运营宿主插件。
//
// 形态参照 yusheng voice：独立 bundle（cordis.patch.yml insert 本插件行），
// apply() 内注入 profile 核心服务并启动调度器；会话驱动参照官方 headless
// runner 的公开模式（agents/sessions + agent/assistant-stream）。
// 设置持久化在 $DSH_HOME/xinyu-bilibili/settings.json（0600），面板热编辑。
// 管理面走 dsh owner-only Connection Fetch（见 management.ts）。

import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { JobBridge, type JobResult } from './bridge.js'
import { XinyuCore } from './services.js'
import { Scheduler, type JobKind } from './scheduler.js'
import { registerManagement, MANAGEMENT_PATH, type XinyuModelCatalog } from './management.js'
import { xinyuBrowseTools } from './tools-xinyu.js'
import { buildDigest, browsePrompt } from './prompts.js'
import { replyToQueuedMentions } from './mention-replies.js'

const VERSION = '0.1.16'
const CONFIG_KEYS = new Set(['settingsPath'])
const BROWSE_TIMEOUT_MS = 25 * 60_000

export function defaultSettingsPath(): string {
  const home = process.env.DSH_HOME ?? resolve(homedir(), '.dsh')
  return resolve(home, 'xinyu-bilibili', 'settings.json')
}

export default {
  name: 'xinyu-bilibili',
  inject: ['agentDefaultModel', 'llm', 'agents', 'sessions', 'sessionQuery', 'agentPresets', 'permissionPresets'],
  apply(root: any, config: any) {
    // 配置行没有 config 字段时宿主可能传 null/undefined，不能直接 Object.keys
    const cfg = (config !== null && typeof config === 'object') ? config : {}
    const unknown = Object.keys(cfg).filter((key) => !CONFIG_KEYS.has(key))
    if (unknown.length > 0) {
      throw new Error(`xinyu-bilibili: unknown config fields: ${unknown.join(', ')}`)
    }
    const settingsPath = typeof cfg.settingsPath === 'string' && cfg.settingsPath !== '' ? cfg.settingsPath : defaultSettingsPath()

    const log = (level: 'info' | 'warn', message: string) => {
      try {
        if (typeof root.logger?.[level] === 'function') root.logger[level](`xinyu-bilibili: ${message}`)
        else console[level](`xinyu-bilibili: ${message}`)
      } catch { /* logger 不可用时静默 */ }
    }

    let core: XinyuCore
    try {
      core = new XinyuCore(settingsPath, resolve(settingsPath, '..'), log)
    } catch (error) {
      // 设置/状态文件损坏：拒绝启动而不是带病运营（避免状态丢失导致超发）
      throw new Error(`xinyu-bilibili: 本地存储不可用，插件拒绝启动：${error instanceof Error ? error.message : String(error)}`)
    }
    const bridge = new JobBridge(root, core.store, 'xinyu-operator', log)
    const activeMentions = new Set<number>()
    let disposed = false

    // ---- job 实现 ----

    const runBrowseJob = async (trigger: 'schedule' | 'manual'): Promise<void> => {
      const startedAt = new Date().toISOString()
      core.store.beginJob({ kind: 'browse', trigger, startedAt, status: 'running' })
      try {
        const s = core.settings.get()
        if (s.general.mode === 'off') throw new Error('运营总开关为 off')
        if (s.safety.cookieProbe) {
          const probe = await core.probeLogin()
          if (!probe.ok) throw new Error(`cookie 探活未通过：${probe.message}`)
        }
        const now = new Date()
        const prompt = browsePrompt(s, buildDigest(s, core.store, now), now)
        const result = await bridge.runJob('browse', {
          prompt,
          timeoutMs: BROWSE_TIMEOUT_MS,
          buildTools: (agent) => xinyuBrowseTools(core, agent),
        }, s.llm)
        const summary = extractSummary(result)
        core.store.endJob('browse', startedAt, result.kind === 'completed' ? 'ok' : result.kind === 'timeout' ? 'timeout' : 'error', summary, result.error)
        core.store.appendActivity({ event: 'job_done', kind: 'browse', trigger, outcome: result.kind, summary: summary?.slice(0, 800), error: result.error })
        log(result.kind === 'completed' ? 'info' : 'warn', `browse job ${result.kind}${result.error ? `：${result.error}` : ''}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        core.store.endJob('browse', startedAt, 'error', undefined, message)
        core.store.appendActivity({ event: 'job_error', kind: 'browse', trigger, error: message })
        log('warn', `browse job 失败：${message}`)
      }
    }

    const failMentionJob = (trigger: 'schedule' | 'manual', startedAt: string, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      core.store.endJob('mention', startedAt, 'error', undefined, message)
      core.store.appendActivity({ event: 'job_error', kind: 'mention', trigger, error: message })
      log('warn', `mention job 失败：${message}`)
    }

    const runMentionJob = async (trigger: 'schedule' | 'manual'): Promise<void> => {
      const startedAt = new Date().toISOString()
      core.store.beginJob({ kind: 'mention', trigger, startedAt, status: 'running' })
      try {
        const s = core.settings.get()
        if (s.general.mode === 'off') throw new Error('运营总开关为 off')
        const { found, source } = await core.scanMentionsNow()
        const intakeSummary = `${source === 'notifications' ? '消息中心' : '评论扫描'}新增 ${found} 条`
        const queued = core.store.mentionQueueSize()
        const settings = core.settings.get()
        if (queued === 0 || activeMentions.size >= settings.schedule.mentionConcurrency || disposed) {
          const summary = `${intakeSummary}。队列余 ${queued} 条`
          core.store.endJob('mention', startedAt, 'ok', summary)
          if (trigger === 'manual' || found > 0) {
            core.store.appendActivity({ event: 'job_done', kind: 'mention', trigger, outcome: 'ok', source, found, summary })
          }
          return
        }

        // 起草占用回复槽位，轮询继续收件。多个收件轮次共享原评论 ID 和并发上限。
        void (async () => {
          try {
            const result = await replyToQueuedMentions(core, bridge, settings, { active: activeMentions, stopped: () => disposed })
            const summary = [
              intakeSummary,
              `已回复 ${result.posted} 条，待审 ${result.queued} 条，队列余 ${core.store.mentionQueueSize()} 条`,
              result.waiting,
              result.retry ? `${result.retry} 条稍后重试` : '',
            ].filter(Boolean).join('。')
            const status = result.timeout ? 'timeout' : result.error ? 'error' : 'ok'
            core.store.endJob('mention', startedAt, status, summary, result.error)
            if (trigger === 'manual' || found > 0 || result.posted || result.queued || result.retry || status !== 'ok') {
              core.store.appendActivity({ event: 'job_done', kind: 'mention', trigger, outcome: status, source, found, ...result, summary })
              log(status === 'ok' ? 'info' : 'warn', `mention job ${status}：${summary}`)
            }
          } catch (error) {
            failMentionJob(trigger, startedAt, error)
          }
        })().catch((error) => log('warn', `记录提及任务失败：${error instanceof Error ? error.message : String(error)}`))
      } catch (error) {
        failMentionJob(trigger, startedAt, error)
      }
    }

    const scheduler = new Scheduler({
      getSettings: () => core.settings.get(),
      store: core.store,
      run: (kind: JobKind, trigger) => kind === 'browse' ? runBrowseJob(trigger) : runMentionJob(trigger),
      log,
    })

    // 宿主模型目录（面板「模型选择」下拉的数据源）：与 yusheng 同款，
    // 走运行中 dsh 的 llm 服务公开接口，只输出模型名/id/推理档位，不含凭据。
    const modelCatalog = async (): Promise<XinyuModelCatalog> => {
      const llm = root.get('llm')
      if (!llm?.listProviders || !llm?.listModels) return { providers: [], unavailableProviders: [] }
      const groups = await Promise.all(llm.listProviders().map(async (provider: any) => {
        const identity = { id: String(provider.id), name: typeof provider.name === 'string' ? provider.name : String(provider.id) }
        try {
          const advertised = await llm.listModels(provider.id)
          const models = await Promise.all((advertised ?? []).map(async (model: any) => {
            let info: any
            try { info = await llm.resolveModelInfo?.(provider.id, model.id) } catch { info = undefined }
            const reasoning = info?.reasoning
            return {
              id: String(model.id),
              name: typeof model.name === 'string' ? model.name : String(model.id),
              ...(reasoning?.efforts ? { efforts: reasoning.efforts.map((effort: any) => ({ id: String(effort.id), name: String(effort.name) })) } : {}),
            }
          }))
          return { provider: { ...identity, models } }
        } catch { return { unavailable: identity } }
      }))
      return {
        providers: groups.flatMap((g: any) => (g.provider ? [g.provider] : [])),
        unavailableProviders: groups.flatMap((g: any) => (g.unavailable ? [g.unavailable] : [])),
      }
    }

    root.inject?.(['connection'], (ctx: any) => {
      ctx.effect(() => registerManagement(ctx, {
        core, scheduler,
        trigger: (kind) => scheduler.trigger(kind),
        isMentionReplyRunning: () => activeMentions.size > 0,
        resetSession: () => bridge.forgetBrowseSession(),
        modelCatalog,
        version: VERSION,
      }), 'xinyu-bilibili: authenticated management')
    })

    root.effect(() => () => { disposed = true; scheduler.stop() }, 'xinyu-bilibili: scheduler')
    scheduler.start()
    log('info', `管理接口 ${MANAGEMENT_PATH} 已注册；设置文件 ${settingsPath}`)
  },
}

/** 从 job 收敛文本里提取最后的 ```json 块作为摘要。 */
function extractSummary(result: JobResult): string | undefined {
  const text = result.text ?? ''
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  const last = matches[matches.length - 1]
  if (last) return last[1].trim().slice(0, 4000)
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed.slice(-2000) : undefined
}

// 供本地测试与工具脚本复用的导出
export { XinyuCore, XinyuGuardError } from './services.js'
export { JobBridge } from './bridge.js'
export { Scheduler } from './scheduler.js'
export * from './settings.js'
export { evaluateGuard, inQuietHours, todayKey } from './guard.js'
export { Store, emptyState } from './store.js'
export { WeiyuMcp, McpToolError } from './mcp.js'
export { scanVideo, scanMentions } from './scan.js'
export { xinyuTools, xinyuBrowseTools, defaultClassifyComment } from './tools-xinyu.js'
export { readMentionFeed } from './notifications.js'
export { replyToQueuedMentions } from './mention-replies.js'
export { handleManagement, registerManagement, MANAGEMENT_PATH } from './management.js'
export { buildDigest, browsePrompt, replyPrompt, personaBlock } from './prompts.js'
