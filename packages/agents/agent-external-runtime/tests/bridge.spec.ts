import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import { expect, it, onTestFinished, vi } from 'vitest'
import { harness, inherited } from '../../agent-registry/tests/harness.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import * as Memory from '../../agent-memory/src/index.ts'
import * as MemoryTools from '../../tool-agent-memory/src/index.ts'
import * as Mailbox from '../../agent-mailbox/src/index.ts'
import * as MailboxTools from '../../tool-agent-mailbox/src/index.ts'
import * as RoutineTools from '../../tool-agent-routine/src/index.ts'
import * as Owners from '../../agent-runtime/src/owners.ts'
import * as Accounts from '../../agent-runtime/src/accounts.ts'
import * as Runtime from '../../agent-runtime/src/index.ts'
import * as Tables from '../../../storage/storage-tables/src/index.ts'
import * as TableTools from '../../../storage/tool-tables/src/index.ts'
import * as External from '../src/index.ts'
import { ExternalAgentActivationService } from '../src/driver.ts'
import { openTurnBridge, type TurnBridgeInput } from '../src/bridge.ts'

const BODY_LIMIT = 1_048_576

function bareHost(accounts: readonly { id: string; state: string }[]): Context {
  const service = { list: () => accounts }
  return { get: (name: string) => name === 'accounts' ? service : undefined } as never
}

function input(host: Context, ownerId: string, cwd = ''): TurnBridgeInput {
  return {
    host, ownerId, turn: 1, step: 1, model: 'external',
    signal: new AbortController().signal, onEnded: () => {},
    agent: { id: 'x', session: { header: { cwd } }, inject() {} } as never,
  }
}

interface Reply { status: number; headers: IncomingHttpHeaders; text: string }

function rawRequest(port: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(Number(port), '127.0.0.1', () => { socket.end(payload) })
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function denyRead(path: string): void {
  const user = process.env['USERNAME'] ?? ''
  execFileSync('icacls', [path, '/deny', `${user}:(R)`], { stdio: 'ignore', windowsHide: true })
}

function allowRead(path: string): void {
  const user = process.env['USERNAME'] ?? ''
  execFileSync('icacls', [path, '/remove:d', user], { stdio: 'ignore', windowsHide: true })
}

function talk(url: string, method: string, headers: Record<string, string>, body?: Buffer | string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body)
    const req = httpRequest({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method,
      timeout: 5000,
      headers: { ...headers, ...(payload === undefined ? {} : { 'content-length': String(payload.length) }) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (payload === undefined) req.end()
    else req.end(payload)
  })
}

function textOf(agent: Agent): string {
  // oxlint-disable-next-line typescript/no-deprecated -- the test reads the restored prefix and the live suffix
  return agent.session.snapshotEvents().flatMap((event) => {
    const data = event.type === 'assistant/message'
      ? event.data.message
      : event.type === 'user/message'
        ? event.data
        : undefined
    return data?.content?.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []) ?? []
  }).join('\n')
}

async function boot() {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/external-bridge-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const { ctx } = await harness(root)
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Memory)
  await ctx.plugin(Typert)
  await ctx.plugin(Query, { path: ':memory:' })
  await createSessionTestController(ctx, { defaultModelSelection: () => inherited, cwd: root })
  await ctx.plugin(Gateway)
  await ctx.plugin(Accounts, { tokenDirectory: join(root, 'tokens') })
  await ctx.plugin(Owners)
  await ctx.plugin(Runtime)
  await ctx.plugin(Mailbox)
  await ctx.plugin(MailboxTools)
  await ctx.plugin(MemoryTools)
  ctx.provide('agentRoutines', { engine: { list: () => [] } } as unknown as Context['agentRoutines'])
  await ctx.plugin(RoutineTools)
  await mkdir(join(root, 'tables'), { recursive: true })
  await ctx.plugin(Tables, {
    path: join(root, 'tables', 'tables-shared.sqlite'), dshHome: root, commandTimeoutMs: 20_000,
  })
  await ctx.plugin(TableTools)
  const accountA = (await ctx.accounts.create('A', 'member')).account
  const accountB = (await ctx.accounts.create('B', 'member')).account
  const homeA = join(root, 'harness-a')
  const homeB = join(root, 'harness-b')
  const workspace = join(root, 'workspace')
  await mkdir(homeA)
  await mkdir(homeB)
  await mkdir(workspace)
  ;(ctx as { workspaceRegistry?: { list(): readonly { path: string }[] } }).workspaceRegistry = { list: () => [{ path: workspace }] }
  await External.apply(ctx, { bindings: [
    { accountId: accountA.id, runtime: 'claude-sdk', configDirectory: homeA, revision: 1 },
    { accountId: accountB.id, runtime: 'codex-sdk', configDirectory: homeB, revision: 1 },
  ] })
  const profileA = await ctx.persistentAgents.create({ name: 'A', ownerId: accountA.id, runtime: 'claude-sdk', instructions: 'a' }, inherited)
  const profileB = await ctx.persistentAgents.create({ name: 'B', ownerId: accountB.id, runtime: 'codex-sdk', instructions: 'b' }, inherited)
  const open = async (profileId: string) => {
    const handle = await ctx.persistentAgentActivation.createOrResume({
      ownerCtx: ctx, sessionId: SessionId(`agent-${profileId}`), agentId: profileId,
    })
    onTestFinished(() => handle.dispose())
    return handle
  }
  return { ctx, root, workspace, homeA, accountA, accountB, profileA, profileB, open }
}

it('refuses a bridge when the account or the binding is unusable', async () => {
  await expect(openTurnBridge(input(bareHost([]), 'missing'))).rejects.toMatchObject({ code: 'account_inactive' })
  await expect(openTurnBridge(input(bareHost([{ id: 'acc', state: 'disabled' }]), 'acc'))).rejects.toMatchObject({ code: 'account_inactive' })
  await expect(openTurnBridge(input(bareHost([{ id: 'acc', state: 'active' }]), 'acc'))).rejects.toMatchObject({ code: 'binding_missing' })
  await expect(openTurnBridge(input(bareHost([]), 'owner'))).rejects.toMatchObject({ code: 'binding_missing' })
  await expect(openTurnBridge(input({ get: () => undefined } as never, 'acc', 'C:\\work'))).rejects.toMatchObject({ code: 'binding_missing' })
  await expect(openTurnBridge(input({
    get: (name: string) => name === 'harnessBindings' ? { resolve: async () => {} } : undefined,
  } as never, 'owner', 'C:\\work'))).rejects.toMatchObject({ code: 'binding_missing' })
  const controller = new AbortController()
  let resolves = 0
  const toolService = {
    resolve: async () => {
      resolves += 1
      if (resolves > 1) controller.abort()
      return { dispose() {} }
    },
    schemas: () => [],
    execute: async () => { throw new Error('unused') },
  }
  const aborted = await openTurnBridge({
    ...input({
      get: (name: string) => name === 'harnessBindings' ? { resolve: async () => {} } : name === 'tools' ? toolService : undefined,
    } as never, 'owner', 'C:\\work'),
    signal: controller.signal,
  })
  expect((await aborted.call('abort-during-admit', 'remember', { text: 'x' })).code).toBe('cancelled')
  await aborted.close()
  let listed = 0
  const vanishing = {
    resolve: async () => ({ dispose() {} }),
    schemas: () => [],
    execute: async () => { throw new Error('unused') },
  }
  const counted = (offset: number) => ({
    get: (name: string) => {
      if (name === 'harnessBindings') return { resolve: async () => {} }
      if (name !== 'tools') return undefined
      listed += 1
      return listed >= offset ? undefined : vanishing
    },
  })
  const listBridge = await openTurnBridge(input(counted(3) as never, 'owner', 'C:\\work'))
  await expect(listBridge.list()).rejects.toMatchObject({ code: 'binding_missing' })
  await listBridge.close()
  listed = 0
  const callBridge = await openTurnBridge(input(counted(3) as never, 'owner', 'C:\\work'))
  expect((await callBridge.call('tools-gone', 'remember', { text: 'x' })).code).toBe('tool_denied')
  await callBridge.close()
})

it('serves admitted tools in process and on loopback, then revokes them', async () => {
  const f = await boot()
  const handle = await f.open(f.profileA.id)
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  let releaseTurn = (): void => {}
  let parked = false
  service.sdk = {
    run: input => new Promise((resolve) => {
      parked = true
      const finish = (text: string): void => resolve({ text })
      releaseTurn = () => finish('held')
      input.signal.addEventListener('abort', () => finish('aborted'), { once: true })
    }),
  }
  onTestFinished(() => releaseTurn())
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold' }], source: { kind: 'user' } }))
  await vi.waitFor(() => expect(parked).toBe(true))
  const ended = vi.fn()
  const bridge = await openTurnBridge({
    host: f.ctx, agent: handle.agent, ownerId: f.accountA.id, turn: 4, step: 1, model: 'external',
    signal: new AbortController().signal, onEnded: ended,
  })
  const secret = bridge.authorizationHeader().slice('Bearer '.length)
  const port = new URL(bridge.endpoint).port
  expect(bridge.endpoint.includes(secret)).toBe(false)
  expect(bridge.childEnv()).toEqual({ MCP_LOOPBACK_AUTHORIZATION: bridge.authorizationHeader() })
  const listed = await bridge.list()
  expect(listed.some(tool => tool.name === 'remember')).toBe(true)
  expect(listed.some(tool => tool.name === 'bash')).toBe(false)
  const remembered = await bridge.call('mem-1', 'remember', { text: 'alpha-note' })
  expect(remembered.isError).toBe(false)
  expect(remembered.content[0]?.text).toContain('alpha-note')
  const again = await bridge.call('mem-1', 'remember', { text: 'other-note' })
  expect(again).toEqual(remembered)
  // oxlint-disable-next-line typescript/no-deprecated -- count durable tool events once
  const calls = handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.callId === 'mem-1')
  expect(calls).toHaveLength(1)
  expect(await bridge.call('bash-1', 'bash', {})).toMatchObject({ isError: true, code: 'tool_denied' })
  expect(await bridge.call('own-1', 'remember', { text: 'x', ownerId: 'nope' })).toMatchObject({ code: 'tool_denied' })
  expect(await bridge.call('nest-1', 'remember', { text: 'x', box: [{ owner_id: 'nope' }] })).toMatchObject({ code: 'tool_denied' })
  expect((await bridge.call('null-1', 'remember', { text: 'alpha-note', box: null })).code).not.toBe('tool_denied')
  expect((await bridge.call('bad-1', 'remember', {})).isError).toBe(true)
  expect((await bridge.call('undef-1', 'remember', undefined)).code).not.toBe('tool_denied')
  const auth = { authorization: bridge.authorizationHeader() }
  expect((await talk(bridge.endpoint, 'POST', {})).status).toBe(401)
  expect((await talk(bridge.endpoint, 'POST', { authorization: 'Bearer wrong' })).status).toBe(401)
  expect((await talk(bridge.endpoint, 'POST', { authorization: 'Token raw' })).status).toBe(401)
  expect((await talk(`${bridge.endpoint}?mcp=${secret}`, 'POST', auth)).text).toBe('not found')
  expect((await talk(bridge.endpoint.replace('/mcp', '/nope'), 'POST', auth)).status).toBe(404)
  const missingHost = await rawRequest(port, 'GET /mcp HTTP/1.0\r\n\r\n')
  expect(missingHost).toContain('403')
  expect((await talk(bridge.endpoint, 'POST', { ...auth, host: 'evil.test' })).status).toBe(403)
  expect((await talk(bridge.endpoint, 'POST', { ...auth, origin: 'http://evil.test' })).status).toBe(403)
  expect((await talk(bridge.endpoint, 'POST', { ...auth, host: `localhost:${port}`, origin: `http://localhost:${port}` })).status).not.toBe(403)
  expect((await talk(bridge.endpoint, 'POST', { ...auth, origin: `http://127.0.0.1:${port}` })).status).not.toBe(403)
  expect((await talk(bridge.endpoint, 'GET', auth)).status).toBe(405)
  expect((await talk(bridge.endpoint, 'POST', { ...auth, 'mcp-protocol-version': '1999-01-01' })).status).toBe(400)
  expect((await talk(bridge.endpoint, 'POST', auth, '{')).status).toBe(400)
  const huge = await talk(bridge.endpoint, 'POST', auth, Buffer.alloc(BODY_LIMIT + 1, 1)).catch(() => undefined)
  expect(huge === undefined || huge.status === 413).toBe(true)
  const init = await talk(bridge.endpoint, 'POST', auth, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
  expect(init.status).toBe(200)
  const session = String(init.headers['mcp-session-id'])
  expect(session.length).toBeGreaterThan(0)
  const sessionHeaders = { ...auth, 'mcp-session-id': session, 'mcp-protocol-version': '2025-03-26' }
  expect(json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }))).error?.code).toBe(-32600)
  expect((await talk(bridge.endpoint, 'POST', auth, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status).toBe(202)
  expect((await talk(bridge.endpoint, 'POST', auth, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }))).status).toBe(404)
  expect((await talk(bridge.endpoint, 'DELETE', auth)).status).toBe(404)
  expect(json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }))).result).toEqual({})
  expect(json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', method: 'nope' }))).error?.code).toBe(-32601)
  const tools = json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' })))
  expect(JSON.stringify(tools.result)).toContain('remember')
  expect(json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: [] }))).error?.code).toBe(-32602)
  expect(json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { arguments: {} } }))).error?.code).toBe(-32602)
  expect(json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'remember', arguments: [] } }))).error?.code).toBe(-32602)
  expect(json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 81, method: 'tools/call', params: { name: 'remember' } }))).result).toBeDefined()
  expect(json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 82, method: 'tools/call', params: { name: 'remember', arguments: null } }))).error?.code).toBe(-32602)
  expect(json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 83, method: 'tools/call', params: { name: 'remember', arguments: 'no' } }))).error?.code).toBe(-32602)
  const denied = json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({
    jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'bash', arguments: {} },
  })))
  expect(denied.result).toMatchObject({ isError: true, code: 'tool_denied' })
  const called = json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({
    jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'remember', callId: 'http-1', arguments: { text: 'loop' } },
  })))
  expect(called.result).toMatchObject({ isError: false })
  const fallback = json(await talk(bridge.endpoint, 'POST', sessionHeaders, JSON.stringify({
    jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'remember', callId: 4, arguments: { text: 'loop-2' } },
  })))
  expect(fallback.result).toMatchObject({ isError: false })
  expect((await talk(bridge.endpoint, 'POST', { ...sessionHeaders, 'mcp-session-id': 'nope' }, JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'ping' }))).status).toBe(404)
  const routines = await bridge.call('rout-1', 'routine_list', {})
  expect(routines.isError).toBe(false)
  expect(routines.content[0]?.text).toContain('routines')
  const stopPost = f.ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.name !== 'search_memories') return next()
    return {
      kind: 'accept',
      content: [{ type: 'reasoning', text: 'skip' }, { type: 'text', text: 'kept' }, { type: 'text' } as never],
      additionalContexts: [createUserMessage({ content: [{ type: 'text', text: 'deferred-note' }], source: { kind: 'user' } })],
    }
  })
  const mixed = await bridge.call('mix-1', 'search_memories', { query: 'alpha-note' })
  stopPost()
  expect(mixed.content[0]?.text).toBe('kept')
  expect(handle.agent.inbox.nextStep.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))).toContain('deferred-note')
  const stopAsk = f.ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== 'list_memories') return next()
    return Promise.resolve({ kind: 'ask' })
  })
  expect(await bridge.call('ask-1', 'list_memories', {})).toMatchObject({ isError: true, code: 'permission_required' })
  stopAsk()
  const original = f.ctx.tools.execute.bind(f.ctx.tools)
  let entered = 0
  let releaseGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  const execute = vi.spyOn(f.ctx.tools, 'execute').mockImplementation(async (batch) => {
    entered += 1
    if (entered === 1) await gate
    return original(batch)
  })
  const first = bridge.call('par-1', 'remember', { text: 'p1' })
  const second = bridge.call('par-2', 'remember', { text: 'p2' })
  await vi.waitFor(() => expect(entered).toBe(1))
  releaseGate()
  expect((await first).isError).toBe(false)
  expect((await second).isError).toBe(false)
  expect(entered).toBe(2)
  execute.mockRestore()
  await expect(openTurnBridge({
    host: f.ctx, agent: { id: handle.agent.id, session: { header: {} }, inject() {} } as never,
    ownerId: f.accountA.id, turn: 1, step: 1, model: 'external', signal: new AbortController().signal, onEnded: () => {},
  })).rejects.toMatchObject({ code: 'binding_missing' })
  await expect(openTurnBridge({
    host: f.ctx, agent: { id: handle.agent.id, session: { header: { cwd: '' } }, inject() {} } as never,
    ownerId: f.accountA.id, turn: 1, step: 1, model: 'external', signal: new AbortController().signal, onEnded: () => {},
  })).rejects.toMatchObject({ code: 'binding_missing' })
  const aborted = new AbortController()
  aborted.abort()
  await expect(openTurnBridge({
    host: f.ctx, agent: handle.agent, ownerId: f.accountA.id, turn: 1, step: 1, model: 'external',
    signal: aborted.signal, onEnded: () => {},
  })).rejects.toThrow()
  const thrown = vi.spyOn(f.ctx.tools, 'execute').mockRejectedValueOnce(new Error(`secret ${f.root}`))
  const failed = await bridge.call('fail-1', 'remember', { text: 'nope' })
  thrown.mockRestore()
  expect(failed).toMatchObject({ code: 'tool_denied' })
  expect(failed.content[0]?.text).toBe('tool call failed')
  expect(failed.content[0]?.text).not.toContain(f.root)
  const empty = vi.spyOn(f.ctx.tools, 'execute').mockResolvedValueOnce({ results: [], additionalContexts: [] } as never)
  expect(await bridge.call('empty-1', 'remember', { text: 'z' })).toMatchObject({
    code: 'tool_denied', content: [{ type: 'text', text: 'tool call failed' }],
  })
  empty.mockRestore()
  const during = new AbortController()
  const duringBridge = await openTurnBridge({
    host: f.ctx, agent: handle.agent, ownerId: f.accountA.id, turn: 1, step: 2, model: 'external',
    signal: during.signal, onEnded: () => {},
  })
  vi.spyOn(f.ctx.tools, 'execute').mockImplementationOnce(async () => {
    during.abort()
    throw new Error('stopped')
  })
  expect(await duringBridge.call('stop-1', 'remember', { text: 'z' })).toMatchObject({ code: 'cancelled' })
  const closing = await openTurnBridge({
    host: f.ctx, agent: handle.agent, ownerId: f.accountA.id, turn: 1, step: 3, model: 'external',
    signal: new AbortController().signal, onEnded: () => {},
  })
  vi.spyOn(f.ctx.tools, 'execute').mockImplementationOnce(async () => {
    await closing.close()
    throw new Error('gone')
  })
  expect(await closing.call('close-1', 'remember', { text: 'z' })).toMatchObject({ code: 'cancelled' })
  const after = new AbortController()
  const afterBridge = await openTurnBridge({
    host: f.ctx, agent: handle.agent, ownerId: f.accountA.id, turn: 1, step: 4, model: 'external',
    signal: after.signal, onEnded: () => {},
  })
  const live = f.ctx.tools.execute.bind(f.ctx.tools)
  vi.spyOn(f.ctx.tools, 'execute').mockImplementationOnce(async (batch) => {
    const result = await live(batch)
    after.abort()
    return result
  })
  expect(await afterBridge.call('after-1', 'remember', { text: 'z' })).toMatchObject({ code: 'cancelled' })
  await afterBridge.close()
  const resolve = vi.spyOn(f.ctx.harnessBindings, 'resolve')
  const resolved = resolve.getMockImplementation() ?? resolve.bind(f.ctx.harnessBindings)
  const generic = new AbortController()
  const genericEnded = vi.fn()
  const genericBridge = await openTurnBridge({
    host: f.ctx, agent: handle.agent, ownerId: f.accountA.id, turn: 1, step: 5, model: 'external',
    signal: generic.signal, onEnded: genericEnded,
  })
  resolve.mockImplementationOnce(async (...args) => {
    generic.abort()
    return resolved(...args)
  })
  expect(await genericBridge.call('gen-1', 'remember', { text: 'z' })).toMatchObject({ code: 'tool_denied', content: [{ type: 'text', text: 'tool_denied' }] })
  expect(genericEnded).toHaveBeenCalled()
  resolve.mockRestore()
  await genericBridge.close()
  const homeC = join(f.root, 'harness-c')
  await mkdir(homeC)
  const accountC = (await f.ctx.accounts.create('C', 'member')).account
  await External.apply(f.ctx, { bindings: [{ accountId: accountC.id, runtime: 'claude-sdk', configDirectory: homeC, revision: 2 }] })
  expect(await bridge.call('miss-1', 'remember', { text: 'z' })).toMatchObject({ code: 'tool_denied', content: [{ text: 'binding_missing' }] })
  expect(ended).toHaveBeenCalled()
  await External.apply(f.ctx, { bindings: [
    { accountId: f.accountA.id, runtime: 'claude-sdk', configDirectory: f.homeA, revision: 3 },
    { accountId: f.accountB.id, runtime: 'codex-sdk', configDirectory: join(f.root, 'harness-b'), revision: 3 },
  ] })
  const listBridge = await openTurnBridge({
    host: f.ctx, agent: handle.agent, ownerId: f.accountA.id, turn: 1, step: 6, model: 'external',
    signal: new AbortController().signal, onEnded: () => {},
  })
  const listAbort = new AbortController()
  const abortList = await openTurnBridge({
    host: f.ctx, agent: handle.agent, ownerId: f.accountA.id, turn: 1, step: 7, model: 'external',
    signal: listAbort.signal, onEnded: () => {},
  })
  listAbort.abort()
  const listedClosed = json(await talk(abortList.endpoint, 'POST', {
    authorization: abortList.authorizationHeader(), 'mcp-session-id': String((await talk(abortList.endpoint, 'POST', { authorization: abortList.authorizationHeader() }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))).headers['mcp-session-id']),
  }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })))
  expect(listedClosed.error?.code).toBe(-32001)
  await expect(abortList.list()).rejects.toThrow('closed')
  expect(await abortList.call('late', 'remember', { text: 'z' })).toMatchObject({ code: 'cancelled' })
  await abortList.close()
  await listBridge.close()
  await listBridge.close()
  expect((await talk(bridge.endpoint, 'DELETE', { ...auth, 'mcp-session-id': session })).status).toBe(204)
  await vi.waitFor(async () => { await talk(bridge.endpoint, 'GET', auth).then(() => { throw new Error('open') }, () => {}) })
  expect(await bridge.call('mem-1', 'remember', { text: 'after' })).toMatchObject({ code: 'closed' })
  await expect(bridge.list()).rejects.toThrow('closed')
  await bridge.close()
  expect(JSON.stringify(calls)).not.toContain(secret)
})

it('proves mailbox, private tables and memory across two accounts', async () => {
  const f = await boot()
  const a = await f.open(f.profileA.id)
  const b = await f.open(f.profileB.id)
  const grant = async (agent: Agent, ownerId: string, accountId: string) => {
    const bridge = await openTurnBridge({
      host: f.ctx, agent, ownerId, turn: 1, step: 1, model: 'external',
      signal: new AbortController().signal, onEnded: () => {},
    })
    const result = await bridge.call(`grant-${accountId}`, 'agent_grant_access', { account_id: accountId })
    await bridge.close()
    expect(result.isError).toBe(false)
  }
  await grant(b.agent, f.accountB.id, f.accountA.id)
  await grant(a.agent, f.accountA.id, f.accountB.id)
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  let bSearch = ''
  let bQuery = ''
  let secret = ''
  let sdkError = ''
  service.sdk = {
    run: async (input) => {
      try {
        const outcome = await (async () => {
          const text = input.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
          if (text.includes('pong-from-b')) return { text: 'saw-pong' }
          if (text.includes('ping-from-a')) {
            secret = input.tools.authorizationHeader().slice('Bearer '.length)
            expect(input.tools.endpoint.includes(secret)).toBe(false)
            expect(input.runtime).toBe('codex-sdk')
            bSearch = (await input.tools.call('b-search', 'search_memories', { query: 'alpha-note' })).content[0]?.text ?? ''
            bQuery = (await input.tools.call('b-query', 'data_query', { sql: 'SELECT titulo FROM notas' })).content[0]?.text ?? ''
            const header = input.tools.authorizationHeader()
            const init = await talk(input.tools.endpoint, 'POST', { authorization: header }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
            const session = String(init.headers['mcp-session-id'])
            await talk(input.tools.endpoint, 'POST', { authorization: header }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
            const sent = await talk(input.tools.endpoint, 'POST', { authorization: header, 'mcp-session-id': session }, JSON.stringify({
              jsonrpc: '2.0', id: 2, method: 'tools/call',
              params: { name: 'agent_send_message', callId: 'b-send', arguments: { recipients: [f.profileA.id], message: 'pong-from-b', expects_reply: false } },
            }))
            expect(json(sent).result).toMatchObject({ isError: false })
            return { text: 'replied' }
          }
          if (text.includes('start-round')) {
            expect(input.runtime).toBe('claude-sdk')
            const remembered = await input.tools.call('a-mem', 'remember', { text: 'alpha-note' })
            expect(remembered.isError).toBe(false)
            const found = await input.tools.call('a-search', 'search_memories', { query: 'alpha-note' })
            expect(found.content[0]?.text).toContain('alpha-note')
            expect((await input.tools.call('a-routine', 'routine_list', {})).isError).toBe(false)
            expect((await input.tools.call('a-table', 'table_create', {
              nome: 'notas', colunas: [{ nome: 'titulo', tipo: 'texto', obrigatoria: true }],
            })).isError).toBe(false)
            expect((await input.tools.call('a-insert', 'data_execute', {
              sql: 'INSERT INTO notas (titulo) VALUES (?)', parametros: ['alpha-row'],
            })).isError).toBe(false)
            const rows = await input.tools.call('a-read', 'data_query', { sql: 'SELECT titulo FROM notas' })
            expect(rows.content[0]?.text).toContain('alpha-row')
            const sent = await input.tools.call('a-send', 'agent_send_message', {
              recipients: [f.profileB.id], message: 'ping-from-a', expects_reply: false,
            })
            expect(sent.isError).toBe(false)
            return { text: 'sent' }
          }
          return { text: 'other' }
        })()
        return outcome
      } catch (error) {
        sdkError = error instanceof Error ? error.message : String(error)
        throw error
      }
    },
  }
  a.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start-round' }], source: { kind: 'user' } }))
  await vi.waitFor(() => {
    expect(sdkError, sdkError).toBe('')
    expect(textOf(a.agent)).toContain('saw-pong')
  }, { timeout: 20000 })
  expect(bSearch).not.toContain('alpha-note')
  expect(bQuery).not.toContain('alpha-row')
  expect(textOf(b.agent)).toContain('ping-from-a')
  expect(JSON.stringify(textOf(a.agent) + textOf(b.agent))).not.toContain(secret)
  const revoke = await openTurnBridge({
    host: f.ctx, agent: b.agent, ownerId: f.accountB.id, turn: 2, step: 1, model: 'external',
    signal: new AbortController().signal, onEnded: () => {},
  })
  expect((await revoke.list()).some(tool => tool.name === 'agent_send_message')).toBe(true)
  expect((await revoke.call('revoke-1', 'agent_revoke_access', { account_id: f.accountA.id })).isError).toBe(false)
  await revoke.close()
  const later = await openTurnBridge({
    host: f.ctx, agent: a.agent, ownerId: f.accountA.id, turn: 3, step: 1, model: 'external',
    signal: new AbortController().signal, onEnded: () => {},
  })
  expect((await later.list()).some(tool => tool.name === 'agent_send_message')).toBe(true)
  expect((await later.call('later-1', 'agent_send_message', {
    recipients: [f.profileB.id], message: 'after-revoke', expects_reply: false,
  })).isError).toBe(true)
  await later.close()
})

it('does not open auth.json while listing or calling a tool', async () => {
  const f = await boot()
  const credential = join(f.homeA, 'auth.json')
  await writeFile(credential, 'synthetic credential: the bridge must not read this')
  denyRead(credential)
  try {
    const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
    let releaseTurn = (): void => {}
    let parked = false
    service.sdk = {
      run: input => new Promise((resolve) => {
        parked = true
        const finish = (text: string): void => resolve({ text })
        releaseTurn = () => finish('held')
        input.signal.addEventListener('abort', () => finish('aborted'), { once: true })
      }),
    }
    onTestFinished(() => releaseTurn())
    const handle = await f.open(f.profileA.id)
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold' }], source: { kind: 'user' } }))
    await vi.waitFor(() => expect(parked).toBe(true))
    const bridge = await openTurnBridge({
      host: f.ctx, agent: handle.agent, ownerId: f.accountA.id, turn: 1, step: 1, model: 'external',
      signal: new AbortController().signal, onEnded: () => {},
    })
    await bridge.list()
    const result = await bridge.call('auth-1', 'remember', { text: 'no-credential' })
    expect(result.isError, result.content[0]?.text).toBe(false)
    expect(result.content[0]?.text ?? '').not.toMatch(/auth\.json|EPERM|EACCES/)
    await bridge.close()
    releaseTurn()
    await handle.agent.whenIdle()
  } finally {
    allowRead(credential)
  }
  expect(await readFile(credential, 'utf8')).toContain('synthetic credential')
})

function json(reply: Reply | Promise<Reply>): { error?: { code: number }; result?: Record<string, unknown> } {
  if (reply instanceof Promise) throw new Error('reply must be awaited')
  return JSON.parse(reply.text) as { error?: { code: number }; result?: Record<string, unknown> }
}
