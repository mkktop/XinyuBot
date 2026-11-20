// scan 单测：用固定桩 MCP（不联网）验证检出逻辑——
//   回复我方评论（parent/root 命中）、正文 @ 小号、跳过自己、水位去重、楼中楼扫描。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, scanVideo, scanMentions, readMentionFeed, McpToolError } from '../lib/index.js'

const BOT_MID = 3707006871407373
const BOT_NAME = 'bilblicopy'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'xinyu-scan-'))
}

function stubMcp(pages) {
  const calls = []
  return {
    calls,
    async read(tool, args) {
      calls.push({ tool, args })
      const key = `${tool}:${args.bvid ?? ''}:${args.root_rpid ?? ''}`
      if (!(key in pages)) throw new Error(`stub 未配置 ${key}`)
      return pages[key]
    },
  }
}

function comment(rpid, { parent = 0, root = 0, mid, uname = '某人', message = '内容' } = {}) {
  return { rpid, parent, root, member: { mid, uname }, content: { message }, ctime: 1700000000 }
}

test('未雨 0.4.1 的 @ 通知以 source_id 定位原评论', async () => {
  const bvid = 'BV17x411w7KC'
  const atTime = 1795145620
  const item = {
    business: '评论', business_id: 1, subject_id: 170001,
    uri: `https://www.bilibili.com/video/${bvid}`,
    at_details: [{ mid: BOT_MID, nickname: BOT_NAME }],
  }
  const mcp = stubMcp({
    'get_at_feed::': {
      cursor: { is_end: true },
      items: [
        {
          id: 12, at_time: atTime, user: { mid: 42, nickname: '访客' },
          item: { ...item, source_id: 222, target_id: 150, root_id: 100, source_content: `@${BOT_NAME} 这里是什么意思？` },
        },
        {
          id: 11, at_time: atTime, user: { mid: 42, nickname: '访客' },
          item: { ...item, source_id: 111, target_id: 0, root_id: 0, source_content: `@${BOT_NAME}` },
        },
      ],
    },
  })
  const result = await readMentionFeed(mcp, 'at', { mid: BOT_MID, name: BOT_NAME }, 10, atTime)
  assert.equal(result.ignored, 0)
  assert.equal(result.newestId, 12)
  assert.deepEqual(result.items.map(({ bvid, rpid, parent, root, question }) => ({ bvid, rpid, parent, root, question })), [
    { bvid, rpid: 111, parent: 0, root: 0, question: '' },
    { bvid, rpid: 222, parent: 150, root: 100, question: '这里是什么意思？' },
  ])
})

test('检出：回复我方评论 + 正文@我；跳过自己与无关评论；水位去重', async () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    store.recordMyComment({ bvid: 'BV1abc', rpid: 100, kind: 'author', ts: 't' })
    const mcp = stubMcp({
      'get_video_comments:BV1abc:': {
        replies: [
          comment(200, { parent: 100, mid: 5, uname: '路人甲', message: '回复 @bilblicopy 说得好' }), // 回复我方 → 检出
          comment(201, { mid: BOT_MID, uname: BOT_NAME, message: '我们的评论' }),                    // 自己 → 跳过
          comment(202, { mid: 6, uname: '路人乙', message: `@${BOT_NAME} 请问...` }),                // @我 → 检出
          comment(203, { mid: 7, uname: '路人丙', message: '与无关的内容' }),                        // 无关 → 跳过
        ],
      },
      'get_comment_replies:BV1abc:100': { replies: [comment(205, { parent: 100, root: 100, mid: 11, uname: '路人丁', message: '楼中楼也回复我们' })] },
      'parse_video::': { title: '测试视频标题' },
    })
    const found = await scanMentions(mcp, store, BOT_NAME, BOT_MID)
    assert.deepEqual(found.map((x) => x.rpid).sort((a, b) => a - b), [200, 202, 205])
    assert.equal(found.find((x) => x.rpid === 200).via, 'reply_to_ours')
    assert.equal(found.find((x) => x.rpid === 202).via, 'mentioned_us')
    assert.equal(found[0].videoTitle, '测试视频标题') // 标题已补全
    // 水位已消费：再扫一遍不重复
    const again = await scanMentions(mcp, store, BOT_NAME, BOT_MID)
    assert.equal(again.length, 0)
    // 提及已落队（scanMentions 落队；scanVideo 不落队）
    assert.equal(store.mentionQueueSize(), 3)
    assert.deepEqual(store.participatedVideos(10), ['BV1abc'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('楼中楼：我方一级评论下的回复被检出', async () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    store.recordMyComment({ bvid: 'BV1root', rpid: 300, kind: 'share', ts: 't' })
    const mcp = stubMcp({
      'get_video_comments:BV1root:': { replies: [comment(301, { mid: 8, uname: '楼主', message: '前排' })] },
      'get_comment_replies:BV1root:300': {
        replies: [comment(302, { parent: 300, root: 300, mid: 9, uname: '提问者', message: '想问下配置' })],
      },
    })
    const found = await scanVideo(mcp, store, BOT_NAME, BOT_MID, 'BV1root')
    assert.deepEqual(found.map((x) => x.rpid), [302])
    assert.equal(found[0].via, 'reply_to_ours')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('业务性失败（无评论等 mcp_tool_error）跳过不抛', async () => {
  const dir = tempDir()
  try {
    const store = new Store(dir)
    store.recordMyComment({ bvid: 'BV1none', rpid: 400, kind: 'author', ts: 't' })
    const mcp = stubMcp({})
    mcp.read = async () => { throw new McpToolError('mcp_tool_error', '没有该评论') }
    const found = await scanVideo(mcp, store, BOT_NAME, BOT_MID, 'BV1none')
    assert.equal(found.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
