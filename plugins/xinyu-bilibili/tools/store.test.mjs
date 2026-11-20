// store 单测：持久化往返、损坏拒绝、配额跨天滚动、pending 队列、
// rpid 回填、提及队列去重与重试上限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'xinyu-store-'))
}

test('短周期收件保留浏览任务的重启排期记录', () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    const start = Date.parse('2026-11-20T03:00:00.000Z')
    const browse = { kind: 'browse', trigger: 'schedule', startedAt: new Date(start).toISOString(), status: 'ok' }
    store.beginJob(browse)
    for (let i = 1; i <= 35; i += 1) {
      store.beginJob({ kind: 'mention', trigger: 'schedule', startedAt: new Date(start + i * 60_000).toISOString(), status: 'ok' })
    }
    const jobs = new Store(dir).state.lastJobs
    assert.deepEqual(jobs.filter((job) => job.kind === 'browse'), [browse])
    assert.equal(jobs.filter((job) => job.kind === 'mention').length, 30)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('state 往返：mutate 落盘，新实例读回', () => {
  const dir = tempDir()
  try {
    const first = new Store(dir)
    first.mutate((state) => { state.seenVideos['BV1abc'] = { firstSeen: 't0', lastSeen: 't1', actions: ['like'] } })
    first.recordMyComment({ bvid: 'BV1abc', rpid: 42, kind: 'author', ts: '2026-11-18T10:00:00.000Z' })
    const second = new Store(dir)
    // recordMyComment 会把 lastSeen 刷新为当前时间（markSeen），firstSeen 保持不变
    assert.equal(second.state.seenVideos['BV1abc'].firstSeen, 't0')
    assert.match(second.state.seenVideos['BV1abc'].lastSeen, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(second.state.seenVideos['BV1abc'].actions, ['like', 'author'])
    assert.equal(second.state.myComments.length, 1)
    assert.equal(second.state.myComments[0].rpid, 42)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('损坏 state.json 拒绝加载', () => {
  const dir = tempDir()
  try {
    new Store(dir)
    writeFileSync(join(dir, 'state.json'), 'not json at all')
    assert.throws(() => new Store(dir), /损坏/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('配额跨天滚动', () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    store.mutate((state) => { state.quotasUsed = { date: '2026-11-17', share: 2, author: 2, reply: 8, like: 10, coin: 1 } })
    store.rolloverQuotas(new Date(2026, 10, 18, 9, 0))
    assert.equal(store.quotaUsed('share'), 0)
    assert.equal(store.quotaUsed('coin'), 0)
    // 同日不重置
    store.mutate((state) => { state.quotasUsed.share = 1 })
    store.rolloverQuotas(new Date(2026, 10, 18, 10, 0))
    assert.equal(store.quotaUsed('share'), 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('guardView 投影：按视频/线程聚合', () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    store.recordMyComment({ bvid: 'BV1abc', rpid: 1, kind: 'share', ts: 't' })
    store.recordMyComment({ bvid: 'BV1abc', rpid: 2, kind: 'author', ts: 't' })
    store.recordMyComment({ bvid: 'BV1abc', rpid: 3, kind: 'reply', parent: 100, ts: 't' })
    store.recordMyComment({ bvid: 'BV1abc', rpid: 4, kind: 'reply', parent: 100, ts: 't' })
    const view = store.guardView(new Date(2026, 10, 18, 9, 0))
    assert.equal(view.commentsByVideo['BV1abc'], 2)
    assert.equal(view.repliesByThread['100'], 2)
    assert.deepEqual(Object.values(view.usedToday).reduce((a, b) => a + b, 0), 0) // 计数只在 countQuota 时累加
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pending 队列：add/update/过滤', () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    const item = store.addPending({ kind: 'share', bvid: 'BV1abc', message: '你好', reason: '测试' })
    assert.equal(item.status, 'pending')
    assert.ok(item.id.length >= 8)
    const updated = store.updatePending(item.id, { status: 'posted', rpid: 77 })
    assert.equal(updated.status, 'posted')
    assert.equal(updated.rpid, 77)
    // 只保留未决 + 最近 200 已决：未决仍在
    assert.equal(store.loadPending().some((x) => x.id === item.id), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('attachRpid：回填最近的零 rpid 记录', () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    store.recordMyComment({ bvid: 'BV1abc', rpid: 0, kind: 'share', ts: 't0' })
    store.attachRpid('BV1abc', 'share', 't1', 555)
    assert.equal(store.state.myComments[0].rpid, 555)
    assert.equal(store.myRpids().has(555), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('提及队列：去重、bump 上限丢弃', () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    const mention = { bvid: 'BV1abc', rpid: 900, parent: 10, root: 0, mid: 5, uname: '路人', text: '@bilblicopy 你好', ts: '', via: 'mentioned_us' }
    assert.equal(store.addMentions([mention]), 1)
    assert.equal(store.addMentions([mention]), 0) // 去重
    assert.equal(store.mentionQueueSize(), 1)
    store.bumpMention(900)
    store.bumpMention(900)
    assert.equal(store.mentionQueueSize(), 1)
    store.bumpMention(900) // 第 3 次 → 丢弃
    assert.equal(store.mentionQueueSize(), 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('participatedVideos：最新优先去重', () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    store.recordMyComment({ bvid: 'BV1', rpid: 1, kind: 'author', ts: 't' })
    store.recordMyComment({ bvid: 'BV2', rpid: 2, kind: 'share', ts: 't' })
    store.recordMyComment({ bvid: 'BV1', rpid: 3, kind: 'reply', parent: 9, ts: 't' })
    assert.deepEqual(store.participatedVideos(10), ['BV1', 'BV2'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('损坏 pending.json 拒绝加载', () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    store.addPending({ kind: 'like', bvid: 'BV1', reason: 'x' })
    writeFileSync(join(dir, 'pending.json'), '###')
    assert.throws(() => store.loadPending(), /损坏/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('activity 追加与读取', () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    store.appendActivity({ event: 'e1' })
    store.appendActivity({ event: 'e2' })
    const entries = store.readActivity(10)
    assert.equal(entries.length, 2)
    assert.equal(entries[1].event, 'e2')
    assert.equal(JSON.parse(readFileSync(join(dir, 'activity.jsonl'), 'utf8').split('\n').filter(Boolean)[0]).event, 'e1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
