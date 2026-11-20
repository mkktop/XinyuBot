import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobBridge, Store } from '../lib/index.js'

test('按原评论隔离与恢复会话，历史共享会话不参与起草', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xinyu-bridge-'))
  const store = new Store(dir)
  t.after(() => {
    rmSync(join(dir, 'state.json'))
    rmSync(join(dir, 'activity.jsonl'))
    rmdirSync(dir)
  })
  store.addMentions([701, 702].map((rpid) => ({
    bvid: 'BV17x411w7KC', rpid, root: 0, parent: 0, mid: 3, uname: '访客', text: '问题', via: 'mentioned_us', ts: '',
  })))
  store.mutate((state) => { state.sessions.mention = 'xinyu-mention' })

  const events = new EventEmitter()
  const durable = new Map([['xinyu-mention', ['旧共用会话']]])
  const live = new Map()
  const archivedSessionIds = []
  const flushed = new Set()
  const tools = {
    register: () => () => {},
    guard: () => () => {},
  }
  const open = (sessionId) => {
    const agent = {
      session: { id: sessionId, seq: 0 },
      status: 'idle',
      ctx: { get: (key) => key === 'tools' ? tools : undefined },
      async followup(message) {
        durable.get(sessionId).push(message.content[0].text)
        events.emit('agent/assistant-stream', { agent, frame: { chunk: { type: 'text-delta', text: sessionId } } })
      },
      async whenIdle() {},
    }
    live.set(sessionId, agent)
    return {
      agent,
      async dispose() {
        assert.ok(flushed.delete(sessionId), '释放实例前应保存会话记录')
        live.delete(sessionId)
      },
    }
  }
  const services = {
    agents: {
      get: (sessionId) => live.get(sessionId),
      async create({ sessionId }) {
        assert.equal(durable.has(sessionId), false)
        durable.set(sessionId, [])
        return open(sessionId)
      },
      async resume({ resumeSessionId }) { return open(resumeSessionId) },
    },
    sessions: { async flush(session) { flushed.add(session.id) } },
    sessionQuery: {
      async observeSession(sessionId) {
        if (!durable.has(sessionId)) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
      },
    },
    workspaceRegistry: { archivedSessionIds },
  }
  const ctx = {
    get: (name) => services[name],
    on(name, callback) {
      events.on(name, callback)
      return () => { events.off(name, callback) }
    },
  }
  const makeBridge = (s) => new JobBridge(ctx, s, 'xinyu-operator', () => {})
  const run = (bridge, rpid, prompt) => bridge.runJob({ rpid }, {
    prompt, timeoutMs: 1000, buildTools: () => [],
  }, { provider: '', model: '', reasoningEffort: '' })

  const bridge = makeBridge(store)
  const first = run(bridge, 701, '第一条原评论')
  const second = run(bridge, 702, '第二条原评论')
  assert.equal((await run(bridge, 701, '重复请求')).kind, 'error')
  assert.deepEqual((await Promise.all([first, second])).map(({ kind, text }) => [kind, text]), [
    ['completed', 'xinyu-mention-701'], ['completed', 'xinyu-mention-702'],
  ])
  assert.equal(live.size, 0)
  assert.equal(flushed.size, 0)
  assert.deepEqual(durable.get('xinyu-mention'), ['旧共用会话'])

  archivedSessionIds.push('xinyu-mention-701')
  const replacement = await run(bridge, 701, '第一条的重试')
  assert.equal(replacement.kind, 'completed')
  assert.match(replacement.text, /^xinyu-mention-701-r[0-9a-f]{8}$/)
  await run(bridge, 702, '第二条的补充查证')
  const reopened = new Store(dir)
  assert.equal(reopened.state.sessions.mention, 'xinyu-mention-702')
  const revision = await run(makeBridge(reopened), 701, '压缩第一条的草稿')
  assert.equal(revision.text, replacement.text)
  assert.deepEqual(durable.get(revision.text), ['第一条的重试', '压缩第一条的草稿'])
  assert.deepEqual(durable.get('xinyu-mention-702'), ['第二条原评论', '第二条的补充查证'])
  assert.deepEqual(durable.get('xinyu-mention-701'), ['第一条原评论'])
})
