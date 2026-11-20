// 本地 mock 的未雨 MCP server（HTTP streamable-json，非 SSE）：仅覆盖插件用到的
// 工具，供 smoke 与单测使用。记录全部 tools/call 调用供断言。
import { createServer } from 'node:http'

export function startMockWeiyu({ token = 'mock-token-0123456789abcdef', port = 0 } = {}) {
  const state = {
    calls: [],
    commentsByBvid: {},
    repliesByRoot: {},
    titles: {},
    videos: {},
    messageFeeds: {},
    nextRpid: 5000,
    loginStatus: { configured: true, write_enabled: true, comment_enabled: true, write_ready: true },
    user: { mid: 3707006871407373, uname: 'bilblicopy', level: 2, coins: 21 },
    failTools: {},
  }
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/mcp')) {
      response.writeHead(404).end()
      return
    }
    const auth = request.headers.authorization ?? ''
    if (auth !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { response.writeHead(400).end(); return }
      const respond = (payload, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json', 'mcp-session-id': 'mock-session' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, ...payload }))
      }
      const reply = (result, status) => respond({ result }, status)
      if (body.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock-weiyu', version: '0.0.1' } })
      if (body.method === 'notifications/initialized') return reply({}, 202)
      if (body.method === 'tools/list') {
        return reply({
          tools: [
            { name: 'get_login_status', inputSchema: { type: 'object' } },
            { name: 'get_current_user', inputSchema: { type: 'object' } },
            { name: 'get_video_comments', inputSchema: { type: 'object' } },
            { name: 'get_comment_replies', inputSchema: { type: 'object' } },
            { name: 'parse_video', inputSchema: { type: 'object' } },
            { name: 'post_comment', inputSchema: { type: 'object' } },
            { name: 'like_video', inputSchema: { type: 'object' } },
            { name: 'coin_video', inputSchema: { type: 'object' } },
            ...Object.keys(state.messageFeeds).map((name) => ({ name, inputSchema: { type: 'object' } })),
          ],
        })
      }
      if (body.method !== 'tools/call') return reply({ error: { code: -32601, message: `未知方法 ${body.method}` } })
      const name = body.params?.name
      const args = body.params?.arguments ?? {}
      state.calls.push({ tool: name, args, at: Date.now() })
      if (state.failTools[name]) return reply({ content: [{ type: 'text', text: String(state.failTools[name]) }], isError: true })
      switch (name) {
        case 'get_login_status': return reply({ structuredContent: state.loginStatus, isError: false })
        case 'get_current_user': return reply({ structuredContent: state.user, isError: false })
        case 'get_video_comments': return reply({ structuredContent: { replies: state.commentsByBvid[args.bvid] ?? [] }, isError: false })
        case 'get_comment_replies': return reply({ structuredContent: { replies: state.repliesByRoot[`${args.bvid}:${args.root_rpid}`] ?? [] }, isError: false })
        case 'parse_video': return reply({ structuredContent: state.videos[args.url] ?? { bvid: args.url, title: state.titles[args.url] ?? `视频 ${args.url}` }, isError: false })
        case 'get_at_feed':
        case 'get_reply_feed': {
          const pages = state.messageFeeds[name]
          if (!pages) return respond({ error: { code: -32602, message: `未知工具：${name}` } })
          const page = pages[args.last_id ?? 0] ?? { cursor: { is_end: true }, items: [] }
          return reply({ structuredContent: page, isError: false })
        }
        case 'post_comment': {
          if (typeof args.bvid !== 'string' || typeof args.message !== 'string' || !args.message.trim()) {
            return reply({ content: [{ type: 'text', text: 'bvid/message 缺失' }], isError: true })
          }
          if (Array.isArray(args.mentions) && !args.message.includes(`@${args.mentions[0]?.name}`)) {
            return reply({ content: [{ type: 'text', text: 'mentions 必须与正文 @昵称 对应' }], isError: true })
          }
          return reply({ structuredContent: { rpid: ++state.nextRpid, bvid: args.bvid }, isError: false })
        }
        case 'like_video': return reply({ structuredContent: { ok: true }, isError: false })
        case 'coin_video': return reply({ structuredContent: { ok: true }, isError: false })
        default: return reply({ content: [{ type: 'text', text: `未实现的工具 ${name}` }], isError: true })
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        token,
        state,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

export function sampleComment(rpid, { parent = 0, root = 0, mid = 100, uname = '路人', message = '评论' } = {}) {
  return { rpid, parent, root, member: { mid, uname }, content: { message }, ctime: Math.floor(Date.now() / 1000) }
}
