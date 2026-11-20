// 冒烟：mock MCP → XinyuCore 全链路
//   探活 → 扫描检出（回复+@）→ auto 直发回复 → dry_run 入队 share → 审批直发
//   → 闸门拒绝路径（配额/间隔/屏蔽词）→ 状态回填断言。全程不联网。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockWeiyu, sampleComment } from './mock-weiyu.mjs'
import { XinyuCore, XinyuGuardError, replyToQueuedMentions, xinyuBrowseTools } from '../lib/index.js'

const BOT_MID = 3707006871407373
const BOT_NAME = 'bilblicopy'
const OWNER_MID = 42

async function main() {
  const mock = await startMockWeiyu()
  const dir = mkdtempSync(join(tmpdir(), 'xinyu-smoke-'))
  const failures = []
  const check = (label, fn) => Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${label}`))
    .catch((error) => { failures.push({ label, error }); console.error(`  ✗ ${label}: ${error.message}`) })

  try {
    const core = new XinyuCore(join(dir, 'settings.json'), join(dir, 'state'), () => undefined)
    core.settings.update({
      general: { mode: 'auto' },
      accounts: { owner: { mid: OWNER_MID, name: '我的大号' }, bot: { mid: BOT_MID, name: BOT_NAME } },
      mcp: { url: mock.url, token: mock.token, timeoutMs: 15000 },
      schedule: { quietFrom: '00:00', quietTo: '00:00' },
    })

    await check('登录探活：ok 且识别小号身份', async () => {
      const probe = await core.probeLogin()
      assert.equal(probe.ok, true)
      assert.equal(probe.detected.mid, BOT_MID)
      assert.equal(core.botIdentity().name, BOT_NAME)
    })

    // 种子：小号在 BV1seed 下发过一条一级评论 rpid 100
    core.store.recordMyComment({ bvid: 'BV1seed', rpid: 100, kind: 'author', ts: new Date().toISOString() })
    mock.state.commentsByBvid['BV1seed'] = [
      sampleComment(200, { parent: 100, mid: 5, uname: '路人甲', message: '回复 @bilblicopy：写得好' }),
      sampleComment(201, { mid: BOT_MID, uname: BOT_NAME, message: '自己的评论' }),
      sampleComment(202, { mid: 6, uname: '路人乙', message: `@${BOT_NAME} 请教一个问题` }),
      sampleComment(203, { mid: 7, uname: '路人丙', message: '完全无关' }),
    ]
    mock.state.titles['BV1seed'] = '测试视频'

    await check('扫描：检出 2 条提及并入队', async () => {
      const { found, source } = await core.scanMentionsNow()
      assert.equal(source, 'scan')
      assert.equal(found, 2)
      assert.equal(core.store.mentionQueueSize(), 2)
    })

    await check('auto 模式 reply 直发：MCP 收到 parent 评论，状态回填', async () => {
      const outcome = await core.submit('reply', { bvid: 'BV1seed', message: '谢谢关注！这个是用的 Rust 写的', parent: 200, reason: '回应提问' })
      assert.equal(outcome.channel, 'post')
      const posted = mock.state.calls.filter((x) => x.tool === 'post_comment')
      assert.equal(posted.length, 1)
      assert.equal(posted[0].args.parent, 200)
      assert.ok(outcome.rpid > 0)
      assert.equal(core.store.quotaUsed('reply'), 1)
      assert.ok(core.store.state.lastPostAt)
      // 回复落地后对应提及出队
      assert.equal(core.store.mentionQueueSize(), 1)
    })

    await check('发言间隔闸门：20 分钟内第二次发言被拒', async () => {
      await assert.rejects(
        () => core.submit('share', { bvid: 'BV1fresh', message: '@我的大号 推荐个视频', mentions: [{ mid: OWNER_MID, name: '我的大号' }], reason: 'x' }),
        (error) => error instanceof XinyuGuardError && error.code === 'rate_limited',
      )
    })

    await check('屏蔽词闸门：命中拒绝', async () => {
      core.settings.update({ quotas: { minPostIntervalMin: 0 } })
      core.settings.update({ safety: { blockedWords: ['敏感词'] } })
      await assert.rejects(
        () => core.submit('author', { bvid: 'BV1word0', message: '这视频有点敏感词嫌疑', reason: 'x' }),
        (error) => error instanceof XinyuGuardError && error.code === 'blocked_word',
      )
      core.settings.update({ safety: { blockedWords: [] } })
    })

    await check('dry_run 模式 share 入待审队列，不触达 MCP', async () => {
      const before = mock.state.calls.filter((x) => x.tool === 'post_comment').length
      core.settings.update({ general: { mode: 'dry_run' } })
      const outcome = await core.submit('share', { bvid: 'BV1share9', message: '@我的大号 这个视频讲嵌入式工具链，总结如下…', mentions: [{ mid: OWNER_MID, name: '我的大号' }], reason: '发现好内容' })
      assert.equal(outcome.channel, 'queue')
      assert.ok(outcome.pendingId)
      const after = mock.state.calls.filter((x) => x.tool === 'post_comment').length
      assert.equal(after, before, 'dry_run 不应发送')
      const pending = core.store.loadPending().find((x) => x.id === outcome.pendingId)
      assert.equal(pending.status, 'pending')
      assert.equal(pending.kind, 'share')
    })

    await check('审批通过：绕过 LLM 直发，mentions 传给 MCP，状态 posted', async () => {
      const pending = core.store.loadPending().find((x) => x.status === 'pending')
      const result = await core.approvePending(pending.id)
      assert.equal(result.ok, true)
      const posted = mock.state.calls.filter((x) => x.tool === 'post_comment')
      const last = posted[posted.length - 1]
      assert.equal(last.args.bvid, 'BV1share9')
      assert.deepEqual(last.args.mentions, [{ mid: OWNER_MID, name: '我的大号' }])
      const updated = core.store.loadPending().find((x) => x.id === pending.id)
      assert.equal(updated.status, 'posted')
      assert.ok(updated.rpid > 0)
      assert.equal(core.store.quotaUsed('share'), 1)
      // 我方评论已记录（供后续扫描遍历）
      assert.ok(core.store.state.myComments.some((c) => c.bvid === 'BV1share9'))
    })

    await check('mode=off：submit 直接拒绝（mode_off）', async () => {
      core.settings.update({ general: { mode: 'off' } })
      await assert.rejects(
        () => core.submit('author', { bvid: 'BV1off01', message: '好视频', reason: 'x' }),
        (error) => error instanceof XinyuGuardError && error.code === 'mode_off',
      )
    })

    await check('工具定义：xinyu 工具可执行且错误如实上抛', async () => {
      const tools = (await import('../lib/index.js')).xinyuTools(core, 'agent-1')
      const post = tools.find((t) => t.name === 'xinyu_post_comment')
      core.settings.update({ general: { mode: 'dry_run' } })
      const result = await post.execute({ bvid: 'BV1tool1', message: '@我的大号 测试', mentions: [{ mid: OWNER_MID, name: '我的大号' }], reason: '工具链路' }, { agent: 'agent-1', signal: { throwIfAborted() {} } })
      const parsed = JSON.parse(result.result)
      assert.equal(parsed.status, 'queued')
      // 身份不符
      await assert.rejects(() => post.execute({ bvid: 'BV1tool1', message: 'x', reason: 'r' }, { agent: 'other', signal: { throwIfAborted() {} } }))
      // 缺 reason
      await assert.rejects(() => post.execute({ bvid: 'BV1tool1', message: 'x' }, { agent: 'agent-1', signal: { throwIfAborted() {} } }))
    })

    await check('原生消息去重，裸 @ 介绍视频内容并与问题并行起草，各自回复原评论', async () => {
      const settingsPath = join(dir, 'notification-settings.json')
      const stateDir = join(dir, 'notification-state')
      const incoming = new XinyuCore(settingsPath, stateDir)
      incoming.settings.update({
        general: { mode: 'auto' },
        accounts: { bot: { mid: BOT_MID, name: BOT_NAME } },
        mcp: { url: mock.url, token: mock.token },
        schedule: { quietFrom: '00:00', quietTo: '00:00' },
        quotas: { minPostIntervalMin: 0, maxRepliesPerThread: 1 },
      })
      const now = Math.floor(Date.now() / 1000)
      const video = {
        bvid: 'BV17x411w7KC', title: 'ESP32 驱动电子纸', owner_name: '测试 UP 主', owner_mid: 77,
        duration: 135, desc: '演示接线、刷新和深度睡眠。', pages: [{ cid: 7000 }],
      }
      const root = 700
      mock.state.videos.av170001 = video
      const at = (id, rpid, mid, message, fields = {}) => ({
        id, time: 0, user: { mid, nickname: '测试访客' },
        item: {
          business_id: 1, subject_id: 170001, uri: 'https://www.bilibili.com/video/av170001',
          target_reply_id: rpid, root_id: root, parent_id: root, message,
          time: now, ...fields,
        },
      })
      const past = at(1000, 600, OWNER_MID, `@${BOT_NAME} 老消息`, { time: now - 3600 })
      const end = (...items) => ({ cursor: { is_end: true }, items })
      mock.state.messageFeeds.get_at_feed = { 0: end(past) }
      mock.state.messageFeeds.get_reply_feed = { 0: end() }
      assert.equal((await incoming.scanMentionsNow()).found, 0)

      const bare = at(1001, 601, OWNER_MID, `＠${BOT_NAME}！`)
      const question = at(1002, 602, 88, `@${BOT_NAME} 电子纸怎么刷新？`)
      const dynamic = at(1003, 603, 90, `@${BOT_NAME}`, { business_id: 17, uri: 'https://www.bilibili.com/opus/12345' })
      const self = at(1004, 604, BOT_MID, `@${BOT_NAME}`)
      mock.state.messageFeeds.get_at_feed = {
        0: { cursor: { is_end: false, id: 1002, time: now }, items: [self, dynamic, question] },
        1002: end(bare, past),
      }
      mock.state.messageFeeds.get_reply_feed = { 0: end({
        id: 2000, reply_time: now, user: question.user,
        item: {
          business_id: 1, subject_id: 170001, uri: question.item.uri,
          source_id: 602, root_id: root, target_id: root, source_content: question.item.message,
          at_details: [{ mid: BOT_MID, nickname: BOT_NAME }],
        },
      }) }
      const synced = await incoming.scanMentionsNow()
      assert.equal(synced.source, 'notifications')
      assert.equal(synced.found, 2)
      assert.deepEqual(synced.items.map(({ rpid }) => rpid), [601, 602])
      assert.deepEqual(mock.state.calls.filter((call) => call.tool === 'get_at_feed').at(-1).args, { last_id: 1002, last_time: now })

      const callsBefore = mock.state.calls.length
      const modelCalls = []
      let running = 0
      let peak = 0
      const bridge = {
        async runJob({ rpid }, options) {
          modelCalls.push(rpid)
          assert.deepEqual(options.buildTools(), [])
          assert.match(options.prompt, /ESP32 驱动电子纸/)
          const bareMention = rpid === 601
          if (bareMention) {
            assert.match(options.prompt, /介绍视频讲了什么/)
            assert.match(options.prompt, /get_video_subtitles/)
            assert.match(options.prompt, /"cid": 7000/)
            assert.match(options.prompt, /"up_mid": 77/)
            assert.doesNotMatch(options.prompt, /电子纸怎么刷新|"rpid": 602/)
          } else {
            assert.equal(rpid, 602)
            assert.match(options.prompt, /电子纸怎么刷新/)
            assert.match(options.prompt, /摘要和字幕都缺失时.*本视频.*已确认的要点和资料缺口/)
            assert.doesNotMatch(options.prompt, /"rpid": 601/)
          }
          running += 1
          peak = Math.max(peak, running)
          await new Promise((resolve) => setTimeout(resolve, 25))
          running -= 1
          const message = bareMention ? '视频演示 ESP32 怎么接电子纸、刷新画面，最后让设备进入深度睡眠。' : '视频用屏幕驱动库写入缓冲区，再触发刷新。'
          return { kind: 'completed', text: JSON.stringify({ replies: [
            { rpid: bareMention ? 602 : 601, message: '另一条评论的答复' }, { rpid, message },
          ] }) }
        },
      }
      incoming.settings.update({ quotas: { replyPerDay: 0 } })
      const deferred = await replyToQueuedMentions(incoming, bridge, incoming.settings.get())
      assert.ok(deferred.waiting)
      assert.equal(modelCalls.length, 0)
      assert.equal(incoming.store.mentionQueueSize(), 2)
      incoming.settings.update({ quotas: { replyPerDay: 8 } })
      const replied = await replyToQueuedMentions(incoming, bridge, incoming.settings.get())
      assert.equal(replied.posted, 2)
      assert.deepEqual(modelCalls, [601, 602])
      assert.equal(peak, 2)
      const posted = mock.state.calls.slice(callsBefore).filter((call) => call.tool === 'post_comment').map((call) => call.args)
        .sort((a, b) => a.parent - b.parent)
      assert.equal(posted.length, 2)
      assert.deepEqual(posted.map(({ bvid, parent, root }) => ({ bvid, parent, root })), [
        { bvid: video.bvid, parent: 601, root },
        { bvid: video.bvid, parent: 602, root },
      ])
      assert.match(posted[0].message, /怎么接电子纸、刷新画面.*深度睡眠/)
      assert.match(posted[1].message, /缓冲区/)
      assert.equal(mock.state.calls.slice(callsBefore).filter((call) => call.tool === 'parse_video').length, 1)
      assert.equal(incoming.store.mentionQueueSize(), 0)

      const restarted = new XinyuCore(settingsPath, stateDir)
      assert.equal((await restarted.scanMentionsNow()).found, 0)
      assert.equal(restarted.store.quotaUsed('reply'), 2)
    })

    await check('回复并发设为 1 时依次起草，超长草稿在原会话改写一次', async () => {
      const incoming = new XinyuCore(join(dir, 'long-reply-settings.json'), join(dir, 'long-reply-state'))
      incoming.settings.update({
        general: { mode: 'auto' },
        accounts: { bot: { mid: BOT_MID, name: BOT_NAME } },
        mcp: { url: mock.url, token: mock.token },
        schedule: { quietFrom: '00:00', quietTo: '00:00', mentionConcurrency: 1 },
        quotas: { minPostIntervalMin: 0 },
      })
      const bvid = 'BV17x411w7KC'
      incoming.store.addMentions([801, 802].map((rpid) => ({
        bvid, rpid, botMid: BOT_MID, parent: 0, root: 0, mid: 88, uname: '测试访客',
        text: `@${BOT_NAME} 有哪些新闻？`, via: 'mentioned_us', ts: new Date().toISOString(),
      })))
      const long = `第一条新闻。${'第二条新闻的详情。'.repeat(130)}`
      const longWithEmoji = `${'字'.repeat(998)}🧪${'字'.repeat(120)}`
      const concise = '主要有两条新闻，第一条讲发布，第二条讲开放测试。'
      const turns = []
      const before = mock.state.calls.length

      const result = await replyToQueuedMentions(incoming, {
        async runJob({ rpid }, { prompt }) {
          turns.push({ rpid, prompt })
          const revision = prompt.includes('超过发布长度限制')
          const replies = revision
            ? [{ rpid: 801, message: concise }]
            : [{ rpid, message: rpid === 801 ? long : longWithEmoji }]
          return { kind: 'completed', text: `\`\`\`json\n${JSON.stringify({ replies })}\n\`\`\`` }
        },
      }, incoming.settings.get())

      assert.deepEqual(turns.map(({ rpid }) => rpid), [801, 801, 802, 802])
      assert.match(turns[0].prompt, /最多 1000 字符/)
      assert.ok(turns[1].prompt.includes(long))
      assert.equal(result.posted, 2)
      assert.equal(result.retry, 0)
      assert.equal(incoming.store.mentionQueueSize(), 0)
      const posts = mock.state.calls.slice(before).filter(({ tool }) => tool === 'post_comment').map(({ args }) => args)
      assert.deepEqual(posts.map(({ parent, message }) => [parent, message]), [
        [801, concise], [802, `${'字'.repeat(998)}…`],
      ])
    })

    await check('自主分享固定提及大号，同一视频的并发分享只发布一次', async () => {
      core.settings.update({
        general: { mode: 'auto' },
        actions: { share: { approval: false } },
        quotas: { sharePerDay: 2, maxCommentsPerVideo: 3 },
      })
      const tools = xinyuBrowseTools(core, 'browse-agent')
      assert.deepEqual(tools.map((tool) => tool.name), ['xinyu_share'])
      const [share] = tools
      const bvid = 'BV1concurrent'
      const outcomes = await Promise.all(Array.from({ length: 2 }, () => share.execute(
        { bvid, reason: '有可复现的电子纸接线演示。' }, { agent: 'browse-agent' },
      )))
      assert.deepEqual(outcomes.map((outcome) => JSON.parse(outcome.result).code), ['posted', 'already_posted'])
      const calls = mock.state.calls.filter((call) => call.tool === 'post_comment' && call.args.bvid === bvid)
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0].args.mentions, [{ mid: OWNER_MID, name: '我的大号' }])
      assert.match(calls[0].args.message, /^@我的大号 /)
    })

    console.log(failures.length === 0 ? '\nsmoke 全部通过 ✓' : `\nsmoke 失败 ${failures.length} 项 ✗`)
    if (failures.length > 0) { for (const f of failures) console.error(f.error); process.exitCode = 1 }
  } finally {
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

await main()
