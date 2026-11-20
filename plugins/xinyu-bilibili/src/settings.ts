// 设置存储：全部运营参数集中在一张 schema 里，可在设置面板热编辑，
// 持久化为 JSON（0600）。cordis config 只提供设置文件路径（见 cordis.patch.yml）。
// 形态参照 yusheng voice 的 settings.ts：merge + 校验 + 夹紧 + 未知键拒绝。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

export type RunMode = 'off' | 'dry_run' | 'auto'
export type ActionKind = 'share' | 'author' | 'reply' | 'like' | 'coin'
export const ACTION_KINDS: readonly ActionKind[] = ['share', 'author', 'reply', 'like', 'coin']
export const MAX_MENTION_CONCURRENCY = 10

export interface ActionConfig { enabled: boolean; approval: boolean }

export interface XinyuSettings {
  general: { mode: RunMode }
  /** 每类公开发言/互动独立开关与审批要求 */
  actions: Record<ActionKind, ActionConfig>
  quotas: {
    sharePerDay: number
    authorPerDay: number
    replyPerDay: number
    likePerDay: number
    coinPerDay: number
    maxCommentsPerVideo: number
    maxRepliesPerThread: number
    minPostIntervalMin: number
  }
  schedule: {
    browseEnabled: boolean
    browseIntervalMin: number
    mentionEnabled: boolean
    mentionIntervalMin: number
    mentionJitterSec: number
    mentionConcurrency: number
    /** 静默时段（本地时间 HH:MM）：暂停公开发言；跨午夜用 from>to 表达 */
    quietFrom: string
    quietTo: string
    jitterMin: number
  }
  content: {
    keywords: string[]
    sources: { recommend: boolean; dynamicFeed: boolean; ranking: boolean; weekly: boolean; hotSearch: boolean }
    /** 兼容旧版设置文件。自主浏览由 Agent 决定候选数量。 */
    videosPerRun: number
    /** 品味说明：自然语言筛选标准，原样注入任务提示词 */
    interestBrief: string
  }
  persona: {
    tone: string
    replyStyle: string
    commentStyle: string
    extraNotes: string
  }
  accounts: {
    /** 大号：share 评论 @ 它；mid/name 缺一不可 */
    owner: { mid: number; name: string }
    /** 小号；mid=0 表示启动时经 get_current_user 自动检测 */
    bot: { mid: number; name: string }
  }
  safety: { blockedWords: string[]; cookieProbe: boolean }
  mcp: { url: string; token: string; timeoutMs: number }
  /** 空 = 跟随宿主默认模型 */
  llm: { provider: string; model: string; reasoningEffort: string }
}

export const DEFAULT_SETTINGS: XinyuSettings = {
  general: { mode: 'dry_run' },
  actions: {
    share: { enabled: true, approval: true },
    author: { enabled: true, approval: true },
    reply: { enabled: true, approval: false },
    like: { enabled: true, approval: false },
    coin: { enabled: false, approval: true },
  },
  quotas: {
    sharePerDay: 2,
    authorPerDay: 2,
    replyPerDay: 8,
    likePerDay: 10,
    coinPerDay: 0,
    maxCommentsPerVideo: 1,
    maxRepliesPerThread: 2,
    minPostIntervalMin: 20,
  },
  schedule: {
    browseEnabled: true,
    browseIntervalMin: 120,
    mentionEnabled: true,
    mentionIntervalMin: 30,
    mentionJitterSec: 15,
    mentionConcurrency: 2,
    quietFrom: '01:00',
    quietTo: '08:00',
    jitterMin: 10,
  },
  content: {
    keywords: ['AI', '大模型', '编程', '嵌入式', '开源硬件', '效率工具'],
    sources: { recommend: true, dynamicFeed: true, ranking: true, weekly: true, hotSearch: false },
    videosPerRun: 3,
    interestBrief: '',
  },
  persona: {
    tone: '友好、简洁、真诚，像一个热爱技术的普通 B 站用户',
    replyStyle: '简短口语化，先回应对方再展开；不争论，不抬杠，遇到敏感或超出能力的话题就礼貌感谢不展开',
    commentStyle: '有信息量的总结，带一点个人观点；不吹捧，不标题党，不说空话套话',
    extraNotes: '',
  },
  accounts: { owner: { mid: 0, name: '' }, bot: { mid: 0, name: '' } },
  safety: { blockedWords: [], cookieProbe: true },
  mcp: { url: 'http://127.0.0.1:8787/mcp', token: '', timeoutMs: 60000 },
  llm: { provider: '', model: '', reasoningEffort: '' },
}

export function defaultSettingsPath(): string {
  const home = process.env.DSH_HOME ?? resolve(homedir(), '.dsh')
  return resolve(home, 'xinyu-bilibili', 'settings.json')
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampStr(v: unknown, max: number, fallback: string): string {
  if (typeof v !== 'string') return fallback
  return v.slice(0, max)
}

function clampBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function clampStringArray(v: unknown, maxItems: number, maxLen: number, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  const out = v.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, maxLen)).filter((item) => item.length > 0)
  return out.slice(0, maxItems)
}

function mergeAction(current: ActionConfig, patch: unknown, rejected: string[], key: string): ActionConfig {
  if (patch === undefined) return { ...current }
  if (!isPlainObject(patch)) { rejected.push(key); return { ...current } }
  const unknown = Object.keys(patch).filter((k) => !['enabled', 'approval'].includes(k))
  for (const k of unknown) rejected.push(`${key}.${k}`)
  return {
    enabled: clampBool(patch.enabled, current.enabled),
    approval: clampBool(patch.approval, current.approval),
  }
}

/**
 * 校验并合并一次面板提交；未出现在 patch 里的键保持原值。
 * 不认识的键进入 rejected 一并返回（面板提示），绝不静默吞掉。
 */
export function mergeSettings(current: XinyuSettings, patch: Record<string, unknown>): { settings: XinyuSettings; rejected: string[] } {
  if (!isPlainObject(patch)) throw new Error('settings patch must be an object')
  const rejected: string[] = []
  const next: XinyuSettings = structuredClone(current)

  if (patch.general !== undefined) {
    if (!isPlainObject(patch.general)) rejected.push('general')
    else {
      for (const k of Object.keys(patch.general).filter((k) => k !== 'mode')) rejected.push(`general.${k}`)
      const mode = patch.general.mode
      if (mode === undefined) { /* keep */ }
      else if (mode === 'off' || mode === 'dry_run' || mode === 'auto') next.general.mode = mode
      else rejected.push('general.mode')
    }
  }

  if (patch.actions !== undefined) {
    if (!isPlainObject(patch.actions)) rejected.push('actions')
    else {
      for (const k of Object.keys(patch.actions).filter((k) => !(ACTION_KINDS as readonly string[]).includes(k))) rejected.push(`actions.${k}`)
      for (const kind of ACTION_KINDS) {
        const merged = mergeAction(next.actions[kind], patch.actions[kind], rejected, `actions.${kind}`)
        next.actions[kind] = merged
      }
    }
  }

  if (patch.quotas !== undefined) {
    if (!isPlainObject(patch.quotas)) rejected.push('quotas')
    else {
      const q = patch.quotas, cur = current.quotas, out = next.quotas
      const spec: Array<[keyof typeof cur, number, number]> = [
        ['sharePerDay', 0, 20], ['authorPerDay', 0, 20], ['replyPerDay', 0, 60], ['likePerDay', 0, 100],
        ['coinPerDay', 0, 10], ['maxCommentsPerVideo', 1, 3], ['maxRepliesPerThread', 1, 5], ['minPostIntervalMin', 0, 720],
      ]
      for (const [key, min, max] of spec) {
        if (q[key] !== undefined) out[key] = clampInt(q[key], min, max, cur[key])
      }
      for (const k of Object.keys(q).filter((k) => !spec.some(([name]) => name === (k as keyof typeof cur)))) rejected.push(`quotas.${k}`)
    }
  }

  if (patch.schedule !== undefined) {
    if (!isPlainObject(patch.schedule)) rejected.push('schedule')
    else {
      const s = patch.schedule, cur = current.schedule, out = next.schedule
      out.browseEnabled = clampBool(s.browseEnabled, cur.browseEnabled)
      out.mentionEnabled = clampBool(s.mentionEnabled, cur.mentionEnabled)
      if (s.browseIntervalMin !== undefined) out.browseIntervalMin = clampInt(s.browseIntervalMin, 15, 1440, cur.browseIntervalMin)
      if (s.mentionIntervalMin !== undefined) out.mentionIntervalMin = clampInt(s.mentionIntervalMin, 1, 1440, cur.mentionIntervalMin)
      if (s.mentionJitterSec !== undefined) out.mentionJitterSec = clampInt(s.mentionJitterSec, 0, 7200, cur.mentionJitterSec)
      if (s.mentionConcurrency !== undefined) out.mentionConcurrency = clampInt(s.mentionConcurrency, 1, MAX_MENTION_CONCURRENCY, cur.mentionConcurrency)
      if (s.jitterMin !== undefined) out.jitterMin = clampInt(s.jitterMin, 0, 120, cur.jitterMin)
      for (const key of ['quietFrom', 'quietTo'] as const) {
        if (s[key] !== undefined) {
          if (typeof s[key] === 'string' && TIME_RE.test(s[key])) out[key] = s[key]
          else rejected.push(`schedule.${key}`)
        }
      }
      for (const k of Object.keys(s).filter((k) => !Object.hasOwn(cur, k))) rejected.push(`schedule.${k}`)
    }
  }

  if (patch.content !== undefined) {
    if (!isPlainObject(patch.content)) rejected.push('content')
    else {
      const c = patch.content, cur = current.content, out = next.content
      if (c.keywords !== undefined) out.keywords = clampStringArray(c.keywords, 30, 40, cur.keywords)
      if (c.videosPerRun !== undefined) out.videosPerRun = clampInt(c.videosPerRun, 1, 10, cur.videosPerRun)
      if (c.interestBrief !== undefined) out.interestBrief = clampStr(c.interestBrief, 2000, cur.interestBrief)
      if (c.sources !== undefined) {
        if (!isPlainObject(c.sources)) rejected.push('content.sources')
        else {
          const src = c.sources as Record<string, unknown>
          for (const k of Object.keys(src).filter((k) => !(k in cur.sources))) rejected.push(`content.sources.${k}`)
          for (const k of Object.keys(cur.sources) as Array<keyof typeof cur.sources>) {
            if (src[k] !== undefined) out.sources[k] = clampBool(src[k], cur.sources[k])
          }
        }
      }
      for (const k of Object.keys(c).filter((k) => !['keywords', 'sources', 'videosPerRun', 'interestBrief'].includes(k))) rejected.push(`content.${k}`)
    }
  }

  if (patch.persona !== undefined) {
    if (!isPlainObject(patch.persona)) rejected.push('persona')
    else {
      const p = patch.persona, cur = current.persona, out = next.persona
      const spec: Array<['tone' | 'replyStyle' | 'commentStyle' | 'extraNotes', number]> = [
        ['tone', 300], ['replyStyle', 600], ['commentStyle', 600], ['extraNotes', 2000],
      ]
      for (const [key, max] of spec) if (p[key] !== undefined) out[key] = clampStr(p[key], max, cur[key])
      for (const k of Object.keys(p).filter((k) => !spec.some(([name]) => name === k))) rejected.push(`persona.${k}`)
    }
  }

  if (patch.accounts !== undefined) {
    if (!isPlainObject(patch.accounts)) rejected.push('accounts')
    else {
      const a = patch.accounts
      for (const who of ['owner', 'bot'] as const) {
        const slot = a[who]
        if (slot === undefined) continue
        if (!isPlainObject(slot)) { rejected.push(`accounts.${who}`); continue }
        const cur = current.accounts[who], out = next.accounts[who]
        if (slot.mid !== undefined) {
          const mid = Math.round(Number(slot.mid))
          if (Number.isFinite(mid) && mid >= 0 && mid <= Number.MAX_SAFE_INTEGER) out.mid = mid
          else rejected.push(`accounts.${who}.mid`)
        }
        if (slot.name !== undefined) out.name = clampStr(slot.name, 80, cur.name)
        for (const k of Object.keys(slot).filter((k) => !['mid', 'name'].includes(k))) rejected.push(`accounts.${who}.${k}`)
      }
      for (const k of Object.keys(a).filter((k) => !['owner', 'bot'].includes(k))) rejected.push(`accounts.${k}`)
    }
  }

  if (patch.safety !== undefined) {
    if (!isPlainObject(patch.safety)) rejected.push('safety')
    else {
      const s = patch.safety, cur = current.safety, out = next.safety
      if (s.blockedWords !== undefined) out.blockedWords = clampStringArray(s.blockedWords, 100, 40, cur.blockedWords)
      if (s.cookieProbe !== undefined) out.cookieProbe = clampBool(s.cookieProbe, cur.cookieProbe)
      for (const k of Object.keys(s).filter((k) => !['blockedWords', 'cookieProbe'].includes(k))) rejected.push(`safety.${k}`)
    }
  }

  if (patch.mcp !== undefined) {
    if (!isPlainObject(patch.mcp)) rejected.push('mcp')
    else {
      const m = patch.mcp, cur = current.mcp, out = next.mcp
      if (m.url !== undefined) {
        if (typeof m.url === 'string' && /^https?:\/\/[^\s]+$/.test(m.url) && m.url.length <= 500) out.url = m.url
        else rejected.push('mcp.url')
      }
      if (m.token !== undefined) out.token = clampStr(m.token, 256, cur.token)
      if (m.timeoutMs !== undefined) out.timeoutMs = clampInt(m.timeoutMs, 5000, 120000, cur.timeoutMs)
      for (const k of Object.keys(m).filter((k) => !['url', 'token', 'timeoutMs'].includes(k))) rejected.push(`mcp.${k}`)
    }
  }

  if (patch.llm !== undefined) {
    if (!isPlainObject(patch.llm)) rejected.push('llm')
    else {
      const l = patch.llm, cur = current.llm, out = next.llm
      for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
        if (l[key] !== undefined) out[key] = clampStr(l[key], 128, cur[key])
      }
      for (const k of Object.keys(l).filter((k) => !['provider', 'model', 'reasoningEffort'].includes(k))) rejected.push(`llm.${k}`)
    }
  }

  for (const k of Object.keys(patch).filter((k) => !['general', 'actions', 'quotas', 'schedule', 'content', 'persona', 'accounts', 'safety', 'mcp', 'llm'].includes(k))) rejected.push(k)

  return { settings: next, rejected }
}

/** GET 视图：令牌类字段永不回传，只回是否已配置。 */
export function sanitizeSettings(s: XinyuSettings): Record<string, unknown> {
  const clone = structuredClone(s)
  const hasToken = typeof clone.mcp.token === 'string' && clone.mcp.token.length > 0
  return { ...clone, mcp: { ...clone.mcp, hasToken, token: '' } }
}

/** 插件实际使用的 MCP 令牌：设置优先，空则回落 env WEIYU_MCP_TOKEN。 */
export function resolveMcpToken(s: XinyuSettings): string {
  if (s.mcp.token) return s.mcp.token
  return process.env.WEIYU_MCP_TOKEN ?? ''
}

/** 设置存储：热编辑、原子写、损坏拒绝加载（绝不静默重置运营配置）。 */
export class SettingsStore {
  private path: string
  private data: XinyuSettings

  constructor(path: string) {
    this.path = path
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      this.write(DEFAULT_SETTINGS)
      this.data = DEFAULT_SETTINGS
      return
    }
    let raw: unknown
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
      throw new Error(`xinyu-bilibili: 设置文件损坏且拒绝加载（不静默重置）：${path} — ${error instanceof Error ? error.message : String(error)}`)
    }
    // 逐段 merge 进默认值，容忍旧版本缺段；未知键记录但不阻塞启动。
    const merged = mergeSettings(DEFAULT_SETTINGS, raw as Record<string, unknown>)
    this.data = merged.settings
  }

  get(): XinyuSettings { return this.data }

  /** 返回合并后的设置与被拒绝的键列表（面板提示用）。 */
  update(patch: Record<string, unknown>): { settings: XinyuSettings; rejected: string[] } {
    const { settings, rejected } = mergeSettings(this.data, patch)
    this.write(settings)
    this.data = settings
    return { settings, rejected }
  }

  private write(settings: XinyuSettings) {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
