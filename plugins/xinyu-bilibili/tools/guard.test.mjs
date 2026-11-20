// guard 单测：静默时段（含跨午夜）、配额、单视频/单线程限制、发言间隔、
// 屏蔽词、动作开关、模式判定与通道决策。全部用固定时钟，无 IO。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../lib/index.js'
import { evaluateGuard, inQuietHours, todayKey } from '../lib/index.js'

function at(hour, minute = 0) {
  const d = new Date(2026, 10, 18, hour, minute, 0, 0) // 2026-11-18 本地
  return d
}

function baseState(overrides = {}) {
  return {
    usedToday: { share: 0, author: 0, reply: 0, like: 0, coin: 0 },
    commentsByVideo: {},
    repliesByThread: {},
    lastPostAt: null,
    ...overrides,
  }
}

function baseInput(overrides = {}) {
  return {
    kind: 'share',
    now: at(10),
    settings: withOwner(),
    state: baseState(),
    bvid: 'BV1test00',
    message: '推荐一个视频',
    ...overrides,
  }
}

/** 已配置大号的默认设置（share 依赖 owner mid/name）。 */
function withOwner() {
  const s = structuredClone(DEFAULT_SETTINGS)
  s.accounts.owner = { mid: 42, name: '大号' }
  return s
}

test('inQuietHours：普通时段与跨午夜时段', () => {
  assert.equal(inQuietHours(at(2), '01:00', '08:00'), true)
  assert.equal(inQuietHours(at(9), '01:00', '08:00'), false)
  assert.equal(inQuietHours(at(23), '22:00', '06:00'), true)
  assert.equal(inQuietHours(at(3), '22:00', '06:00'), true)
  assert.equal(inQuietHours(at(7), '22:00', '06:00'), false)
  assert.equal(inQuietHours(at(12), '08:00', '08:00'), false) // 相等=不静默
})

test('todayKey：本地日期键', () => {
  assert.equal(todayKey(at(10)), '2026-11-18')
})

test('mode=off：一切拒绝', () => {
  const input = baseInput()
  input.settings.general.mode = 'off'
  const verdict = evaluateGuard(input)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'mode_off')
})

test('动作停用：拒绝', () => {
  const input = baseInput()
  input.settings.actions.coin.enabled = false
  input.kind = 'coin'
  assert.equal(evaluateGuard(input).code, 'action_disabled')
})

test('静默时段：拒绝', () => {
  const input = baseInput({ now: at(3) })
  assert.equal(evaluateGuard(input).code, 'quiet_hours')
})

test('每日配额：share 用尽拒绝，like 仍可用', () => {
  const input = baseInput({ state: baseState({ usedToday: { share: 2, author: 0, reply: 0, like: 0, coin: 0 } }) })
  assert.equal(evaluateGuard(input).code, 'quota_exhausted')
  const likeInput = baseInput({ kind: 'like', state: baseState({ usedToday: { share: 2, author: 0, reply: 0, like: 1, coin: 0 } }) })
  assert.equal(evaluateGuard(likeInput).allowed, true)
})

test('单视频限制：同视频第二条一级评论拒绝', () => {
  const input = baseInput({ state: baseState({ commentsByVideo: { BV1test00: 1 } }) })
  assert.equal(evaluateGuard(input).code, 'video_already_commented')
  const other = baseInput({ bvid: 'BVother00', state: baseState({ commentsByVideo: { BV1test00: 1 } }) })
  assert.equal(evaluateGuard(other).allowed, true)
})

test('单线程限制：回复超上限拒绝', () => {
  const input = baseInput({ kind: 'reply', threadKey: '200', state: baseState({ repliesByThread: { 200: 2 } }) })
  assert.equal(evaluateGuard(input).code, 'thread_limit')
})

test('share 未配置大号：拒绝', () => {
  const input = baseInput({ settings: structuredClone(DEFAULT_SETTINGS) }) // 原始默认：owner 未配置
  assert.equal(evaluateGuard(input).code, 'owner_not_configured')
  const ok = baseInput() // withOwner 默认已配置
  assert.equal(evaluateGuard(ok).allowed, true)
})

test('屏蔽词：命中拒绝', () => {
  const input = baseInput()
  input.settings.safety.blockedWords = ['刮痧']
  input.message = '这个视频就是刮痧'
  assert.equal(evaluateGuard(input).code, 'blocked_word')
})

test('发言间隔：like 不受限；评论受限', () => {
  const recent = new Date(at(10).getTime() - 5 * 60000).toISOString()
  const likeInput = baseInput({ kind: 'like', state: baseState({ lastPostAt: recent }) })
  assert.equal(evaluateGuard(likeInput).allowed, true)
  const shareInput = baseInput({ state: baseState({ lastPostAt: recent }), settings: { ...structuredClone(DEFAULT_SETTINGS), accounts: { owner: { mid: 42, name: '大号' }, bot: { mid: 0, name: '' } } } })
  assert.equal(evaluateGuard(shareInput).code, 'rate_limited')
  const old = new Date(at(10).getTime() - 25 * 60000).toISOString()
  const laterInput = baseInput({ state: baseState({ lastPostAt: old }), settings: { ...structuredClone(DEFAULT_SETTINGS), accounts: { owner: { mid: 42, name: '大号' }, bot: { mid: 0, name: '' } } } })
  assert.equal(evaluateGuard(laterInput).allowed, true)
})

test('通道决策：dry_run 一律 queue；auto+无需审批 → post；auto+需审批 → queue', () => {
  const withOwner = () => ({ ...structuredClone(DEFAULT_SETTINGS), accounts: { owner: { mid: 42, name: '大号' }, bot: { mid: 0, name: '' } } })
  const dry = baseInput({ settings: { ...withOwner(), general: { mode: 'dry_run' } } })
  assert.equal(evaluateGuard(dry).channel, 'queue')
  // like 默认无需审批 → auto 下直接 post
  const auto = baseInput({ kind: 'like', settings: { ...withOwner(), general: { mode: 'auto' } } })
  assert.equal(evaluateGuard(auto).channel, 'post')
  // share 默认需要审批 → auto 下仍 queue
  const autoShare = baseInput({ settings: { ...withOwner(), general: { mode: 'auto' } } })
  assert.equal(evaluateGuard(autoShare).channel, 'queue')
  const autoApproval = baseInput({ settings: (() => { const s = withOwner(); s.general.mode = 'auto'; s.actions.share.approval = true; return s })() })
  assert.equal(evaluateGuard(autoApproval).channel, 'queue')
})

test('投币数量校验', () => {
  const input = baseInput({ kind: 'coin', multiply: 3 })
  input.settings.actions.coin.enabled = true
  input.settings.quotas.coinPerDay = 2 // 先放开配额，专测数量校验
  assert.equal(evaluateGuard(input).code, 'bad_coin')
  input.multiply = 2
  assert.equal(evaluateGuard(input).allowed, true)
})
