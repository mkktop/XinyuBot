// 新雨机器人 设置面板（浏览器半边主体）。
// 通信走 dsh 的 owner-only Connection Fetch（POST envelope，复用登录态）。
// 五区：状态 / 待审批 / 设置 / 活动日志 / 维护。8s 轮询状态与待审批。

import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { ActionKind, RunMode, XinyuSettings } from '../settings.js'
import type { JobRecord, PendingItem } from '../store.js'
import css from './panel.css'

const MANAGE_URL = new URL('api/xinyu/manage', document.baseURI).href

async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(MANAGE_URL, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, method, ...(body === undefined ? {} : { body }) }),
    signal: AbortSignal.timeout(65000),
  })
  if (response.status === 401) throw new Error('dsh 登录已失效，请重新登录 dsh 后重试。')
  if (response.status === 403) throw new Error('当前 dsh 登录无管理权限。')
  const data: any = await response.json().catch(() => { throw new Error(`无法读取管理接口（HTTP ${response.status}）`) })
  if (!response.ok || data?.ok === false) throw new Error(data?.message ?? data?.error ?? `请求失败（${response.status}）`)
  return data
}

type Tab = 'status' | 'pending' | 'settings' | 'activity' | 'ops'
interface Notice { tone: 'success' | 'error' | 'info'; text: string }

type ListField = 'keywords' | 'blockedWords'
type ActivityEntry = Record<string, unknown>
interface PanelStatus {
  mode: RunMode
  mentionQueueSize: number
  quotas: { limits: XinyuSettings['quotas']; used: Record<ActionKind, number> }
  schedule: XinyuSettings['schedule'] & {
    browseRunning: boolean; mentionRunning: boolean; browseNextDue?: string; mentionNextDue?: string
  }
  lastJobs: JobRecord[]
  sessions: { browse?: string; mention?: string }
  accounts: { ownerConfigured: boolean; bot: { mid: number; name: string } }
  lastProbe: { at: string; result: { ok: boolean; message: string } } | null
}

/** 宿主模型目录（GET /models）：面板「连接与模型」下拉的数据源。 */
interface ModelCatalog {
  providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; efforts?: Array<{ id: string; name: string }> }> }>
  unavailableProviders: Array<{ id: string; name: string }>
}

const TABS: Array<[Tab, string]> = [
  ['status', '概览'], ['pending', '待审批'], ['settings', '设置'], ['activity', '活动日志'], ['ops', '维护'],
]
const KIND_LABEL: Record<string, string> = { share: '@大号分享', author: '作者评论', reply: '回复提及', like: '点赞', coin: '投币' }
const MODE_LABEL: Record<RunMode, string> = { auto: '全自动', dry_run: '审批制', off: '已停用' }
const JOB_LABEL = { ok: '已完成', error: '失败', timeout: '超时', running: '执行中' }
const PENDING_LABEL = { pending: '待审批', approved: '已批准', rejected: '已拒绝', posted: '已发布', failed: '执行失败' }
const EVENT_LABEL: Record<string, string> = {
  settings_update: '更新设置', session_reset: '重置会话', scan_video_error: '视频扫描失败',
  notifications_error: '收件失败', notifications_unreplyable: '无法在原评论下回复',
  mention_reply_error: '回复稍后重试', mention_reply_skipped: '回复已跳过',
  job_done: '任务结束', job_error: '任务失败', pending_added: '新增审批', pending_update: '审批更新',
  mentions_queued: '提及入队', mention_dropped: '提及已丢弃', guard_reject: '操作已拦截',
  posted: '动作已执行', agent_note: '机器人备注', corrupt_line: '日志解析失败',
}

function useStyle() {
  useEffect(() => {
    const element = document.createElement('style')
    element.textContent = css
    document.head.appendChild(element)
    return () => { element.remove() }
  }, [])
}

function setIn(obj: any, path: string[], value: unknown) {
  const clone = structuredClone(obj)
  let cursor = clone
  for (let i = 0; i < path.length - 1; i += 1) cursor = cursor[path[i]]
  cursor[path[path.length - 1]] = value
  return clone
}

function getIn(obj: any, path: string[]): any {
  return path.reduce((cursor, key) => cursor?.[key], obj)
}

function TextField({ label, path, form, onChange, type = 'text', placeholder }: { label: string; path: string[]; form: any; onChange: (path: string[], value: unknown) => void; type?: string; placeholder?: string }) {
  const id = useId()
  return (
    <div className="xy-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="xy-input" type={type} value={String(getIn(form, path) ?? '')} placeholder={placeholder}
        onChange={(e) => onChange(path, type === 'number' ? Number(e.target.value) : e.target.value)} />
    </div>
  )
}

function CheckField({ label, path, form, onChange }: { label: string; path: string[]; form: any; onChange: (path: string[], value: unknown) => void }) {
  return (
    <label className="xy-check">
      <input type="checkbox" checked={Boolean(getIn(form, path))} onChange={(e) => onChange(path, e.target.checked)} />
      {label}
    </label>
  )
}

function AreaField({ label, path, form, onChange, rows = 3 }: { label: string; path: string[]; form: any; onChange: (path: string[], value: unknown) => void; rows?: number }) {
  const id = useId()
  return (
    <div className="xy-field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} className="xy-textarea" rows={rows} value={String(getIn(form, path) ?? '')} onChange={(e) => onChange(path, e.target.value)} />
    </div>
  )
}

export function XinyuPanel() {
  useStyle()
  const contentId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<Tab>('status')
  const [status, setStatus] = useState<PanelStatus | null>(null)
  const [form, setForm] = useState<XinyuSettings | null>(null)
  const [pending, setPending] = useState<PendingItem[]>([])
  const [decided, setDecided] = useState<PendingItem[]>([])
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  const [processing, setProcessing] = useState<Record<string, 'approve' | 'reject'>>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [listDrafts, setListDrafts] = useState<Partial<Record<ListField, string>>>({})
  const [models, setModels] = useState<ModelCatalog | null>(null)
  const alive = useRef(true)
  const savedForm = useRef<XinyuSettings | null>(null)
  const editState = useRef({ dirty: false, revision: 0 })
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const refreshRequest = useRef(0)
  const refreshInFlight = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      refreshRequest.current += 1
      refreshInFlight.current = false
      clearTimeout(noticeTimer.current)
    }
  }, [])

  function update(path: string[], value: unknown) {
    editState.current = { dirty: true, revision: editState.current.revision + 1 }
    setDirty(true)
    setForm((current) => setIn(current, path, value))
  }

  function updateList(field: ListField, value: string) {
    setListDrafts((current) => ({ ...current, [field]: value }))
    update([field === 'keywords' ? 'content' : 'safety', field], value.split(/[,，]/).map((word) => word.trim()).filter(Boolean))
  }

  async function refreshQuiet(force = false) {
    if (refreshInFlight.current && !force) return
    refreshInFlight.current = true
    const request = ++refreshRequest.current
    const formRevision = editState.current.revision
    if (force) setRefreshing(true)
    try {
      const [state, settings, queue] = await Promise.all([api('/status'), api('/settings'), api('/pending')])
      if (!alive.current || refreshRequest.current !== request) return
      setStatus(state)
      if (editState.current.revision === formRevision) {
        savedForm.current = settings.settings
        if (!editState.current.dirty) setForm(settings.settings)
      }
      setPending(queue.pending ?? [])
      setDecided(queue.decided ?? [])
      setError('')
    } catch (e) {
      if (alive.current && refreshRequest.current === request) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (alive.current && refreshRequest.current === request) {
        refreshInFlight.current = false
        setRefreshing(false)
      }
    }
  }

  useEffect(() => {
    void refreshQuiet()
    const timer = setInterval(() => void refreshQuiet(), 8000)
    return () => clearInterval(timer)
  }, [])

  // 宿主模型目录：挂载时拉一次（静态数据，轮询不刷新；失败则下拉降级为空目录）
  useEffect(() => {
    void (async () => {
      try { const data = await api('/models'); if (alive.current) setModels(data) } catch { /* 保持 null，下拉显示"目录不可用" */ }
    })()
  }, [])

  function notify(tone: Notice['tone'], text: string) {
    if (!alive.current) return
    setNotice({ tone, text })
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 6000)
  }

  async function run(label: string, fn: () => Promise<string>) {
    try {
      notify('success', `${label}：${await fn()}`)
      if (alive.current) void refreshQuiet(true)
    }
    catch (e) { notify('error', `${label}失败：${e instanceof Error ? e.message : String(e)}`) }
  }

  async function saveSettings() {
    setSaving(true)
    const revision = editState.current.revision
    try {
      const result = await api('/settings', 'PUT', form)
      if (!alive.current) return
      savedForm.current = result.settings
      if (editState.current.revision === revision) {
        editState.current = { dirty: false, revision: revision + 1 }
        setDirty(false)
        setForm(result.settings)
        setListDrafts({})
      }
      void refreshQuiet(true)
      const rejected: string[] = result.rejected ?? []
      notify(rejected.length > 0 ? 'error' : 'success', rejected.length > 0 ? `已保存，但以下字段不认识被忽略：${rejected.join('、')}` : '设置已保存，立即生效')
    } catch (e) { notify('error', `保存失败：${e instanceof Error ? e.message : String(e)}`) }
    finally { if (alive.current) setSaving(false) }
  }

  function discardEdits() {
    editState.current = { dirty: false, revision: editState.current.revision + 1 }
    setDirty(false)
    setListDrafts({})
    setForm(savedForm.current)
    void refreshQuiet(true)
  }

  async function decide(item: PendingItem, action: 'approve' | 'reject') {
    const label = action === 'approve' ? '批准发布' : '拒绝'
    setProcessing((current) => ({ ...current, [item.id]: action }))
    try {
      const result = await api(`/pending/${item.id}/${action}`, 'POST', {})
      if (!alive.current) return
      setPending((current) => current.filter(({ id }) => id !== item.id))
      notify('success', `${label}：${result.message ?? '已发布'}`)
      void refreshQuiet(true)
    } catch (e) {
      notify('error', `${label}失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (alive.current) setProcessing(({ [item.id]: _, ...remaining }) => remaining)
    }
  }

  async function loadActivity() {
    setActivityLoading(true)
    try {
      const data = await api('/activity')
      if (alive.current) setActivity([...(data.entries ?? [])].reverse())
    } catch (e) {
      notify('error', `加载日志失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (alive.current) setActivityLoading(false)
    }
  }

  function openTab(next: Tab) {
    if (next === tab) return
    setTab(next)
    scrollRef.current?.scrollTo(0, 0)
  }

  const tabLabel = TABS.find(([key]) => key === tab)?.[1]

  return (
    <div className="xy-root" ref={scrollRef}>
      <div className="xy-shell">
        <header className="xy-header">
          <div className="xy-header-text">
            <div className="xy-caption">B 站运营管理</div>
            <h1>新雨机器人</h1>
          </div>
          <button type="button" className="xy-btn" disabled={refreshing} onClick={() => void refreshQuiet(true)}>
            {refreshing ? '刷新中…' : '刷新状态'}
          </button>
        </header>

        <div className="xy-summary">
          <div className="xy-metric">
            <span>运营模式</span>
            <strong className="xy-mode" data-tone={status?.mode}>
              {status ? MODE_LABEL[status.mode] ?? status.mode : '—'}
            </strong>
          </div>
          <button type="button" className="xy-metric xy-metric-link" aria-controls={contentId} onClick={() => openTab('pending')}>
            <span>待审批</span><strong>{status ? pending.length : '—'}</strong>
          </button>
          <div className="xy-metric">
            <span>提及队列</span><strong>{status?.mentionQueueSize ?? '—'}</strong>
          </div>
          <div className="xy-metric">
            <span>运营小号</span><strong className="xy-account-name">{status?.accounts?.bot?.name || (status ? '未知' : '—')}</strong>
          </div>
        </div>

        <nav className="xy-tabs" aria-label="新雨机器人面板">
          {TABS.map(([key, label]) => (
            <button type="button" key={key} className="xy-tab" aria-current={tab === key ? 'page' : undefined}
              aria-controls={contentId} onClick={() => openTab(key)}>
              {label}
              {key === 'pending' && pending.length > 0 && <span className="xy-count">{pending.length}</span>}
            </button>
          ))}
        </nav>

        <div className="xy-feedback">
          {error && <div className="xy-notice" data-tone="error" role="alert">{error}（系统会自动重试）</div>}
          {notice && <div className="xy-notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
        </div>

        <div id={contentId} className="xy-content" role="region" aria-label={tabLabel}>
          {(tab === 'status' || tab === 'pending' || tab === 'settings') && !status && (
            <div className="xy-card xy-empty" role="status">{error ? '暂时无法加载面板数据。' : '正在加载面板数据…'}</div>
          )}

          {tab === 'status' && status && <Overview status={status} />}

          {tab === 'pending' && status && (
            <>
              <section className="xy-card">
                <h2>待审批（{pending.length}）</h2>
                <p className="xy-desc">批准后立即执行相应的 B 站操作。拒绝后丢弃该草稿。</p>
                {pending.map((item) => (
                  <div className="xy-item" key={item.id}>
                    <div className="xy-row xy-between">
                      <strong>{KIND_LABEL[item.kind] ?? item.kind} <span className="xy-meta">· {item.bvid}</span></strong>
                      <span className="xy-meta">{fmtTime(item.createdAt)}</span>
                    </div>
                    {item.message && <div className="xy-msg">{item.message}</div>}
                    {item.multiply !== undefined && <div className="xy-msg">投币 {item.multiply} 枚</div>}
                    <div className="xy-meta">理由：{item.reason}</div>
                    <div className="xy-actions">
                      <button className="xy-btn" data-primary="true" disabled={Boolean(processing[item.id])}
                        onClick={() => void decide(item, 'approve')}>{processing[item.id] === 'approve' ? '发布中…' : '批准发布'}</button>
                      <button className="xy-btn" data-danger="true" disabled={Boolean(processing[item.id])}
                        onClick={() => void decide(item, 'reject')}>{processing[item.id] === 'reject' ? '拒绝中…' : '拒绝'}</button>
                      <a className="xy-btn" href={`https://www.bilibili.com/video/${item.bvid}`} target="_blank" rel="noreferrer">打开视频</a>
                    </div>
                  </div>
                ))}
                {pending.length === 0 && <div className="xy-empty">暂无待审批事项</div>}
              </section>
              {decided.length > 0 && (
                <section className="xy-card">
                  <h2>最近已处理（{decided.length}）</h2>
                  {decided.slice().reverse().map((item) => (
                    <div className="xy-item" key={item.id}>
                      <div className="xy-row xy-between">
                        <span>{KIND_LABEL[item.kind] ?? item.kind} · {item.bvid}</span>
                        <span className="xy-badge" data-tone={item.status === 'failed' ? 'error' : item.status === 'posted' ? 'success' : undefined}>
                          {PENDING_LABEL[item.status] ?? item.status}
                        </span>
                      </div>
                      {item.rpid ? <span className="xy-meta">rpid {item.rpid}</span> : null}
                      {item.error && <div className="xy-msg xy-error">{item.error}</div>}
                    </div>
                  ))}
                </section>
              )}
            </>
          )}

          {tab === 'settings' && form && (
            <SettingsPanel form={form} listDrafts={listDrafts} dirty={dirty} saving={saving} update={update}
              updateList={updateList} onSave={() => void saveSettings()} onDiscard={discardEdits} models={models} />
          )}

          {tab === 'activity' && (
            <section className="xy-card">
              <div className="xy-row xy-between">
                <div className="xy-card-heading">
                  <h2>活动日志</h2>
                  <p className="xy-desc">{activity ? `已加载 ${activity.length} 条 · 最新在前` : '最多加载最近 100 条'}</p>
                </div>
                <button className="xy-btn" disabled={activityLoading} onClick={() => void loadActivity()}>
                  {activityLoading ? '加载中…' : activity ? '刷新日志' : '加载日志'}
                </button>
              </div>
              <div className="xy-log" aria-busy={activityLoading}>
                {activity?.map((entry, i) => {
                  const event = String(entry?.event ?? '')
                  return (
                    <details className="xy-item xy-log-entry" key={`${entry?.ts}-${event}-${i}`}>
                      <summary className="xy-row">
                        <strong>{EVENT_LABEL[event] ?? (event || '未命名事件')}</strong>
                        {typeof entry?.bvid === 'string' && <span className="xy-meta">{entry.bvid}</span>}
                        <span className="xy-meta xy-log-time">{fmtTime(typeof entry?.ts === 'string' ? entry.ts : undefined)}</span>
                      </summary>
                      <pre>{JSON.stringify(entry, null, 2)}</pre>
                    </details>
                  )
                })}
                {!activity?.length && <div className="xy-empty">{activityLoading ? '正在加载日志…' : activity ? '暂无活动日志' : '点击「加载日志」查看审计记录。'}</div>}
              </div>
            </section>
          )}

          {tab === 'ops' && (
            <Fragment>
              <section className="xy-card">
                <h2>手动触发</h2>
                <div className="xy-actions">
                  <button className="xy-btn" data-primary="true" onClick={() => void run('触发刷B站', async () => (await api('/jobs/browse', 'POST', {})).message)}>刷B站（browse）</button>
                  <button className="xy-btn" data-primary="true" onClick={() => void run('收取并回复提及', async () => (await api('/jobs/mention', 'POST', {})).message)}>收件并回复</button>
                  <button className="xy-btn" onClick={() => void run('仅收件', async () => { const r = await api('/scan', 'POST', {}); return `新增 ${r.found} 条` })}>仅收件</button>
                </div>
              </section>
              <section className="xy-card">
                <h2>登录诊断</h2>
                <div className="xy-actions">
                  <button className="xy-btn" onClick={() => void run('登录诊断', async () => { const r = await api('/diagnostics/login', 'POST', {}); return `${r.message}（写:${r.writeEnabled ? '开' : '关'} 评论:${r.commentEnabled ? '开' : '关'}）` })}>B 站登录探活</button>
                </div>
              </section>
              <section className="xy-card">
                <h2>浏览会话</h2>
                <div className="xy-actions">
                  <button className="xy-btn" onClick={() => void run('清除浏览会话缓存', async () => (await api('/sessions/browse/reset', 'POST', {})).message)}>清除浏览会话缓存</button>
                </div>
              </section>
            </Fragment>
          )}
        </div>
      </div>
    </div>
  )
}

/** LLM 模型选择：从宿主模型目录（GET /models）级联下拉 provider → model → 推理档位。
 *  空值 = 跟随宿主默认；当前值不在目录里时保留为兜底 option（不丢已保存配置）。 */
function ModelFields({ form, update, models }: {
  form: XinyuSettings
  update: (path: string[], value: unknown) => void
  models: ModelCatalog | null
}) {
  const providerId = useId()
  const modelId = useId()
  const effortId = useId()
  const provider = form.llm?.provider ?? ''
  const model = form.llm?.model ?? ''
  const effort = form.llm?.reasoningEffort ?? ''
  const providers = models?.providers ?? []
  const currentProvider = providers.find((p) => p.id === provider)
  const currentModel = currentProvider?.models.find((m) => m.id === model)
  const efforts = currentModel?.efforts ?? []

  function changeProvider(next: string) {
    update(['llm', 'provider'], next)
    // 切换/清空 provider 后，原 model 不一定属于新 provider：不归属就一并清空
    const target = providers.find((p) => p.id === next)
    if (!next || (target && !target.models.some((m) => m.id === model))) {
      update(['llm', 'model'], '')
      update(['llm', 'reasoningEffort'], '')
    }
  }

  return (
    <div className="xy-grid2">
      <div className="xy-field">
        <label htmlFor={providerId}>对话模型 provider（空=宿主默认）</label>
        <select id={providerId} className="xy-select" value={provider} onChange={(e) => changeProvider(e.target.value)}>
          <option value="">跟随宿主默认</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          {provider && !providers.some((p) => p.id === provider) && <option value={provider}>{provider}（目录中无此 provider）</option>}
          {models === null && <option value="" disabled>（模型目录加载中/不可用）</option>}
        </select>
      </div>
      <div className="xy-field">
        <label htmlFor={modelId}>模型</label>
        <select id={modelId} className="xy-select" value={model} disabled={!provider}
          onChange={(e) => { update(['llm', 'model'], e.target.value); update(['llm', 'reasoningEffort'], '') }}>
          {!provider && <option value="">（跟随宿主默认）</option>}
          {provider && !model && <option value="">（provider 默认模型）</option>}
          {(currentProvider?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          {provider && model && !currentProvider?.models.some((m) => m.id === model) && <option value={model}>{model}（目录中无此模型）</option>}
        </select>
      </div>
      <div className="xy-field">
        <label htmlFor={effortId}>推理强度</label>
        <select id={effortId} className="xy-select" value={effort} disabled={efforts.length === 0}
          onChange={(e) => update(['llm', 'reasoningEffort'], e.target.value)}>
          <option value="">{efforts.length === 0 ? '（默认）' : '默认'}</option>
          {efforts.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          {effort && !efforts.some((x) => x.id === effort) && <option value={effort}>{effort}（自定义）</option>}
        </select>
      </div>
    </div>
  )
}

function SettingsPanel({ form, listDrafts, dirty, saving, update, updateList, onSave, onDiscard, models }: {
  form: XinyuSettings
  listDrafts: Partial<Record<ListField, string>>
  dirty: boolean
  saving: boolean
  update: (path: string[], value: unknown) => void
  updateList: (field: ListField, value: string) => void
  onSave: () => void
  onDiscard: () => void
  models: ModelCatalog | null
}) {
  const modeId = useId()
  const keywordsId = useId()
  const blockedWordsId = useId()

  return (
    <div className="xy-settings">
      <div className="xy-card-heading">
        <h2>运营设置</h2>
        <p className="xy-desc">保存后立即生效</p>
      </div>
      <fieldset className="xy-settings-fields" aria-label="运营设置" disabled={saving}>
        <section className="xy-card">
          <h3>运营模式</h3>
          <div className="xy-field xy-mode-field">
            <label htmlFor={modeId}>运行方式</label>
            <select id={modeId} className="xy-select" value={form.general?.mode ?? 'dry_run'} onChange={(e) => update(['general', 'mode'], e.target.value)}>
              <option value="off">off — 全部停用</option>
              <option value="dry_run">dry_run — 审批制（公开发言进待审队列）</option>
              <option value="auto">auto — 全自动（无需审批的动作直接发布）</option>
            </select>
          </div>
        </section>
        <section className="xy-card">
          <h3>动作开关</h3>
          {(form.general?.mode ?? 'dry_run') === 'dry_run' && (
            <p className="xy-desc">审批制模式下所有公开发言都会进入待审队列；「需要审批」只在 auto（全自动）模式下生效。</p>
          )}
          <div className="xy-action-grid">
            {(['share', 'author', 'reply', 'like', 'coin'] as const).map((kind) => (
              <div className="xy-item" role="group" aria-label={KIND_LABEL[kind]} key={kind}>
                <strong>{KIND_LABEL[kind]}</strong>
                <CheckField label="启用" path={['actions', kind, 'enabled']} form={form} onChange={update} />
                <span title={(form.general?.mode ?? 'dry_run') === 'dry_run' ? '审批制模式下该选项不生效，所有发言都进待审队列' : '勾选后该动作即使在全自动模式下也先进入待审队列'}>
                  <CheckField label={form.general?.mode === 'dry_run' ? '需要审批（dry_run 下不生效）' : '需要审批'} path={['actions', kind, 'approval']} form={form} onChange={update} />
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="xy-card">
          <h3>每日配额</h3>
          <div className="xy-grid2">
            <TextField label="@大号分享/天" path={['quotas', 'sharePerDay']} form={form} type="number" onChange={update} />
            <TextField label="作者评论/天" path={['quotas', 'authorPerDay']} form={form} type="number" onChange={update} />
            <TextField label="回复/天" path={['quotas', 'replyPerDay']} form={form} type="number" onChange={update} />
            <TextField label="点赞/天" path={['quotas', 'likePerDay']} form={form} type="number" onChange={update} />
            <TextField label="投币/天" path={['quotas', 'coinPerDay']} form={form} type="number" onChange={update} />
            <TextField label="单视频评论上限" path={['quotas', 'maxCommentsPerVideo']} form={form} type="number" onChange={update} />
            <TextField label="单线程回复上限" path={['quotas', 'maxRepliesPerThread']} form={form} type="number" onChange={update} />
            <TextField label="发言最小间隔（分钟）" path={['quotas', 'minPostIntervalMin']} form={form} type="number" onChange={update} />
          </div>
        </section>
        <section className="xy-card">
          <h3>调度</h3>
          <div className="xy-grid2">
            <CheckField label="启用刷B站任务" path={['schedule', 'browseEnabled']} form={form} onChange={update} />
            <TextField label="刷B站间隔（分钟）" path={['schedule', 'browseIntervalMin']} form={form} type="number" onChange={update} />
            <CheckField label="定时收件并回复" path={['schedule', 'mentionEnabled']} form={form} onChange={update} />
            <TextField label="收件间隔（分钟）" path={['schedule', 'mentionIntervalMin']} form={form} type="number" onChange={update} />
            <TextField label="收件最大抖动（秒）" path={['schedule', 'mentionJitterSec']} form={form} type="number" onChange={update} />
            <TextField label="回复并发数（1–10）" path={['schedule', 'mentionConcurrency']} form={form} type="number" onChange={update} />
            <TextField label="刷 B 站最大抖动（分钟）" path={['schedule', 'jitterMin']} form={form} type="number" onChange={update} />
            <TextField label="发言静默开始（HH:MM）" path={['schedule', 'quietFrom']} form={form} onChange={update} />
            <TextField label="发言静默结束（HH:MM）" path={['schedule', 'quietTo']} form={form} onChange={update} />
          </div>
        </section>
        <section className="xy-card">
          <h3>内容方向</h3>
          <div className="xy-field">
            <label htmlFor={keywordsId}>兴趣关键词（逗号分隔）</label>
            <input id={keywordsId} className="xy-input" value={listDrafts.keywords ?? (form.content?.keywords ?? []).join('，')}
              onChange={(e) => updateList('keywords', e.target.value)} />
          </div>
          <div className="xy-row">
            <CheckField label="推荐流" path={['content', 'sources', 'recommend']} form={form} onChange={update} />
            <CheckField label="关注动态" path={['content', 'sources', 'dynamicFeed']} form={form} onChange={update} />
            <CheckField label="排行榜/分区" path={['content', 'sources', 'ranking']} form={form} onChange={update} />
            <CheckField label="每周必看" path={['content', 'sources', 'weekly']} form={form} onChange={update} />
            <CheckField label="热搜" path={['content', 'sources', 'hotSearch']} form={form} onChange={update} />
          </div>
          <AreaField label="品味说明（自然语言筛选标准，注入提示词）" path={['content', 'interestBrief']} form={form} rows={3} onChange={update} />
        </section>
        <section className="xy-card">
          <h3>人设与文风</h3>
          <div className="xy-grid2">
            <AreaField label="语气基调" path={['persona', 'tone']} form={form} rows={2} onChange={update} />
            <AreaField label="评论风格" path={['persona', 'commentStyle']} form={form} rows={2} onChange={update} />
            <AreaField label="回复风格" path={['persona', 'replyStyle']} form={form} rows={2} onChange={update} />
            <AreaField label="补充要求（必须遵守）" path={['persona', 'extraNotes']} form={form} rows={2} onChange={update} />
          </div>
        </section>
        <section className="xy-card">
          <h3>账号</h3>
          <div className="xy-grid2">
            <TextField label="大号 mid" path={['accounts', 'owner', 'mid']} form={form} type="number" onChange={update} />
            <TextField label="大号昵称（@ 用）" path={['accounts', 'owner', 'name']} form={form} onChange={update} />
            <TextField label="小号 mid（0=自动检测）" path={['accounts', 'bot', 'mid']} form={form} type="number" onChange={update} />
            <TextField label="小号昵称（0=自动检测）" path={['accounts', 'bot', 'name']} form={form} onChange={update} />
          </div>
        </section>
        <section className="xy-card">
          <h3>安全</h3>
          <div className="xy-field">
            <label htmlFor={blockedWordsId}>屏蔽词（逗号分隔，命中即拒绝发言）</label>
            <input id={blockedWordsId} className="xy-input" value={listDrafts.blockedWords ?? (form.safety?.blockedWords ?? []).join('，')}
              onChange={(e) => updateList('blockedWords', e.target.value)} />
          </div>
          <CheckField label="每轮任务前 cookie 探活" path={['safety', 'cookieProbe']} form={form} onChange={update} />
        </section>
        <section className="xy-card">
          <h3>连接与模型</h3>
          <div className="xy-grid2">
            <TextField label="MCP 地址" path={['mcp', 'url']} form={form} onChange={update} />
            <TextField label="MCP 令牌（空=用环境变量 WEIYU_MCP_TOKEN）" path={['mcp', 'token']} form={form} type="password" onChange={update} />
            <TextField label="MCP 超时（毫秒）" path={['mcp', 'timeoutMs']} form={form} type="number" onChange={update} />
          </div>
          <ModelFields form={form} update={update} models={models} />
        </section>
      </fieldset>
      <div className="xy-save-bar">
        <span className="xy-meta" aria-live="polite">{dirty ? '有未保存的修改' : '没有待保存的修改'}</span>
        <div className="xy-actions">
          <button className="xy-btn" disabled={saving || !dirty} onClick={onDiscard}>放弃修改</button>
          <button className="xy-btn" data-primary="true" disabled={saving || !dirty} onClick={onSave}>{saving ? '保存中…' : '保存设置'}</button>
        </div>
      </div>
    </div>
  )
}

function Overview({ status }: { status: PanelStatus }) {
  const { schedule, quotas, sessions, lastProbe } = status
  const jobs = status.lastJobs ?? []

  return (
    <div className="xy-overview">
      <section className="xy-card">
        <div className="xy-card-heading">
          <h2>今日配额</h2>
          <p className="xy-desc">已用次数 / 每日上限</p>
        </div>
        <div className="xy-quotas">
          {(Object.entries(quotas?.used ?? {}) as Array<[ActionKind, number]>).map(([kind, used]) => {
            const limit = quotas?.limits?.[`${kind}PerDay`]
            const filled = limit > 0 ? Math.min(100, Math.max(0, used / limit * 100)) : 0
            return (
              <div key={kind} className="xy-quota">
                <div className="xy-row xy-between">
                  <span>{KIND_LABEL[kind] ?? kind}</span>
                  <span className="xy-quota-value"><strong>{used}</strong> / {limit ?? '—'}</span>
                </div>
                <div className="xy-track" aria-hidden="true">
                  <div style={{ width: `${filled}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      </section>
      <section className="xy-card">
        <h2>任务调度</h2>
        <div className="xy-list">
          {([
            ['刷 B 站', schedule?.browseEnabled, schedule?.browseRunning, schedule?.browseIntervalMin, schedule?.browseNextDue, schedule?.jitterMin, '分钟'],
            ['收件与回复', schedule?.mentionEnabled, schedule?.mentionRunning, schedule?.mentionIntervalMin, schedule?.mentionNextDue, schedule?.mentionJitterSec, '秒'],
          ] as const).map(([label, enabled, running, interval, next, jitter, unit]) => (
            <div className="xy-list-row" key={label}>
              <div className="xy-row xy-between">
                <strong>{label}</strong>
                <span className="xy-badge" data-tone={running || enabled ? 'success' : undefined}>
                  {running ? '执行中' : enabled ? '已开启' : '已关闭'}
                </span>
              </div>
              <div className="xy-meta">{enabled
                ? `每 ${interval} 分钟${jitter ? ` + 随机 0–${jitter} ${unit}` : ''} · 下轮 ${fmtTime(next, unit === '秒')}`
                : '定时调度已关闭'}</div>
            </div>
          ))}
          <div className="xy-list-row xy-row xy-between">
            <span>静默时段</span><span className="xy-meta">{schedule?.quietFrom} – {schedule?.quietTo}</span>
          </div>
        </div>
      </section>
      <section className="xy-card">
        <h2>最近任务</h2>
        {jobs.slice().reverse().map((job) => (
          <div className="xy-item" key={`${job.kind}-${job.startedAt}`}>
            <div className="xy-row xy-between">
              <strong>{job.kind === 'browse' ? '刷 B 站' : '提及回应'}</strong>
              <span className="xy-badge" data-tone={job.status === 'ok' ? 'success' : job.status === 'running' ? 'info' : 'error'}>
                {JOB_LABEL[job.status] ?? job.status}
              </span>
            </div>
            <div className="xy-meta">{fmtTime(job.startedAt)} · {job.trigger === 'manual' ? '手动' : '定时'}</div>
            {job.summary && <div className="xy-msg">{job.summary}</div>}
            {job.error && <div className="xy-msg xy-error">{job.error}</div>}
          </div>
        ))}
        {jobs.length === 0 && <div className="xy-empty">暂无任务记录，可在「维护」中手动触发。</div>}
      </section>
      <section className="xy-card">
        <h2>账号与连接</h2>
        <div className="xy-list">
          <div className="xy-list-row xy-row xy-between">
            <span>大号</span>
            <span className="xy-badge" data-tone={status.accounts?.ownerConfigured ? 'success' : 'warning'}>
              {status.accounts?.ownerConfigured ? '已配置' : '未配置'}
            </span>
          </div>
          <div className="xy-list-row">
            <div className="xy-row xy-between">
              <strong>登录探活</strong>
              <span className="xy-badge" data-tone={lastProbe ? lastProbe.result?.ok ? 'success' : 'error' : undefined}>
                {lastProbe ? lastProbe.result?.ok ? '正常' : '异常' : '尚未探活'}
              </span>
            </div>
            {lastProbe && <div className="xy-meta">{fmtTime(lastProbe.at)} · {lastProbe.result?.message}</div>}
          </div>
          <div className="xy-list-row">
            <div className="xy-row xy-between"><span>浏览会话</span><span className="xy-meta">{sessions?.browse || '待建'}</span></div>
            <div className="xy-row xy-between"><span>最近提及会话</span><span className="xy-meta">{sessions?.mention || '待建'}</span></div>
          </div>
        </div>
      </section>
    </div>
  )
}

function fmtTime(iso?: string | null, seconds = false): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ''}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
}
