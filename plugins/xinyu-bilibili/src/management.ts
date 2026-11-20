// 管理路由：注册在 dsh 的 authenticated、owner-only 精确 Fetch 传输上
// （复用 dsh 登录态；Host/Origin 检查与 owner 权限全由 dsh 执行）。
// 永远不要注册在无鉴权的 webServer 上。
// 形态精确复刻 yusheng management.ts：单路由 + envelope{path,method,body} + 操作白名单。

import { sanitizeSettings } from './settings.js'
import type { XinyuCore } from './services.js'
import type { Scheduler } from './scheduler.js'

export const MANAGEMENT_PATH = '/api/xinyu/manage'
const LIMIT = 64 * 1024

export interface ModelCatalogEntry { id: string; name: string; efforts?: Array<{ id: string; name: string }> }
export interface XinyuModelCatalog {
  providers: Array<{ id: string; name: string; models: ModelCatalogEntry[] }>
  unavailableProviders: Array<{ id: string; name: string }>
}

interface ManagementDeps {
  core: XinyuCore
  scheduler: Scheduler
  trigger: (kind: 'browse' | 'mention') => { ok: boolean; message: string }
  isMentionReplyRunning?: () => boolean
  resetSession: () => void
  modelCatalog: () => Promise<XinyuModelCatalog>
  version: string
}

function reply(status: number, error: string, message: string) {
  return Response.json({ ok: false, error, message }, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 413 ? { connection: 'close' } : {}) } })
}

/** 动态白名单：/pending/{id}/{approve|reject} 走正则，其余走精确匹配。 */
function knownOperation(method: string, path: string): boolean {
  if (method === 'GET' && ['/status', '/settings', '/pending', '/activity', '/models'].includes(path)) return true
  if (method === 'PUT' && path === '/settings') return true
  if (method === 'POST' && ['/jobs/browse', '/jobs/mention', '/scan', '/sessions/browse/reset', '/sessions/mention/reset', '/diagnostics/login'].includes(path)) return true
  if (method === 'POST' && /^\/pending\/[0-9a-fA-F-]{8,64}\/(approve|reject)$/.test(path)) return true
  return false
}

/** Registered on dsh's authenticated, owner-only exact Fetch transport. Never register on webServer. */
export function registerManagement(ctx: any, deps: ManagementDeps) {
  return ctx.connection.fetch.register({
    path: MANAGEMENT_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: (request: Request) => handleManagement(request, deps),
  })
}

export async function handleManagement(request: Request, deps: ManagementDeps): Promise<Response> {
  if (request.method !== 'POST') return reply(405, 'method_not_allowed', '请使用 POST 请求管理接口。')
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, 'json_required', '管理请求必须使用 JSON。')
  if (Number(request.headers.get('content-length')) > LIMIT) return reply(413, 'too_large', '管理请求过大。')
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      // Cancelling a Node-backed request stream also destroys its response socket.
      // Send the bounded 413 response and close gracefully instead of resetting the connection.
      if (size > LIMIT) return reply(413, 'too_large', '管理请求过大。')
      chunks.push(value)
    }
  } catch { return reply(400, 'bad_body', '无法读取管理请求。') }
  finally { reader?.releaseLock() }
  let envelope: any
  try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { return reply(400, 'bad_json', '管理请求格式不正确。') }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).some(key => !['path', 'method', 'body'].includes(key))) return reply(400, 'bad_request', '管理请求格式不正确。')
  const { path, method, body } = envelope
  if (typeof path !== 'string' || typeof method !== 'string' || !knownOperation(method, path)) return reply(400, 'unsupported_operation', '不支持的管理操作。')
  if ((method === 'GET' || method === 'DELETE') && body !== undefined) return reply(400, 'bad_request', '此操作不接受请求内容。')
  try { return await dispatch(path, method, body, deps) }
  catch (error) { return Response.json({ ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) }, { status: 500, headers: { 'cache-control': 'no-store' } }) }
}

async function dispatch(path: string, method: string, body: any, deps: ManagementDeps): Promise<Response> {
  const { core, scheduler } = deps
  const ok = (data: unknown) => Response.json({ ok: true, ...data as object }, { headers: { 'cache-control': 'no-store' } })

  if (method === 'GET' && path === '/status') {
    const s = core.settings.get()
    const now = new Date()
    core.store.rolloverQuotas(now)
    return ok({
      version: deps.version,
      mode: s.general.mode,
      actions: s.actions,
      quotas: {
        limits: s.quotas,
        used: { share: core.store.quotaUsed('share'), author: core.store.quotaUsed('author'), reply: core.store.quotaUsed('reply'), like: core.store.quotaUsed('like'), coin: core.store.quotaUsed('coin') },
      },
      schedule: {
        ...s.schedule,
        browseRunning: scheduler.isRunning('browse'),
        mentionRunning: scheduler.isRunning('mention') || deps.isMentionReplyRunning?.() === true,
        browseNextDue: scheduler.nextDueAt('browse'),
        mentionNextDue: scheduler.nextDueAt('mention'),
      },
      pendingCount: core.store.loadPending().filter((x) => x.status === 'pending').length,
      mentionQueueSize: core.store.mentionQueueSize(),
      lastJobs: core.store.state.lastJobs.slice(-8),
      sessions: core.store.state.sessions,
      accounts: {
        ownerConfigured: s.accounts.owner.mid > 0 && Boolean(s.accounts.owner.name),
        bot: core.botIdentity(),
        botConfigured: s.accounts.bot.mid > 0,
      },
      lastProbe: core.lastProbe,
    })
  }

  if (method === 'GET' && path === '/settings') {
    return ok({ settings: sanitizeSettings(core.settings.get()) })
  }

  if (method === 'GET' && path === '/models') {
    // 宿主模型目录：供面板下拉选择 job 会话的 provider/model/推理档位。
    const catalog = await deps.modelCatalog()
    return ok(catalog)
  }

  if (method === 'PUT' && path === '/settings') {
    const { settings, rejected } = core.settings.update(body ?? {})
    core.store.appendActivity({ event: 'settings_update', rejected: rejected.slice(0, 20), mode: settings.general.mode })
    return ok({ settings: sanitizeSettings(settings), rejected })
  }

  if (method === 'GET' && path === '/pending') {
    const items = core.store.loadPending()
    const pending = items.filter((x) => x.status === 'pending')
    const decided = items.filter((x) => x.status !== 'pending').slice(-50)
    return ok({ pending, decided })
  }

  if (method === 'POST' && /^\/pending\/[0-9a-fA-F-]{8,64}\/(approve|reject)$/.test(path)) {
    const [, , id, action] = path.split('/')
    if (action === 'approve') {
      const result = await core.approvePending(id)
      return result.ok ? ok({ item: result.item }) : Response.json({ ok: false, error: 'approve_failed', message: result.message }, { status: 409, headers: { 'cache-control': 'no-store' } })
    }
    const result = await core.rejectPending(id)
    return result.ok ? ok({ message: result.message }) : Response.json({ ok: false, error: 'reject_failed', message: result.message }, { status: 404, headers: { 'cache-control': 'no-store' } })
  }

  if (method === 'GET' && path === '/activity') {
    const limit = Math.min(500, Math.max(1, Math.round(Number(body?.limit ?? 100)) || 100))
    return ok({ entries: core.store.readActivity(limit) })
  }

  if (method === 'POST' && path === '/jobs/browse') return ok(deps.trigger('browse'))
  if (method === 'POST' && path === '/jobs/mention') return ok(deps.trigger('mention'))

  if (method === 'POST' && path === '/sessions/browse/reset') {
    deps.resetSession()
    core.store.appendActivity({ event: 'session_reset', kind: 'browse' })
    return ok({ message: 'browse 会话缓存已清除' })
  }

  if (method === 'POST' && path === '/sessions/mention/reset') {
    return ok({ message: '提及回复按原评论独立创建会话' })
  }

  if (method === 'POST' && path === '/diagnostics/login') {
    const result = await core.probeLogin()
    return ok({
      message: result.message,
      configured: Boolean(result.status?.configured),
      writeEnabled: Boolean(result.status?.write_enabled),
      commentEnabled: Boolean(result.status?.comment_enabled),
      detected: result.detected,
    })
  }

  if (method === 'POST' && path === '/scan') {
    // 手动收件和定时任务共用水位与待回复队列。
    const maxVideos = Math.min(20, Math.max(1, Math.round(Number(body?.maxVideos ?? 10)) || 10))
    const { found, items, source } = await core.scanMentionsNow(maxVideos)
    return ok({ found, items: items.slice(0, 20), source })
  }

  return reply(400, 'unsupported_operation', '不支持的管理操作。')
}
