// settings 单测：默认值、merge 校验/夹紧/未知键、脱敏、SettingsStore 持久化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, mergeSettings, sanitizeSettings, SettingsStore, resolveMcpToken } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'xinyu-settings-'))
}

test('默认设置完整且模式为审批制', () => {
  assert.equal(DEFAULT_SETTINGS.general.mode, 'dry_run')
  assert.equal(DEFAULT_SETTINGS.actions.coin.enabled, false)
  assert.equal(DEFAULT_SETTINGS.quotas.coinPerDay, 0)
  assert.ok(DEFAULT_SETTINGS.mcp.url.includes('8787'))
})

test('merge：合法 patch 合并，未提及键保持原值', () => {
  const { settings, rejected } = mergeSettings(DEFAULT_SETTINGS, { general: { mode: 'auto' } })
  assert.equal(settings.general.mode, 'auto')
  assert.deepEqual(rejected, [])
  assert.equal(settings.quotas.sharePerDay, DEFAULT_SETTINGS.quotas.sharePerDay)
})

test('merge：未知键进 rejected 且不生效', () => {
  const { settings, rejected } = mergeSettings(DEFAULT_SETTINGS, { hacker: true, general: { mode: 'auto', evil: 1 } })
  assert.equal(settings.general.mode, 'auto')
  assert.ok(rejected.includes('hacker'))
  assert.ok(rejected.includes('general.evil'))
})

test('merge：数值夹紧', () => {
  const { settings } = mergeSettings(DEFAULT_SETTINGS, {
    quotas: { sharePerDay: 999, minPostIntervalMin: -5 },
    content: { videosPerRun: 0 },
    schedule: { browseIntervalMin: 1, mentionIntervalMin: 1, mentionJitterSec: 15, mentionConcurrency: 99 },
  })
  assert.equal(settings.quotas.sharePerDay, 20)
  assert.equal(settings.quotas.minPostIntervalMin, 0)
  assert.equal(settings.content.videosPerRun, 1)
  assert.equal(settings.schedule.browseIntervalMin, 15)
  assert.equal(settings.schedule.mentionIntervalMin, 1)
  assert.equal(settings.schedule.mentionJitterSec, 15)
  assert.equal(settings.schedule.mentionConcurrency, 10)
  assert.equal(mergeSettings(settings, { schedule: { mentionConcurrency: 0 } }).settings.schedule.mentionConcurrency, 1)
  assert.equal(settings.schedule.jitterMin, DEFAULT_SETTINGS.schedule.jitterMin)
})

test('merge：非法枚举与时间格式被拒绝', () => {
  const { settings, rejected } = mergeSettings(DEFAULT_SETTINGS, { general: { mode: 'yolo' }, schedule: { quietFrom: '25:00' } })
  assert.equal(settings.general.mode, 'dry_run')
  assert.ok(rejected.includes('general.mode'))
  assert.ok(rejected.includes('schedule.quietFrom'))
})

test('merge：关键词数组过滤非字符串并封顶', () => {
  const { settings } = mergeSettings(DEFAULT_SETTINGS, { content: { keywords: ['AI', 42, '  编程 ', ''] } })
  assert.deepEqual(settings.content.keywords, ['AI', '编程'])
})

test('merge：账号 mid 校验', () => {
  const { settings, rejected } = mergeSettings(DEFAULT_SETTINGS, { accounts: { owner: { mid: 123, name: '大号' }, bot: { mid: -1 } } })
  assert.equal(settings.accounts.owner.mid, 123)
  assert.equal(settings.accounts.owner.name, '大号')
  assert.ok(rejected.includes('accounts.bot.mid'))
})

test('sanitize：token 永不回传', () => {
  const s = structuredClone(DEFAULT_SETTINGS)
  s.mcp.token = 'secret-token'
  const view = sanitizeSettings(s)
  assert.equal(view.mcp.token, '')
  assert.equal(view.mcp.hasToken, true)
  const empty = sanitizeSettings(DEFAULT_SETTINGS)
  assert.equal(empty.mcp.hasToken, false)
})

test('resolveMcpToken：设置优先，回落 env', () => {
  const s = structuredClone(DEFAULT_SETTINGS)
  s.mcp.token = 'from-settings'
  assert.equal(resolveMcpToken(s), 'from-settings')
  const previous = process.env.WEIYU_MCP_TOKEN
  process.env.WEIYU_MCP_TOKEN = 'from-env'
  assert.equal(resolveMcpToken(DEFAULT_SETTINGS), 'from-env')
  if (previous === undefined) delete process.env.WEIYU_MCP_TOKEN
  else process.env.WEIYU_MCP_TOKEN = previous
})

test('SettingsStore：首次创建写默认文件；更新原子持久化', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'settings.json')
    const store = new SettingsStore(path)
    assert.ok(existsSync(path))
    assert.equal(store.get().general.mode, 'dry_run')
    store.update({ general: { mode: 'auto' }, actions: { coin: { enabled: true, approval: true } }, schedule: { mentionConcurrency: 4 } })
    // 重新加载同一文件
    const reloaded = new SettingsStore(path)
    assert.equal(reloaded.get().general.mode, 'auto')
    assert.equal(reloaded.get().actions.coin.enabled, true)
    assert.equal(reloaded.get().schedule.mentionConcurrency, 4)
    // 文件权限语义（内容含默认人设）
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(raw.general.mode, 'auto')
    delete raw.schedule.mentionConcurrency
    writeFileSync(path, JSON.stringify(raw))
    assert.equal(new SettingsStore(path).get().schedule.mentionConcurrency, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('SettingsStore：损坏文件拒绝加载（不静默重置）', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'settings.json')
    new SettingsStore(path)
    writeFileSync(path, '{ broken json')
    assert.throws(() => new SettingsStore(path), /损坏/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('SettingsStore：update 返回 rejected 列表', () => {
  const dir = tempDir()
  try {
    const store = new SettingsStore(join(dir, 'settings.json'))
    const { rejected } = store.update({ nope: 1 })
    assert.ok(rejected.includes('nope'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
