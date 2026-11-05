/** Claude adapter. A factory stands in for the official SDK. Codex stays closed. @module */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import type { ExternalSdk, ExternalTurnInput } from './driver.ts'
import { HarnessAdapterError, HarnessBindingError } from './errors.ts'
import { ExternalQuotaError } from './quota.ts'

/** Official package name. Passed to import as a variable so this package declares no dependency. */
const CLAUDE_SDK = '@anthropic-ai/claude-agent-sdk'
const SERVER = 'dsh'
const SPAWN_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR'] as const
const DENIED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'AskUserQuestion']

/** One official SDK message the adapter reads. Payloads other than the result text are ignored. */
export interface ClaudeSdkMessage {
  /** Official message type. */
  type?: string
  /** Result subtype. Only `success` is accepted. */
  subtype?: string
  /** Assistant text on a success result. */
  result?: unknown
  /** True when the official result is an error payload. */
  is_error?: boolean
  /** Official session id captured for the sidecar. */
  session_id?: string
  /** Structured subscription limit notification; informational statuses never fail a turn. */
  rate_limit_info?: { status?: string; rateLimitType?: string; resetsAt?: number }
}

/** Async result of one official query, plus the SDK close hook when the module provides it. */
export interface ClaudeQuery extends AsyncIterable<ClaudeSdkMessage> {
  /** Stop the query. Absent on a plain async generator. */
  close?: (() => void) | undefined
}

/** Arguments the official custom spawn receives. */
export interface ClaudeSpawnOptions {
  /** Executable path supplied by the SDK. */
  command: string
  /** Direct arguments. Never shell-interpreted. */
  args: string[]
  /** Workspace the SDK copied from the query options. */
  cwd?: string
  /** Environment the SDK composed for the child. */
  env: Record<string, string | undefined>
  /** Signal the SDK forwards after its own grace window. */
  signal: AbortSignal
}

/** Process surface the official SDK accepts from a custom spawn. */
export interface ClaudeSpawnedProcess {
  /** Child standard input. */
  stdin: Writable
  /** Child standard output. */
  stdout: Readable
  /** True after a local kill request. */
  readonly killed: boolean
  /** Exit code after the child exits, otherwise null. */
  readonly exitCode: number | null
  /** Terminating signal, when the child published one. */
  readonly signalCode?: NodeJS.Signals | null
  /** Ask the child to stop. */
  kill(signal: NodeJS.Signals): boolean
  /** Listen until removed. */
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  /** Listen for a sanitized process failure. */
  on(event: 'error', listener: (error: Error) => void): void
  /** Listen once. */
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  /** Listen once for a sanitized process failure. */
  once(event: 'error', listener: (error: Error) => void): void
  /** Remove a listener. */
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  /** Remove a failure listener. */
  off(event: 'error', listener: (error: Error) => void): void
}

/** One in-process MCP tool definition passed to the official server helper. */
export interface ClaudeMcpTool {
  /** Tool name. */
  readonly name: string
}

/** Handler the official `tool` helper stores. */
export type ClaudeToolHandler = (args: unknown, extra: unknown) => Promise<{ content: readonly { type: 'text'; text: string }[]; isError: boolean }>

/** Official query options this adapter fills. Field names match claude-agent-sdk 0.3.263. */
export interface ClaudeQueryOptions {
  /** Cancelled when the DSH turn aborts. Never paired with `continue: true`. */
  abortController: AbortController
  /** Session workspace, not the harness directory. */
  cwd: string
  /** Profile model, when one is stored. */
  model?: string
  /** Captured official session id. The `fake:` placeholder is never passed. */
  resume?: string
  /** Keep the official transcript under the bound config directory. */
  persistSession: true
  /** Child environment. It replaces the parent environment. */
  env: Record<string, string>
  /** Ignore MCP configuration outside this option. */
  strictMcpConfig: true
  /** In-process server whose tools call the DSH bridge. */
  mcpServers: Record<string, { type: 'sdk'; name: string; instance: unknown }>
  /** Admitted bridge tools, in the official `mcp__server__tool` form. */
  allowedTools: string[]
  /** Built-in tools removed from the model. */
  disallowedTools: string[]
  /** No built-in Claude Code tools. */
  tools: []
  /** Unattended permission mode from the official union. */
  permissionMode: 'dontAsk'
  /** Deny every tool outside the admitted bridge set. */
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>
  /** Load no user, project, or local settings. */
  settingSources: []
  /** Profile instructions. The harness directory is not added here. */
  systemPrompt: string
  /** Hidden direct spawn owned by this process. */
  spawnClaudeCodeProcess: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess
}

/** Test seam and the shape the lazy official import must provide. */
export interface ClaudeQueryFactory {
  /** Start one query. The adapter iterates it and then closes it. */
  query(params: { prompt: string; options: ClaudeQueryOptions }): ClaudeQuery
  /** Define one in-process tool. Matches the official argument order. */
  tool(name: string, description: string, inputSchema: Record<string, unknown>, handler: ClaudeToolHandler): ClaudeMcpTool
  /** Build the in-process MCP server the official query option stores. */
  createSdkMcpServer(options: { name: string; tools: readonly ClaudeMcpTool[] }): { type: 'sdk'; name: string; instance: unknown }
}

/** Replacement points. Omit them to use the lazy official import and the local spawn. */
export interface ClaudeSdkDependencies {
  /** Injected SDK. When present the official package is not loaded. */
  readonly factory?: ClaudeQueryFactory
  /** Module loader. The default imports the official package by a variable specifier. */
  readonly load?: () => Promise<unknown>
  /** Process spawn. The default hides the console and refuses a shell. */
  readonly spawn?: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess
}

class HiddenProcess implements ClaudeSpawnedProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  private readonly events = new EventEmitter()
  private killedFlag = false
  private exitCodeValue: number | null = null
  private signalValue: NodeJS.Signals | null = null

  /** @param child - a direct child with piped input and output. */
  constructor(private readonly child: ChildProcess) {
    const stderr = child.stderr
    if (stderr !== null) stderr.resume()
    const stdin = child.stdin
    const stdout = child.stdout
    if (stdin === null || stdout === null) {
      child.kill()
      throw new HarnessAdapterError('process_failed')
    }
    this.stdin = stdin
    this.stdout = stdout
    this.events.on('error', () => {})
    child.on('exit', (code, signal) => {
      this.exitCodeValue = code
      this.signalValue = signal
      this.events.emit('exit', code, signal)
    })
    child.on('error', () => {
      this.events.emit('error', new HarnessAdapterError('process_failed'))
    })
  }

  /** Whether this adapter already asked the child to stop. */
  get killed(): boolean { return this.killedFlag }

  /** Direct-child exit code, or null while it is running. */
  get exitCode(): number | null { return this.exitCodeValue }

  /** Direct-child terminating signal, or null. */
  get signalCode(): NodeJS.Signals | null { return this.signalValue }

  /** @param signal - forwarded to the direct child. Returns false after exit or a previous request. */
  kill(signal: NodeJS.Signals): boolean {
    if (this.killedFlag || this.exitCodeValue !== null) return false
    this.killedFlag = true
    return this.child.kill(signal)
  }

  /** @param event - `exit` or `error`. @param listener - kept until removed. */
  on(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): void {
    this.events.on(event, listener)
  }

  /** @param event - `exit` or `error`. @param listener - removed after it runs. */
  once(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): void {
    this.events.once(event, listener)
  }

  /** @param event - `exit` or `error`. @param listener - previously registered listener. */
  off(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): void {
    this.events.off(event, listener)
  }
}

/**
 * Spawn one child with a hidden console, no shell, and piped standard streams.
 * @param options - command, arguments, workspace, environment, and signal.
 * @returns the SDK process view.
 */
export function startClaudeProcess(options: ClaudeSpawnOptions): ClaudeSpawnedProcess {
  try {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    })
    return new HiddenProcess(child)
  } catch {
    throw new HarnessAdapterError('process_failed')
  }
}

/**
 * Wrap a child that was already spawned. A missing pipe is a sanitized failure.
 * @param child - direct child. Null input or output kills it and throws.
 * @returns the SDK process view.
 */
export function hideClaudeProcess(child: ChildProcess): ClaudeSpawnedProcess {
  return new HiddenProcess(child)
}

/**
 * Build the Claude SDK seam. The bundled driver does not call this.
 * @param dependencies - injected factory, loader, or spawn. All are optional.
 * @returns an SDK the external driver can run.
 */
export function createClaudeSdk(dependencies: ClaudeSdkDependencies = {}): ExternalSdk {
  return { run: input => runClaudeTurn(input, dependencies) }
}

async function defaultLoad(): Promise<unknown> {
  return import(CLAUDE_SDK)
}

async function runClaudeTurn(
  input: ExternalTurnInput,
  dependencies: ClaudeSdkDependencies,
): Promise<{ text: string; sdkSessionId: string }> {
  if (input.runtime !== 'claude-sdk') throw new HarnessAdapterError('runtime_partial')
  if (input.signal.aborted) throw new HarnessAdapterError('session_unavailable')
  const cwd = input.cwd ?? ''
  const configDirectory = input.configDirectory ?? ''
  if (cwd.length === 0 || configDirectory.length === 0 || cwd === configDirectory) throw new HarnessAdapterError('session_unavailable')
  const factory = dependencies.factory ?? await loadFactory(dependencies.load ?? defaultLoad)
  return execute(factory, input, cwd, configDirectory, dependencies.spawn ?? startClaudeProcess)
}

async function loadFactory(load: () => Promise<unknown>): Promise<ClaudeQueryFactory> {
  try {
    return factoryFrom(await load())
  } catch (error) {
    if (error instanceof HarnessAdapterError) throw error
    throw new HarnessAdapterError('sdk_unavailable')
  }
}

function factoryFrom(loaded: unknown): ClaudeQueryFactory {
  if (typeof loaded !== 'object' || loaded === null) throw new HarnessAdapterError('sdk_unavailable')
  const value = loaded as Record<string, unknown>
  if (typeof value.query !== 'function' || typeof value.tool !== 'function' || typeof value.createSdkMcpServer !== 'function') {
    throw new HarnessAdapterError('sdk_unavailable')
  }
  const query = value.query as ClaudeQueryFactory['query']
  const tool = value.tool as ClaudeQueryFactory['tool']
  const createSdkMcpServer = value.createSdkMcpServer as ClaudeQueryFactory['createSdkMcpServer']
  return {
    query: params => query(params),
    tool: (name, description, schema, handler) => tool(name, description, schema, handler),
    createSdkMcpServer: options => createSdkMcpServer(options),
  }
}

function callId(extra: unknown, name: string): string {
  const id = typeof extra === 'object' && extra !== null && 'toolUseID' in extra ? extra.toolUseID : undefined
  return typeof id === 'string' && id.length > 0 ? id : name
}

function userPrompt(input: ExternalTurnInput): string {
  const lines: string[] = []
  for (const message of input.messages) {
    for (const block of message.content) {
      if (block.type === 'text') lines.push(block.text)
    }
  }
  return lines.join('\n')
}

function childEnvironment(configDirectory: string, bridge: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: configDirectory, ...bridge }
  for (const name of SPAWN_ENV) {
    const value = process.env[name]
    if (value !== undefined && value.length > 0) env[name] = value
  }
  return env
}

async function execute(
  factory: ClaudeQueryFactory,
  input: ExternalTurnInput,
  cwd: string,
  configDirectory: string,
  spawnProcess: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess,
): Promise<{ text: string; sdkSessionId: string }> {
  const abortController = new AbortController()
  const abort = (): void => { abortController.abort() }
  input.signal.addEventListener('abort', abort, { once: true })
  let cursor: ClaudeQuery | undefined
  let quota: ExternalQuotaError | undefined
  let partial = false
  const children: ClaudeSpawnedProcess[] = []
  try {
    cursor = factory.query({
      prompt: userPrompt(input),
      options: await queryOptions(factory, input, cwd, configDirectory, abortController, (options) => {
        const child = spawnProcess(options)
        children.push(child)
        return child
      }),
    })
    let text = ''
    let sdkSessionId = ''
    let succeeded = false
    for await (const message of cursor) {
      if (message.type === 'assistant' || message.type === 'stream_event') partial = true
      const limit = message.rate_limit_info
      if (message.type === 'rate_limit_event' && limit?.status === 'rejected'
        && (limit.rateLimitType === 'five_hour' || limit.rateLimitType === 'seven_day')) {
        const reset = limit.resetsAt
        quota = new ExternalQuotaError(typeof reset === 'number' && Number.isFinite(reset) && reset > 0 && reset <= 8.64e12 ? reset * 1000 : undefined, partial)
        throw quota
      }
      if (typeof message.session_id === 'string' && message.session_id.length > 0 && !message.session_id.startsWith('fake:')) sdkSessionId = message.session_id
      if (message.type !== 'result') continue
      if (message.subtype !== 'success' || message.is_error === true || typeof message.result !== 'string') throw new HarnessAdapterError('result_invalid')
      text = message.result
      succeeded = true
    }
    if (!succeeded || sdkSessionId.length === 0) throw new HarnessAdapterError('session_unavailable')
    return { text, sdkSessionId }
  } catch (error) {
    if (error instanceof ExternalQuotaError) throw error
    if (input.signal.aborted) throw new HarnessAdapterError('session_unavailable')
    if (error instanceof HarnessAdapterError || error instanceof HarnessBindingError) throw error
    throw new HarnessAdapterError('sdk_unavailable')
  } finally {
    try {
      cursor?.close?.()
      await Promise.all(children.map(stopProcess))
    }
    catch { throw new ExternalQuotaError(quota?.resetAt, true, true) }
    finally { input.signal.removeEventListener('abort', abort) }
  }
}

async function stopProcess(child: ClaudeSpawnedProcess): Promise<void> {
  if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') return
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => { clearTimeout(timer); child.off('exit', finish); resolve() }
    const timer = setTimeout(() => {
      child.off('exit', finish)
      reject(new HarnessAdapterError('process_failed'))
    }, 2000)
    child.once('exit', finish)
    try { child.kill('SIGTERM') }
    catch (error) { clearTimeout(timer); child.off('exit', finish); reject(error) }
  })
}

async function queryOptions(
  factory: ClaudeQueryFactory,
  input: ExternalTurnInput,
  cwd: string,
  configDirectory: string,
  abortController: AbortController,
  spawnProcess: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess,
): Promise<ClaudeQueryOptions> {
  const schemas = await input.tools.list()
  const admitted = new Set<string>()
  const tools = schemas.map((schema) => {
    const officialName = `mcp__${SERVER}__${schema.name}`
    admitted.add(officialName)
    return factory.tool(schema.name, schema.description, schema.inputSchema, async (args, extra) => {
      try {
        const result = await input.tools.call(callId(extra, schema.name), schema.name, args)
        return { content: result.content.map(block => ({ type: 'text' as const, text: block.text })), isError: result.isError }
      } catch {
        return { content: [{ type: 'text', text: 'tool_denied' }], isError: true }
      }
    })
  })
  const resume = input.sdkSessionId.startsWith('fake:') ? undefined : input.sdkSessionId
  return {
    abortController,
    cwd,
    ...input.runtimeModel ? { model: input.runtimeModel } : {},
    ...resume === undefined ? {} : { resume },
    persistSession: true,
    env: childEnvironment(configDirectory, input.tools.childEnv()),
    strictMcpConfig: true,
    mcpServers: { [SERVER]: factory.createSdkMcpServer({ name: SERVER, tools }) },
    allowedTools: [...admitted],
    disallowedTools: DENIED_TOOLS,
    tools: [],
    permissionMode: 'dontAsk',
    canUseTool: toolName => admitted.has(toolName)
      ? Promise.resolve({ behavior: 'allow' as const })
      : Promise.resolve({ behavior: 'deny' as const, message: 'tool_denied' }),
    settingSources: [],
    systemPrompt: input.instructions,
    spawnClaudeCodeProcess: options => spawnProcess(options),
  }
}
