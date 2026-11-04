/** In-process tool bridge and loopback transport for one external step. @module */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-runtime/accounts'
import type { ResolvedToolSet, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { HarnessBindingError } from './errors.ts'

/** One admitted schema. Identity fields stay out of the model arguments. */
export interface TurnToolSchema {
  /** Registered tool name. */
  readonly name: string
  /** Model-facing description. */
  readonly description: string
  /** JSON schema already projected for the model. */
  readonly inputSchema: Record<string, unknown>
}

/** One bridge result. A tool error does not by itself fail the turn. */
export interface TurnToolResult {
  /** Text the external runtime may show. Paths and credentials are not added here. */
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  /** True when the executor or the bridge refused the call. */
  readonly isError: boolean
  /** Bridge refusal. Absent when the executor produced the result. */
  readonly code?: 'tool_denied' | 'permission_required' | 'cancelled' | 'closed'
}

/**
 * Process-local tool server for one step.
 * Codex reaches the same server through {@link TurnToolBridge.endpoint}.
 */
export interface TurnToolBridge {
  /** Loopback URL without the credential. */
  readonly endpoint: string
  /**
   * List the tools admitted for this step.
   * @returns schemas for memory, mailbox, routines and tables.
   */
  list(): Promise<readonly TurnToolSchema[]>
  /**
   * Run one admitted call through the host executor.
   * @param id - caller id. A repeat returns the first result and does not run again.
   * @param name - tool name.
   * @param args - model arguments.
   * @returns the executor result, or a refusal.
   */
  call(id: string, name: string, args: unknown): Promise<TurnToolResult>
  /**
   * Header value for the loopback client.
   * @returns the bearer header. Do not write it to a URL, history or harness config.
   */
  authorizationHeader(): string
  /**
   * Private environment for a later child process.
   * @returns a fresh map. The bridge does not write it.
   */
  childEnv(): Readonly<Record<string, string>>
  /**
   * Stop list, call and the loopback server.
   * @returns resolves after the port is closed.
   */
  close(): Promise<void>
}

/** Host inputs for {@link openTurnBridge}. */
export interface TurnBridgeInput {
  /** Deployment context that owns tools, accounts and bindings. */
  readonly host: Context
  /** Agent whose scope and Session receive the call. */
  readonly agent: Agent
  /** Account that must stay active. `owner` is the legacy single-user id. */
  readonly ownerId: string
  /** Durable turn number passed to the executor log. */
  readonly turn: number
  /** Step number passed to the executor log. */
  readonly step: number
  /** Model label stored on the profile. Not an API route. */
  readonly model: string
  /** Aborted when the turn is cancelled. */
  readonly signal: AbortSignal
  /** Cancels the live turn when the account or the binding can no longer be used. */
  readonly onEnded: () => void
}

const ALLOWED = new Set([
  'remember', 'forget_memory', 'search_memories', 'list_memories',
  'agent_send_message', 'agent_list', 'agent_interrupt', 'agent_grant_access',
  'agent_revoke_access', 'agent_list_grants', 'agent_list_sections', 'agent_move_section',
  'routine_create', 'routine_update', 'routine_list', 'routine_test', 'routine_no_update',
  'table_create', 'table_list', 'table_schema', 'table_alter', 'table_drop',
  'data_query', 'data_execute', 'data_batch',
])

const FORBIDDEN = new Set([
  'ownerId', 'owner_id', 'senderId', 'sender_id', 'runtime',
  'configDirectory', 'config_directory', 'cwd', 'workspace', 'harnessPath', 'harness_path',
])

const BODY_LIMIT = 1_048_576
const PROTOCOL = '2025-03-26'

const CLOSED: TurnToolResult = { content: [{ type: 'text', text: 'closed' }], isError: true, code: 'closed' }
const CANCELLED: TurnToolResult = { content: [{ type: 'text', text: 'cancelled' }], isError: true, code: 'cancelled' }
const FAILED: TurnToolResult = { content: [{ type: 'text', text: 'tool call failed' }], isError: true, code: 'tool_denied' }

function denied(code: NonNullable<TurnToolResult['code']>, text: string): TurnToolResult {
  return { content: [{ type: 'text', text }], isError: true, code }
}

function same(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

function forbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbidden)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, child]) => FORBIDDEN.has(key) || forbidden(child))
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  let text = ''
  for (const block of content) if (block.type === 'text' && block.text !== undefined) text += block.text
  return text
}

function hostOk(value: string | undefined): boolean {
  /* v8 ignore next -- Node sets Host on every TCP request this server accepts */
  if (value === undefined) return false
  const name = value.replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost'
}

function originOk(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

function bearer(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false
  const match = /^Bearer (.+)$/.exec(header)
  const presented = match?.[1]
  if (presented === undefined) return false
  return same(presented, expected)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Uint8Array)
    size += buf.length
    if (size > BODY_LIMIT) throw new Error('too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

class StepBridge {
  private readonly token = randomBytes(32).toString('base64url')
  private readonly server: Server
  private readonly seen = new Map<string, TurnToolResult>()
  private gate: Promise<void> = Promise.resolve()
  private toolSet: ResolvedToolSet | undefined
  private sessionId = ''
  private port = 0
  private closed = false
  endpoint = ''

  constructor(private readonly input: TurnBridgeInput) {
    this.server = createServer((req, res) => {
      void this.http(req, res)
    })
  }

  /** Reject a dead account or a stale binding before the port opens. */
  prepare(): Promise<void> {
    return this.admit()
  }

  async listen(): Promise<void> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    /* v8 ignore next -- TCP listen on 127.0.0.1 returns AddressInfo */
    if (address === null || typeof address === 'string') throw new Error('loopback listen failed')
    this.port = address.port
    this.endpoint = `http://127.0.0.1:${this.port}/mcp`
  }

  authorizationHeader(): string {
    return `Bearer ${this.token}`
  }

  childEnv(): Readonly<Record<string, string>> {
    return { MCP_LOOPBACK_AUTHORIZATION: this.authorizationHeader() }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.toolSet?.dispose()
    this.toolSet = undefined
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => { this.server.close(() => resolve()) })
  }

  async list(): Promise<readonly TurnToolSchema[]> {
    if (this.closed || this.input.signal.aborted) throw new Error('closed')
    await this.admit()
    const tools = this.input.host.get('tools')
    if (tools === undefined) throw new HarnessBindingError('binding_missing')
    return tools.schemas(this.input.agent, this.toolSet)
      .filter(schema => ALLOWED.has(schema.name))
      .map(schema => ({ name: schema.name, description: schema.description, inputSchema: schema.parameters }))
  }

  call(id: string, name: string, args: unknown): Promise<TurnToolResult> {
    return this.exclusive(() => this.once(id, name, args))
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.gate
    let release!: () => void
    this.gate = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }

  private async once(id: string, name: string, args: unknown): Promise<TurnToolResult> {
    if (this.closed) return CLOSED
    if (this.input.signal.aborted) return CANCELLED
    const cached = this.seen.get(id)
    if (cached !== undefined) return cached
    if (!ALLOWED.has(name)) return this.remember(id, denied('tool_denied', 'tool_denied'))
    if (forbidden(args)) return this.remember(id, denied('tool_denied', 'tool_denied'))
    try {
      await this.admit()
    } catch (error) {
      this.input.onEnded()
      const text = error instanceof HarnessBindingError ? error.code : 'tool_denied'
      return this.remember(id, denied('tool_denied', text))
    }
    if (this.closed || this.input.signal.aborted) return CANCELLED
    let batch: { results: readonly { result: ToolExecutionResult }[]; additionalContexts: readonly UserMessage[] }
    try {
      const tools = this.input.host.get('tools')
      if (tools === undefined) throw new HarnessBindingError('binding_missing')
      const toolSet = this.toolSet
      /* v8 ignore next -- admit assigns the tool set or throws */
      if (toolSet === undefined) throw new HarnessBindingError('binding_missing')
      batch = await tools.execute({
        agent: this.input.agent,
        signal: this.input.signal,
        toolSet,
        log: { turn: this.input.turn, step: this.input.step },
        calls: [{ type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args ?? {}) }],
      })
    } catch {
      if (this.closed || this.input.signal.aborted) return CANCELLED
      return this.remember(id, FAILED)
    }
    for (const message of batch.additionalContexts) this.input.agent.inject(message)
    const outcome = batch.results[0]?.result
    /* v8 ignore next -- the executor returns one result for the one call in this batch */
    if (outcome === undefined) return this.remember(id, FAILED)
    if (this.closed || this.input.signal.aborted) return CANCELLED
    const message = outcome.isError ? outcome.error.message : ''
    const code = message.includes('requires approval') ? 'permission_required' as const : undefined
    const mapped: TurnToolResult = {
      content: [{ type: 'text', text: textOf(outcome.content) }],
      isError: outcome.isError,
      ...(code === undefined ? {} : { code }),
    }
    return this.remember(id, mapped)
  }

  private remember(id: string, result: TurnToolResult): TurnToolResult {
    this.seen.set(id, result)
    return result
  }

  private async admit(): Promise<void> {
    if (this.input.ownerId !== 'owner') {
      const accounts = this.input.host.get('accounts')
      if (accounts === undefined) throw new HarnessBindingError('binding_missing')
      const account = accounts.list().find(entry => entry.id === this.input.ownerId)
      if (account === undefined || account.state !== 'active') throw new HarnessBindingError('account_inactive')
    }
    const bindings = this.input.host.get('harnessBindings')
    if (bindings === undefined) throw new HarnessBindingError('binding_missing')
    const workspace = this.input.agent.session.header.cwd
    if (workspace === undefined || workspace.length === 0) throw new HarnessBindingError('binding_missing')
    await bindings.resolve(this.input.agent.id, workspace)
    this.input.signal.throwIfAborted()
    this.toolSet?.dispose()
    const tools = this.input.host.get('tools')
    if (tools === undefined) throw new HarnessBindingError('binding_missing')
    this.toolSet = await tools.resolve({
      agent: this.input.agent,
      modelSelection: { provider: 'external', model: this.input.model },
      signal: this.input.signal,
    })
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      /* v8 ignore next -- Node sets the request URL */
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!hostOk(req.headers.host) || !originOk(header(req, 'origin'), this.port)) {
        write(res, 403, 'forbidden')
        return
      }
      if (url.pathname !== '/mcp' || url.search !== '') {
        write(res, 404, 'not found')
        return
      }
      if (!bearer(header(req, 'authorization'), this.token)) {
        write(res, 401, 'unauthorized')
        return
      }
      if (req.method === 'DELETE') {
        this.delete(req, res)
        return
      }
      if (req.method !== 'POST') {
        write(res, 405, 'method')
        return
      }
      const version = header(req, 'mcp-protocol-version')
      if (version !== undefined && version !== PROTOCOL) {
        write(res, 400, 'protocol')
        return
      }
      const body = await readBody(req)
      const message = JSON.parse(body) as { id?: unknown; method?: unknown; params?: unknown }
      await this.route(req, res, message)
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'too large'
      /* v8 ignore next -- a handler that already replied must not write again */
      if (res.headersSent) return
      write(res, tooLarge ? 413 : 400, tooLarge ? 'too large' : 'bad request')
      req.destroy()
    }
  }

  private delete(req: IncomingMessage, res: ServerResponse): void {
    const session = header(req, 'mcp-session-id')
    if (session === undefined || this.sessionId === '' || !same(session, this.sessionId)) {
      write(res, 404, 'not found')
      return
    }
    write(res, 204, '')
    void this.close()
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    message: { id?: unknown; method?: unknown; params?: unknown },
  ): Promise<void> {
    const method = message.method
    const id = message.id ?? null
    if (method === 'initialize') {
      if (this.sessionId !== '') {
        rpc(res, id, { code: -32600, message: 'already initialized' })
        return
      }
      this.sessionId = randomBytes(16).toString('hex')
      rpc(res, id, undefined, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-external-tools', version: '1' },
      }, this.sessionId)
      return
    }
    if (method === 'notifications/initialized') {
      write(res, 202, '')
      return
    }
    const session = header(req, 'mcp-session-id')
    if (session === undefined || this.sessionId === '' || !same(session, this.sessionId)) {
      write(res, 404, 'not found')
      return
    }
    if (method === 'ping') {
      rpc(res, id, undefined, {})
      return
    }
    if (method === 'tools/list') {
      try {
        const tools = await this.list()
        rpc(res, id, undefined, {
          tools: tools.map(tool => ({
            name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          })),
        })
      } catch {
        rpc(res, id, { code: -32001, message: 'closed' })
      }
      return
    }
    if (method === 'tools/call') {
      const params = message.params
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        rpc(res, id, { code: -32602, message: 'invalid params' })
        return
      }
      const name = 'name' in params ? params.name : undefined
      const args = 'arguments' in params ? params.arguments : {}
      const callId = 'callId' in params && typeof params.callId === 'string' ? params.callId : `rpc:${String(id)}`
      if (typeof name !== 'string' || typeof args !== 'object' || args === null || Array.isArray(args)) {
        rpc(res, id, { code: -32602, message: 'invalid params' })
        return
      }
      const result = await this.call(callId, name, args)
      rpc(res, id, undefined, {
        content: result.content,
        isError: result.isError,
        ...(result.code === undefined ? {} : { code: result.code }),
      })
      return
    }
    rpc(res, id, { code: -32601, message: 'method' })
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function write(res: ServerResponse, status: number, body: string): void {
  /* v8 ignore next -- callers send one response */
  if (res.headersSent) return
  const headers = status === 204 ? {} : { 'content-type': 'text/plain; charset=utf-8' }
  res.writeHead(status, headers)
  res.end(status === 204 ? undefined : body)
}

function rpc(
  res: ServerResponse,
  id: unknown,
  error: { code: number; message: string } | undefined,
  result?: unknown,
  session?: string,
): void {
  const payload = error === undefined
    ? { jsonrpc: '2.0', id, result }
    : { jsonrpc: '2.0', id, error }
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
  if (session !== undefined) headers['mcp-session-id'] = session
  /* v8 ignore next -- callers send one response */
  if (res.headersSent) return
  res.writeHead(200, headers)
  res.end(JSON.stringify(payload))
}

/**
 * Open the step bridge and bind it to loopback.
 * The credential stays in memory. Nothing here reads or writes a harness login.
 * @param input - agent, step and the callback that cancels the turn when the account or binding ends.
 * @returns the live bridge. The caller closes it when the step ends.
 */
export async function openTurnBridge(input: TurnBridgeInput): Promise<TurnToolBridge> {
  const bridge = new StepBridge(input)
  try {
    await bridge.prepare()
    await bridge.listen()
  } catch (error) {
    await bridge.close()
    throw error
  }
  return {
    endpoint: bridge.endpoint,
    list: () => bridge.list(),
    call: (id, name, args) => bridge.call(id, name, args),
    authorizationHeader: () => bridge.authorizationHeader(),
    childEnv: () => bridge.childEnv(),
    close: () => bridge.close(),
  }
}
