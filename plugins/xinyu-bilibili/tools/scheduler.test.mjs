import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, Scheduler, mergeSettings } from '../lib/index.js'

const start = Date.parse('2026-11-20T03:00:00.000Z')
const history = (startedAt) => ['browse', 'mention'].map((kind) => ({ kind, startedAt: new Date(startedAt).toISOString() }))

test('收件按 60 秒加秒级抖动触发，浏览使用分钟抖动', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: start })
  t.mock.method(Math, 'random', () => 0.8)
  const { settings } = mergeSettings(DEFAULT_SETTINGS, { schedule: { mentionIntervalMin: 1, mentionJitterSec: 15, jitterMin: 10 } })
  const runs = []
  const scheduler = new Scheduler({
    getSettings: () => settings,
    store: { state: { lastJobs: history(start) } },
    async run(kind) { runs.push({ kind, time: Date.now() }) },
    log() {},
  })
  t.after(() => scheduler.stop())
  scheduler.start()
  assert.equal(Date.parse(scheduler.nextDueAt('mention')), start + 72_000)
  assert.equal(Date.parse(scheduler.nextDueAt('browse')), start + 128 * 60_000)
  t.mock.timers.tick(71_999)
  assert.deepEqual(runs, [])
  t.mock.timers.tick(1)
  assert.deepEqual(runs, [{ kind: 'mention', time: start + 72_000 }])
  await Promise.resolve()
  t.mock.timers.tick(72_000)
  assert.deepEqual(runs, [{ kind: 'mention', time: start + 72_000 }, { kind: 'mention', time: start + 144_000 }])
})

test('热更新收件周期会从上次收件时间重排下次到期，浏览计划仍使用原到期时间', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: start })
  t.mock.method(Math, 'random', () => 0.5)
  let settings = structuredClone(DEFAULT_SETTINGS)
  const lastStarted = start - 25_000
  const scheduler = new Scheduler({
    getSettings: () => settings,
    store: { state: { lastJobs: history(lastStarted) } },
    async run() {},
    log() {},
  })
  t.after(() => scheduler.stop())
  scheduler.start()
  const plannedBrowse = scheduler.nextDueAt('browse')
  settings = mergeSettings(settings, { schedule: { mentionIntervalMin: 1, mentionJitterSec: 15 } }).settings
  t.mock.timers.tick(1_000)
  assert.equal(Date.parse(scheduler.nextDueAt('mention')), lastStarted + 67_500)
  assert.equal(scheduler.nextDueAt('browse'), plannedBrowse)
})
