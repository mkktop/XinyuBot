// 未雨 MCP（weiyu-mcp）直连客户端：插件自己读评论/发评论用的轻量
// streamable-http JSON-RPC 客户端（与 preset 里 dsh-mcp-client 挂载的同一服务）。
// 服务端限速 2 qps：这里串行化调用并保持最小间隔，避免 429。
// 握手遵循 MCP streamable-http：initialize → notifications/initialized → 后续调用带 Mcp-Session-Id。

export class McpToolError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

type CallResult = { ok: true; data: any } | { ok: false; code: string; message: string }

export class WeiyuMcp {
  private url: string
  private token: string
  private timeoutMs: number
  private sessionId: string | null = null
  private nextId = 1
  /** 串行化 + 最小间隔（服务端 2 qps，取 550ms 保守值） */
  private queue: Promise<unknown> = Promise.resolve()
  private lastCallAt = 0
  static MIN_GAP_MS = 550

  constructor(url: string, token: string, timeoutMs: number) {
    this.url = url.replace(/\/+$/, '')
    this.token = token
    this.timeoutMs = timeoutMs
  }

  /** 外部已持有的会话排队器，保证并发安全与限速。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async requestRaw(body: unknown, sessionId: string | null): Promise<{ status: number; headers: Headers; text: string }> {
    const response = await fetch(this.url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${this.token}`,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await response.text()
    return { status: response.status, headers: response.headers, text }
  }

  private extractData(text: string): any {
    const trimmed = text.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('{')) { try { return JSON.parse(trimmed) } catch { return null } }
    // SSE：取最后一个 data: 行里的 JSON
    const lines = trimmed.split('\n').filter((line) => line.startsWith('data:'))
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const payload = lines[i].slice(5).trim()
      if (!payload) continue
      try { return JSON.parse(payload) } catch { continue }
    }
    return null
  }

  private async handshake() {
    const response = await this.requestRaw({
      jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'xinyu-bilibili', version: '0.1.0' } },
    }, null)
    if (response.status !== 200) throw new McpToolError('mcp_init_failed', `MCP initialize 失败（HTTP ${response.status}）`)
    const data = this.extractData(response.text)
    const sid = response.headers.get('mcp-session-id') ?? data?.result?._meta?.session ?? null
    this.sessionId = typeof sid === 'string' ? sid : null
    if (this.sessionId) {
      try {
        await this.requestRaw({ jsonrpc: '2.0', method: 'notifications/initialized' }, this.sessionId)
      } catch { /* 通知失败不阻塞 */ }
    }
  }

  /** 调一个工具；返回解析后的负载（structuredContent 优先，否则 content[0].text 的 JSON/文本）。 */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.enqueue(async () => {
      const attempt = async (): Promise<CallResult> => {
        if (!this.sessionId) await this.handshake()
        const gap = WeiyuMcp.MIN_GAP_MS - (Date.now() - this.lastCallAt)
        if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
        this.lastCallAt = Date.now()
        const response = await this.requestRaw({
          jsonrpc: '2.0', id: this.nextId++, method: 'tools/call',
          params: { name: tool, arguments: args },
        }, this.sessionId)
        if (response.status === 404 || response.status === 400) {
          // 会话失效：重握手后由外层重试一次
          this.sessionId = null
          return { ok: false, code: 'mcp_session_lost', message: 'MCP 会话失效' }
        }
        if (response.status !== 200) return { ok: false, code: 'mcp_http_error', message: `MCP 调用失败（HTTP ${response.status}）` }
        const data = this.extractData(response.text)
        if (!data || data.jsonrpc === undefined || data.error) {
          const message = data?.error?.message ?? 'MCP 响应格式不正确'
          return { ok: false, code: String(data?.error?.code ?? 'mcp_rpc_error'), message }
        }
        const result = data.result
        if (result?.isError) {
          const first = Array.isArray(result.content) ? result.content.find((c: any) => c?.type === 'text') : null
          return { ok: false, code: 'mcp_tool_error', message: String(first?.text ?? result?.content ?? '工具执行失败').slice(0, 1000) }
        }
        if (result?.structuredContent !== undefined) return { ok: true, data: result.structuredContent }
        const first = Array.isArray(result?.content) ? result.content.find((c: any) => c?.type === 'text') : null
        if (first?.type === 'text') {
          const text = String(first.text)
          if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
            try { return { ok: true, data: JSON.parse(text) } } catch { /* 落回纯文本 */ }
          }
          return { ok: true, data: text }
        }
        return { ok: true, data: result }
      }

      let outcome = await attempt()
      if (!outcome.ok && outcome.code === 'mcp_session_lost') outcome = await attempt()
      if (!outcome.ok) throw new McpToolError(outcome.code, outcome.message)
      return outcome.data
    })
  }

  /** 便捷：只读调用，失败抛 McpToolError。 */
  async read<T = any>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.call(tool, args)) as T
  }
}
