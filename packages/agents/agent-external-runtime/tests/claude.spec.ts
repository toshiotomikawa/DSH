import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'
import { HarnessAdapterError, HarnessBindingError } from '../src/errors.ts'
import {
  createClaudeSdk, hideClaudeProcess, startClaudeProcess,
  type ClaudeQuery, type ClaudeQueryFactory, type ClaudeQueryOptions, type ClaudeSdkMessage,
  type ClaudeSpawnedProcess, type ClaudeToolHandler,
} from '../src/claude.ts'
import type { ExternalTurnInput } from '../src/driver.ts'
import type { TurnToolBridge } from '../src/bridge.ts'
import { ExternalQuotaError } from '../src/quota.ts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const SECRET = 'C:\\harness-secret\\auth.json'

function quotaFactory(messages: ClaudeSdkMessage[], close?: () => void): ClaudeQueryFactory {
  return {
    query: () => textQuery(messages, close),
    tool: name => ({ name }),
    createSdkMcpServer: server => ({ type: 'sdk', name: server.name, instance: {} }),
  }
}

it.each([
  { rateLimitType: 'five_hour', resetsAt: 2000000000, partial: false },
  { rateLimitType: 'seven_day', resetsAt: undefined, partial: true },
  { rateLimitType: 'five_hour', resetsAt: Number.NaN, partial: true },
  { rateLimitType: 'five_hour', resetsAt: 0, partial: false },
  { rateLimitType: 'five_hour', resetsAt: 9e12, partial: false },
])('classifies only a rejected subscription bucket, preserving partial-output refusal: %j', async (value) => {
  const factory = quotaFactory([
    ...(value.partial ? [{ type: 'assistant' }, { type: 'stream_event' }] : []),
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: value.rateLimitType,
      ...(value.resetsAt === undefined ? {} : { resetsAt: value.resetsAt }) } },
  ])
  const error = await createClaudeSdk({ factory }).run(turn()).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ExternalQuotaError)
  expect(error).toMatchObject({ afterEffects: value.partial, code: 'EXTERNAL_QUOTA_EXHAUSTED' })
  expect((error as ExternalQuotaError).resetAt).toBe(value.resetsAt === 2000000000 ? 2000000000000 : undefined)
})

it.each([
  {}, { status: 'allowed', rateLimitType: 'five_hour' }, { status: 'allowed_warning', rateLimitType: 'seven_day' },
  { status: 'rejected', rateLimitType: 'unknown' }, { status: 'rejected' },
])('does not treat informational or unknown limits as exhausted subscription: %j', async (info) => {
  const factory = quotaFactory([{ type: 'rate_limit_event', rate_limit_info: info }, success()])
  await expect(createClaudeSdk({ factory }).run(turn())).resolves.toMatchObject({ text: 'answer' })
})

it.each([false, true])('refuses activation if SDK close fails (quota=%s)', async (limited) => {
  const factory = quotaFactory(limited
    ? [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2000000000 } }]
    : [success()], () => { throw new Error(SECRET) })
  await expect(createClaudeSdk({ factory }).run(turn())).rejects.toMatchObject({ code: 'EXTERNAL_TEARDOWN_FAILED', teardownFailed: true })
})

it.each(['exited', 'exit-after-kill', 'timeout', 'kill-throws'] as const)('waits for a spawned SDK child before settling: %s', async (mode) => {
  let closed: (() => void) | undefined
  const child: ClaudeSpawnedProcess = { ...fakeProcess(),
    exitCode: mode === 'exited' ? 0 : null,
    once: (_event, listener) => { closed = () => { (listener as (code: number, signal: null) => void)(0, null) } },
    kill: () => {
      if (mode === 'kill-throws') throw new Error(SECRET)
      if (mode === 'exit-after-kill') closed!()
      return true
    },
  }
  const factory = quotaFactory([success()])
  const query = factory.query
  factory.query = (params) => {
    params.options.spawnClaudeCodeProcess({ command: 'fake', args: [], env: {}, signal: params.options.abortController.signal })
    return query(params)
  }
  const result = createClaudeSdk({ factory, spawn: () => child }).run(turn())
  if (mode === 'timeout' || mode === 'kill-throws') await expect(result).rejects.toMatchObject({ teardownFailed: true })
  else await expect(result).resolves.toMatchObject({ text: 'answer' })
})

function textQuery(messages: readonly ClaudeSdkMessage[], close?: () => void): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message
    },
    close,
  }
}

function bridge(partial: Partial<TurnToolBridge> = {}): TurnToolBridge {
  return {
    endpoint: 'http://127.0.0.1:9/mcp',
    list: () => Promise.resolve([{ name: 'remember', description: 'save', inputSchema: { type: 'object' } }]),
    call: () => Promise.resolve({ content: [{ type: 'text', text: 'saved' }], isError: false }),
    authorizationHeader: () => 'Bearer secret-token',
    childEnv: () => ({ MCP_LOOPBACK_AUTHORIZATION: 'Bearer secret-token' }),
    close: () => Promise.resolve(),
    ...partial,
  }
}

function turn(partial: Partial<ExternalTurnInput> = {}): ExternalTurnInput {
  return {
    sessionId: 'session-1',
    turn: 1,
    step: 1,
    messages: [createUserMessage({
      content: [{ type: 'reasoning', text: 'hidden-thought' }, { type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    })],
    instructions: 'stay inside the workspace',
    signal: new AbortController().signal,
    sdkSessionId: SESSION,
    runtimeModel: 'claude-test',
    runtime: 'claude-sdk',
    tools: bridge(),
    cwd: 'C:\\workspace',
    configDirectory: 'C:\\harness',
    ...partial,
  }
}

function success(sessionId = SESSION): ClaudeSdkMessage {
  return { type: 'result', subtype: 'success', result: 'answer', session_id: sessionId }
}

function fakeProcess(): ClaudeSpawnedProcess {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    kill: () => false,
    on: () => {},
    once: () => {},
    off: () => {},
  }
}

async function worktree(): Promise<string> {
  await mkdir(join(process.cwd(), '.dsh-test'), { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test', 'm8-fatia4-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

it('runs a fake official query and keeps the harness directory out of the prompt', async () => {
  process.env.M8_SLICE4_TOKEN = 'synthetic'
  const savedPathExt = process.env.PATHEXT
  const savedWindir = process.env.WINDIR
  delete process.env.PATHEXT
  process.env.WINDIR = ''
  const calls: unknown[] = []
  let options: ClaudeQueryOptions | undefined
  let prompt = ''
  const factory: ClaudeQueryFactory = {
    query: (params) => {
      options = params.options
      prompt = params.prompt
      return textQuery([
        { type: 'system' },
        { type: 'system', session_id: '' },
        { type: 'system', session_id: 'fake:nope' },
        { type: 'system', session_id: SESSION },
        success(),
      ])
    },
    tool: (name, description, schema, handler) => {
      calls.push({ name, description, schema, handler })
      return { name }
    },
    createSdkMcpServer: server => ({ type: 'sdk', name: server.name, instance: { tools: server.tools } }),
  }
  try {
    const result = await createClaudeSdk({ factory, spawn: () => fakeProcess(), load: () => Promise.reject(new Error('loaded')) }).run(turn())
    expect(result).toEqual({ text: 'answer', sdkSessionId: SESSION })
    expect(prompt).toBe('hello')
    expect(prompt).not.toContain('hidden-thought')
    expect(prompt).not.toContain('C:\\harness')
    expect(options).toMatchObject({
      cwd: 'C:\\workspace',
      model: 'claude-test',
      resume: SESSION,
      persistSession: true,
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      tools: [],
      settingSources: [],
      systemPrompt: 'stay inside the workspace',
      allowedTools: ['mcp__dsh__remember'],
    })
    expect(options !== undefined && !Object.hasOwn(options, 'continue')).toBe(true)
    expect(options?.disallowedTools).toContain('Bash')
    expect(options?.env.CLAUDE_CONFIG_DIR).toBe('C:\\harness')
    expect(options?.env.MCP_LOOPBACK_AUTHORIZATION).toBe('Bearer secret-token')
    expect(options?.env.M8_SLICE4_TOKEN).toBeUndefined()
    expect(options?.env.PATHEXT).toBeUndefined()
    expect(options?.env.WINDIR).toBeUndefined()
    expect(options?.env.PATH).toBe(process.env.PATH)
    expect(JSON.stringify(options)).not.toContain('auth.json')
    expect(options?.systemPrompt).not.toContain('C:\\harness')
    const seen: unknown[] = []
    const tools = bridge({
      call: (id, name, args) => {
        seen.push({ id, name, args })
        if (id === 'explode') return Promise.reject(new Error(SECRET))
        return Promise.resolve({ content: [{ type: 'text', text: 'saved' }], isError: false })
      },
    })
    const input = turn({ tools })
    const again = createClaudeSdk({
      factory: {
        ...factory,
        query: (params) => {
          options = params.options
          return textQuery([success()])
        },
      },
      spawn: (spec) => {
        seen.push(spec)
        return fakeProcess()
      },
    })
    await again.run(input)
    const handler = (calls.at(-1) as { handler: ClaudeToolHandler }).handler
    expect(await handler({ text: 'note' }, { toolUseID: 'call-1' })).toMatchObject({ isError: false })
    expect(await handler({ text: 'note' }, { toolUseID: 'call-1' })).toMatchObject({ isError: false })
    expect(await handler({}, null)).toMatchObject({ content: [{ text: 'saved' }] })
    expect(await handler({}, 1)).toMatchObject({ isError: false })
    expect(await handler({}, {})).toMatchObject({ isError: false })
    expect(await handler({}, { toolUseID: 1 })).toMatchObject({ isError: false })
    expect(await handler({}, { toolUseID: '' })).toMatchObject({ isError: false })
    expect(await handler({}, { toolUseID: 'explode' })).toMatchObject({ isError: true, content: [{ text: 'tool_denied' }] })
    expect(JSON.stringify(seen)).not.toContain(SECRET)
    expect(seen).toContainEqual({ id: 'call-1', name: 'remember', args: { text: 'note' } })
    expect(seen).toContainEqual({ id: 'remember', name: 'remember', args: {} })
    await options?.canUseTool('mcp__dsh__remember', {})
    await expect(options?.canUseTool('Bash', {})).resolves.toEqual({ behavior: 'deny', message: 'tool_denied' })
    expect(options?.spawnClaudeCodeProcess({
      command: 'unused', args: [], env: {}, signal: new AbortController().signal,
    })).toMatchObject({ killed: false })
  } finally {
    delete process.env.M8_SLICE4_TOKEN
    if (savedPathExt === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = savedPathExt
    if (savedWindir === undefined) delete process.env.WINDIR
    else process.env.WINDIR = savedWindir
  }
})

it('accepts a loaded module, resumes nothing for a placeholder, and closes the query', async () => {
  let closed = false
  let model: string | undefined
  const sdk = createClaudeSdk({
    load: () => Promise.resolve({
      query: (params: { prompt: string; options: ClaudeQueryOptions }) => {
        model = params.options.model
        expect(params.options.resume).toBeUndefined()
        expect(params.prompt).toBe('hello')
        expect(params.prompt).not.toContain('C:\\harness')
        return textQuery([success()], () => { closed = true })
      },
      tool: (name: string) => ({ name }),
      createSdkMcpServer: (options: { name: string }) => ({ type: 'sdk' as const, name: options.name, instance: {} }),
    }),
  })
  const result = await sdk.run(turn({ sdkSessionId: 'fake:session-1', runtimeModel: undefined }))
  expect(result.sdkSessionId).toBe(SESSION)
  expect(model).toBeUndefined()
  expect(closed).toBe(true)
})

it('fails closed before a network call when the official package is absent', async () => {
  const error = await createClaudeSdk().run(turn()).then(() => undefined, (caught: unknown) => caught)
  expect(error).toMatchObject({ name: 'HarnessAdapterError', code: 'sdk_unavailable', message: 'External harness: sdk_unavailable' })
  expect(String(error)).not.toContain(SECRET)
  expect(String(error)).not.toContain('claude-agent-sdk')
})

it('rejects a module that is missing the official query surface', async () => {
  const samples = [
    1,
    null,
    { query: 1, tool: () => ({}), createSdkMcpServer: () => ({}) },
    { query: () => ({}), tool: 1, createSdkMcpServer: () => ({}) },
    { query: () => ({}), tool: () => ({}) },
  ]
  for (const sample of samples) {
    const error = await createClaudeSdk({ load: () => Promise.resolve(sample) }).run(turn())
      .then(() => undefined, (caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'sdk_unavailable' })
    expect(String(error)).not.toContain('C:\\harness')
  }
})

it('keeps Codex partial and does not load an SDK', async () => {
  const error = await createClaudeSdk({ load: () => Promise.reject(new Error(SECRET)) }).run(turn({ runtime: 'codex-sdk' })).then(() => undefined, (caught: unknown) => caught)
  expect(error).toMatchObject({ code: 'runtime_partial', message: 'External harness: runtime_partial' })
  expect(String(error)).not.toContain(SECRET)
})

it('refuses an aborted turn, an empty workspace, and a harness directory used as the workspace', async () => {
  const controller = new AbortController()
  controller.abort()
  const aborted = createClaudeSdk({ load: () => Promise.reject(new Error(SECRET)) })
  await expect(aborted.run(turn({ signal: controller.signal }))).rejects.toMatchObject({ code: 'session_unavailable' })
  await expect(aborted.run(turn({ cwd: undefined, configDirectory: undefined }))).rejects.toMatchObject({ code: 'session_unavailable' })
  await expect(aborted.run(turn({ cwd: 'C:\\workspace', configDirectory: '' }))).rejects.toMatchObject({ code: 'session_unavailable' })
  await expect(aborted.run(turn({ cwd: 'C:\\same', configDirectory: 'C:\\same' }))).rejects.toMatchObject({ code: 'session_unavailable' })
})

it('sanitizes a bad official result, a thrown SDK payload, and a binding failure', async () => {
  const failing = (messages: readonly ClaudeSdkMessage[]): ClaudeQueryFactory => ({
    query: () => textQuery(messages),
    tool: name => ({ name }),
    createSdkMcpServer: options => ({ type: 'sdk', name: options.name, instance: {} }),
  })
  const sdk = createClaudeSdk({ factory: failing([{ type: 'result', subtype: 'error_during_execution', result: SECRET }]), spawn: () => fakeProcess() })
  await expect(sdk.run(turn())).rejects.toMatchObject({ code: 'result_invalid', message: 'External harness: result_invalid' })
  const errored = createClaudeSdk({ factory: failing([{ type: 'result', subtype: 'success', is_error: true, result: SECRET }]), spawn: () => fakeProcess() })
  await expect(errored.run(turn())).rejects.toMatchObject({ code: 'result_invalid' })
  const untyped = createClaudeSdk({ factory: failing([{ type: 'result', subtype: 'success', result: 4 }]), spawn: () => fakeProcess() })
  await expect(untyped.run(turn())).rejects.toMatchObject({ code: 'result_invalid' })
  const unfinished = createClaudeSdk({ factory: failing([{ type: 'system', session_id: SESSION }]), spawn: () => fakeProcess() })
  await expect(unfinished.run(turn())).rejects.toMatchObject({ code: 'session_unavailable' })
  const anonymous = createClaudeSdk({ factory: failing([success('')]), spawn: () => fakeProcess() })
  await expect(anonymous.run(turn())).rejects.toMatchObject({ code: 'session_unavailable' })
  const leaked = createClaudeSdk({
    factory: { ...failing([]), query: () => { throw new Error(SECRET) } },
    spawn: () => fakeProcess(),
  })
  const caught = await leaked.run(turn()).then(() => undefined, (error: unknown) => error)
  expect(caught).toMatchObject({ code: 'sdk_unavailable' })
  expect(String(caught)).not.toContain(SECRET)
  const bound = createClaudeSdk({
    factory: failing([success()]),
    spawn: () => fakeProcess(),
  })
  await expect(bound.run(turn({
    tools: bridge({ list: () => Promise.reject(new HarnessBindingError('binding_missing')) }),
  }))).rejects.toMatchObject({ code: 'binding_missing' })
  const listed = createClaudeSdk({ factory: failing([success()]), spawn: () => fakeProcess() })
  const listedError = await listed.run(turn({
    tools: bridge({ list: () => Promise.reject(new Error(SECRET)) }),
  })).then(() => undefined, (error: unknown) => error)
  expect(listedError).toMatchObject({ code: 'sdk_unavailable' })
  expect(String(listedError)).not.toContain(SECRET)
})

it('aborts the official controller without keeping the SDK payload', async () => {
  const controller = new AbortController()
  let saw = false
  const sdk = createClaudeSdk({
    factory: {
      query: (params) => {
        params.options.abortController.signal.addEventListener('abort', () => { saw = true })
        controller.abort()
        throw new Error(SECRET)
      },
      tool: name => ({ name }),
      createSdkMcpServer: options => ({ type: 'sdk', name: options.name, instance: {} }),
    },
    spawn: () => fakeProcess(),
  })
  await expect(sdk.run(turn({ signal: controller.signal }))).rejects.toMatchObject({ code: 'session_unavailable' })
  expect(saw).toBe(true)
})

it('spawns a hidden direct child and sanitizes a missing executable', async () => {
  const root = await worktree()
  const child = startClaudeProcess({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: root,
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT },
    signal: new AbortController().signal,
  })
  const ignored = (): void => {}
  child.on('exit', ignored)
  child.off('exit', ignored)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  expect(exit).toEqual({ code: 0, signal: null })
  expect(child.exitCode).toBe(0)
  expect(child.signalCode).toBeNull()
  expect(child.kill('SIGTERM')).toBe(false)

  const held = startClaudeProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: root,
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT },
    signal: new AbortController().signal,
  })
  onTestFinished(() => { held.kill('SIGTERM') })
  expect(held.exitCode).toBeNull()
  expect(held.kill('SIGTERM')).toBe(true)
  expect(held.killed).toBe(true)
  expect(held.kill('SIGTERM')).toBe(false)

  const missing = startClaudeProcess({
    command: 'm8-missing-claude',
    args: [],
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    signal: new AbortController().signal,
  })
  const failure = await new Promise<Error>((resolve) => { missing.once('error', resolve) })
  expect(failure).toMatchObject({ code: 'process_failed', message: 'External harness: process_failed' })
  expect(failure.message).not.toContain('m8-missing-claude')
  expect(failure.message).not.toContain(root)

  let thrown: unknown
  try {
    startClaudeProcess({
      command: '\0',
      args: [],
      cwd: root,
      env: {},
      signal: new AbortController().signal,
    })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(HarnessAdapterError)
  expect(String(thrown)).not.toContain(root)
})

it('rejects a child whose pipes were discarded', async () => {
  const root = await worktree()
  const discard = (stdio: ['ignore', 'pipe', 'pipe'] | ['pipe', 'ignore', 'pipe']): void => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 30)'], {
      cwd: root, shell: false, windowsHide: true, stdio,
    })
    onTestFinished(() => { child.kill() })
    expect(() => hideClaudeProcess(child)).toThrow('External harness: process_failed')
  }
  discard(['ignore', 'pipe', 'pipe'])
  discard(['pipe', 'ignore', 'pipe'])
  const piped = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  })
  onTestFinished(() => { piped.kill() })
  const hidden = hideClaudeProcess(piped)
  await new Promise<void>((resolve) => { hidden.once('exit', () => resolve()) })
  expect(hidden.exitCode).toBe(0)
})

it('uses the default spawn from the query seam', async () => {
  const root = await worktree()
  const sdk = createClaudeSdk({
    factory: {
      query: async function* (params) {
        const child = params.options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: root,
          env: params.options.env,
          signal: params.options.abortController.signal,
        })
        await new Promise<void>((resolve, reject) => {
          child.once('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(String(code)))
          })
          child.once('error', reject)
        })
        yield success()
      },
      tool: name => ({ name }),
      createSdkMcpServer: options => ({ type: 'sdk', name: options.name, instance: {} }),
    },
  })
  await expect(sdk.run(turn({ cwd: root, configDirectory: join(root, 'harness') }))).resolves.toMatchObject({ text: 'answer', sdkSessionId: SESSION })
})
