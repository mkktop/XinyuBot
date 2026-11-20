// 定时调度：每秒检查两类 job 是否到期。
//   - 设置热生效：按上次启动时间重算已修改任务的间隔
//   - single-flight：同一 kind 上一次没跑完不重复发
//   - 静默时段照常浏览与收件，由发布闸门检查发言。
//   - 错过即跳过：dsh 重启后 nextDue 按 store.lastJobs 重推，不补跑积压

import type { Store } from './store.js'
import type { XinyuSettings } from './settings.js'

export type JobKind = 'browse' | 'mention'

type Schedule = XinyuSettings['schedule']

const JOB_KINDS: JobKind[] = ['browse', 'mention']
const TICK_MS = 1_000
const BOOT_DELAY_MS: Record<JobKind, number> = { mention: 45_000, browse: 5 * 60_000 }

function intervalMs(kind: JobKind, settings: Schedule): number {
  return (kind === 'browse' ? settings.browseIntervalMin : settings.mentionIntervalMin) * 60_000
}

function jitterMs(kind: JobKind, settings: Schedule): number {
  return kind === 'browse' ? settings.jitterMin * 60_000 : settings.mentionJitterSec * 1_000
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private nextDue: Record<JobKind, number> = { browse: 0, mention: 0 }
  private lastStarted: Record<JobKind, number> = { browse: 0, mention: 0 }
  private plannedSchedule?: Schedule
  private running = new Set<JobKind>()
  private getSettings: () => XinyuSettings
  private store: Store
  private run: (kind: JobKind, trigger: 'schedule' | 'manual') => Promise<void>
  private log: (level: 'info' | 'warn', message: string) => void

  constructor(deps: {
    getSettings: () => XinyuSettings
    store: Store
    run: (kind: JobKind, trigger: 'schedule' | 'manual') => Promise<void>
    log: (level: 'info' | 'warn', message: string) => void
  }) {
    this.getSettings = deps.getSettings
    this.store = deps.store
    this.run = deps.run
    this.log = deps.log
  }

  start() {
    if (this.timer !== null) return
    // 重启后按最近一次任务时间重推 nextDue；从未跑过则按启动延迟排期
    const now = Date.now()
    const schedule = this.getSettings().schedule
    this.plannedSchedule = schedule
    for (const kind of JOB_KINDS) {
      const last = [...this.store.state.lastJobs].reverse().find((x) => x.kind === kind)
      const startedAt = last ? Date.parse(last.startedAt) : 0
      this.lastStarted[kind] = Number.isFinite(startedAt) ? startedAt : 0
      if (this.lastStarted[kind]) this.planNext(kind, schedule)
      else this.nextDue[kind] = now + BOOT_DELAY_MS[kind]
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
    this.log('info', `xinyu-bilibili: scheduler 启动（browse due ${new Date(this.nextDue.browse).toISOString()}，mention due ${new Date(this.nextDue.mention).toISOString()}）`)
  }

  stop() {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null }
  }

  private planNext(kind: JobKind, schedule: Schedule) {
    this.nextDue[kind] = this.lastStarted[kind] + intervalMs(kind, schedule) + Math.floor(Math.random() * jitterMs(kind, schedule))
  }

  private refreshSchedule(schedule: Schedule) {
    const previous = this.plannedSchedule
    if (previous === schedule) return
    this.plannedSchedule = schedule
    if (!previous) return
    for (const kind of JOB_KINDS) {
      if (this.lastStarted[kind] && (intervalMs(kind, previous) !== intervalMs(kind, schedule) || jitterMs(kind, previous) !== jitterMs(kind, schedule))) {
        this.planNext(kind, schedule)
      }
    }
  }

  tick() {
    const s = this.getSettings()
    this.refreshSchedule(s.schedule)
    const now = Date.now()
    for (const kind of JOB_KINDS) {
      const enabled = kind === 'browse' ? s.schedule.browseEnabled : s.schedule.mentionEnabled
      if (!enabled || s.general.mode === 'off') continue
      if (this.running.has(kind) || now < this.nextDue[kind]) continue
      this.fire(kind, 'schedule', s.schedule).catch(() => undefined)
    }
  }

  /** 手动触发（面板/管理 API）：后台执行（任务可达 25 分钟，接口立即返回）；仍受 single-flight。 */
  trigger(kind: JobKind): { ok: boolean; message: string } {
    if (this.running.has(kind)) return { ok: false, message: '该任务已在执行中' }
    const s = this.getSettings()
    if (s.general.mode === 'off') return { ok: false, message: '运营总开关为 off，请先在设置中开启' }
    this.refreshSchedule(s.schedule)
    void this.fire(kind, 'manual', s.schedule)
    return { ok: true, message: `${kind} 任务已启动` }
  }

  private async fire(kind: JobKind, trigger: 'schedule' | 'manual', schedule: Schedule): Promise<void> {
    if (this.running.has(kind)) return
    this.running.add(kind)
    this.lastStarted[kind] = Date.now()
    this.planNext(kind, schedule)
    try {
      await this.run(kind, trigger)
    } catch (error) {
      this.log('warn', `xinyu-bilibili: ${kind} 任务异常：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.running.delete(kind)
    }
  }

  isRunning(kind: JobKind): boolean { return this.running.has(kind) }

  nextDueAt(kind: JobKind): string { return new Date(this.nextDue[kind]).toISOString() }
}
