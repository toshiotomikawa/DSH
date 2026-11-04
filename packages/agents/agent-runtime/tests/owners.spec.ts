import { mkdir, mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ownerIdOf, type PeerId, type PeerScope, type Principal, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { describe, it, expect, onTestFinished, vi } from 'vitest'
import { harness, inherited } from '../../agent-registry/tests/harness.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import * as Owners from '../src/owners.ts'

const A: Principal = { kind: 'account', ownerId: 'a' }
const B: Principal = { kind: 'account', ownerId: 'b' }
const OWNER: Principal = { kind: 'owner' }

function peer(ctx: Context, principal: Principal): PeerScope {
  return { id: `peer-${principal.kind}` as PeerId, ctx, principal, signal: new AbortController().signal, interactions: 'none', dispose: async () => {} }
}

function as(ctx: Context, principal: Principal, method = 'list'): Context {
  const invocation: RemoteInvocation = {
    peer: peer(ctx, principal), request: { namespace: 'session', method, args: {} }, service: 'sessionController',
    signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({ async *[Symbol.asyncIterator]() {} }),
  }
  return ctx.extend({ invocation })
}

async function fixture(legacy = false) {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/owners-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const f = await harness(root)
  onTestFinished(() => f.ctx.fiber.dispose())
  const ctx = f.ctx
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as unknown as Context['workspaceRegistry'])
  await ctx.plugin(Typert)
  await ctx.plugin(Query, { path: ':memory:' })
  const controller = await createSessionTestController(ctx, { defaultModelSelection: () => inherited, cwd: root })
  await ctx.plugin(Gateway)
  await ctx.plugin(Loader)
  if (legacy) ctx.sessions.create(SessionId('legacy'), { meta: { cwd: root } })
  ctx.loader.builtins['owners'] = Owners
  await ctx.loader.root.update([{ id: 'fork-owner-policy', name: 'cordis:owners' }])
  await ctx.loader.await()
  expect(ctx.get('sessionOwners')).toBeDefined()
  const call = (principal: Principal, method: string, args: Readonly<Record<string, unknown>>) =>
    ctx.typertGateway.invoke({ peer: peer(ctx, principal), namespace: 'session', method, args })
  return { ...f, root, controller, call }
}

describe('account ownership through the Host service', () => {
  it('filters live and cold sessions at the Gateway and gives the same failure for a foreign and missing id (1,2,10)', async () => {
    const { ctx, root, call } = await fixture()
    const a = await call(A, 'create', { request: { cwd: root } }) as { sessionId: SessionId }
    const b = await call(B, 'create', { request: { cwd: root } }) as { sessionId: SessionId }
    const list = async (principal: Principal) => {
      const value = await call(principal, 'list', { _request: {} }) as { items: { sessionId: SessionId }[] }
      return value.items.map(item => item.sessionId)
    }
    expect(await list(A)).toEqual([a.sessionId])
    expect(await list(B)).toEqual([b.sessionId])
    expect((await list(OWNER)).sort()).toEqual([a.sessionId, b.sessionId].sort())
    const denied = async (id: string) => {
      try { await call(B, 'rename', { request: { sessionId: id, title: 'Should not change' } }); throw new Error('unexpected admission') }
      catch (error) { return error }
    }
    const foreign = await denied(a.sessionId)
    const missing = await denied('no-such-session')
    expect(foreign).toMatchObject({ code: 'remote-access/denied', details: { reason: 'no-allow' } })
    expect(missing).toMatchObject({ message: (foreign as Error).message, code: 'remote-access/denied', details: { reason: 'no-allow' } })
    // A closed live agent must keep the same policy when its Session is read cold.
    const agent = ctx.agents.get(a.sessionId)!
    await ctx.sessions.flush(agent.session)
    await agent.ctx.fiber.dispose()
    expect(await list(A)).toEqual([a.sessionId])
    const records = await readdir(join(root, 'data/session_owners/sessions'))
    expect(records.length).toBeGreaterThanOrEqual(2)
    expect(await readFile(join(root, 'data/session_owners/sessions', records[0]!), 'utf8')).toContain('ownerId')
  })

  it('runs real FTS without foreign snippets or foreign hasMore, before the result bound (3)', async () => {
    const { ctx, root, call } = await fixture()
    const a = await call(A, 'create', { request: { cwd: root } }) as { sessionId: SessionId }
    const b = await call(B, 'create', { request: { cwd: root } }) as { sessionId: SessionId }
    ctx.sessions.get(a.sessionId)!.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'needle privateAlpha' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    ctx.sessions.get(b.sessionId)!.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'needle privateBeta' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    // More than one result page of foreign hits must not consume A's bound or set A's hasMore.
    for (let index = 0; index < 21; index++) {
      const hidden = ctx.sessions.create(SessionId(`hidden-${index}`), { meta: { cwd: root } })
      await ctx.sessionOwners.assign(hidden.id, 'b')
      hidden.append('user/message', createUserMessage({ content: [{ type: 'text', text: `needle privateBeta${index}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    const result = await call(A, 'search', { request: { query: 'needle' } }) as { items: { sessionId: SessionId; snippet: string }[]; hasMore: boolean }
    expect(result.items).toEqual([{ sessionId: a.sessionId, snippet: expect.stringContaining('privateAlpha') }])
    expect(result.hasMore).toBe(false)
    expect(JSON.stringify(result)).not.toContain('privateBeta')
    expect(await call(B, 'search', { request: { query: 'privateAlpha' } })).toEqual({ items: [], hasMore: false })
  })

  it('uses the connection principal for agents and prevents owner spoofing and owner changes', async () => {
    const { ctx, call } = await fixture()
    const a = await as(ctx, A).persistentAgents.create({ name: 'same', ownerId: 'b' }, inherited)
    const b = await as(ctx, B).persistentAgents.create({ name: 'same', ownerId: 'a' }, inherited)
    expect(a.ownerId).toBe('a')
    expect(b.ownerId).toBe('b')
    expect(as(ctx, A).persistentAgents.list().map(item => item.id)).toEqual([a.id])
    expect(as(ctx, B).persistentAgents.list().map(item => item.id)).toEqual([b.id])
    expect(() => as(ctx, B).persistentAgents.get(a.id)).toThrow('Unknown persistent agent')
    expect(() => as(ctx, B).persistentAgents.get('missing' as typeof a.id)).toThrow('Unknown persistent agent')
    await expect(as(ctx, A).persistentAgents.update(a.id, 1, { ownerId: 'b' })).rejects.toThrow('owner cannot be changed')
    const single = await ctx.persistentAgents.create({ name: 'local' }, inherited)
    expect(single.ownerId).toBe('owner')
    expect(ownerIdOf(undefined)).toBe('owner')
    expect(ownerIdOf(as(ctx, OWNER).invocation)).toBe('owner')
    expect(ownerIdOf(as(ctx, A).invocation)).toBe('a')
    expect(ctx.persistentAgents.list()).toHaveLength(3)
    expect(await call(A, 'list', { _request: {} })).toEqual({ items: [] })
  })

  it('denies a Session whose owner write fails instead of leaving it with the adopted account (1)', async () => {
    const { ctx, root, call } = await fixture()
    const a = await call(A, 'create', { request: { cwd: root } }) as { sessionId: SessionId }
    const source = ctx.sessions.get(a.sessionId)!
    source.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'segredo-do-fork-m7a' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const table = (ctx.sessionOwners as unknown as {
      domain: { table(name: string): { put(key: string, record: unknown): Promise<void> } }
    }).domain.table('sessions')
    const publish = table.put.bind(table)
    const failing = vi.spyOn(table, 'put').mockImplementation(async (key, record) => {
      if (typeof record === 'object' && record !== null && 'ownerId' in record) throw new Error('disk full')
      await publish(key, record)
    })
    const failed = await call(A, 'fork', { request: { sessionId: a.sessionId } }).catch((error: unknown) => error)
    failing.mockRestore()
    expect(failed).toBeInstanceOf(Error)
    const child = (await ctx.sessionQuery.listSessions()).map(record => record.header.id).find(id => id !== a.sessionId)
    expect(child).toBeDefined()
    const singleAccount = { kind: 'account', ownerId: 'owner' } as const
    const ids = async (principal: Principal): Promise<string[]> => {
      const value = await call(principal, 'list', { _request: {} }) as { items: { sessionId: string }[] }
      return value.items.map(item => item.sessionId)
    }
    expect(await ids(A)).toEqual([a.sessionId])
    expect(await ids(singleAccount)).toEqual([])
    expect(await call(singleAccount, 'search', { request: { query: 'segredo-do-fork-m7a' } }))
      .toEqual({ items: [], hasMore: false })
    // The denial is durable: adoption on the next load must not hand it to the single-account owner.
    await ctx.loader.root.update([])
    await ctx.loader.root.update([{ id: 'owners', name: 'cordis:owners' }])
    await ctx.loader.await()
    expect(await ids(A)).toEqual([a.sessionId])
    expect(await ids(singleAccount)).toEqual([])
  })

  it('retains sidecars across plugin reload, adopts legacy sessions, and removes its policy on unload', async () => {
    const { ctx, root, call } = await fixture(true)
    const a = await call(A, 'create', { request: { cwd: root } }) as { sessionId: SessionId }
    const source = ctx.sessions.get(a.sessionId)!
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const child = await call(A, 'fork', { request: { sessionId: a.sessionId } }) as { sessionId: SessionId }
    const profile = await ctx.persistentAgents.create({ name: 'Bound account', ownerId: 'a' }, inherited)
    await ctx.persistentAgents.bind(child.sessionId, profile.id)
    expect(ctx.remoteAccess.snapshotFor(A)).toMatchObject({ owner: false, grants: expect.arrayContaining([
      expect.objectContaining({ resource: { kind: 'session', id: child.sessionId } }),
    ]) })
    await ctx.loader.root.update([])
    expect(ctx.get('sessionOwners')).toBeUndefined()
    await expect(call(A, 'list', { _request: {} })).rejects.toMatchObject({ code: 'remote-access/denied' })
    // Missing ownership on an existing sidecar has the historical single-account meaning.
    const path = join(root, 'data/session_owners/sessions', `s-${Buffer.from('legacy').toString('hex')}.json`)
    const old = JSON.parse(await readFile(path, 'utf8')) as { record: { ownerId?: string } }
    delete old.record.ownerId
    await writeFile(path, JSON.stringify(old))
    await ctx.loader.root.update([{ id: 'owners', name: 'cordis:owners' }])
    await ctx.loader.await()
    const listed = await call(A, 'list', { _request: {} }) as { items: { sessionId: SessionId }[] }
    expect(listed.items.map(item => item.sessionId).sort()).toEqual([a.sessionId, child.sessionId].sort())
    expect(await call(B, 'list', { _request: {} })).toEqual({ items: [] })
    expect(await call({ kind: 'account', ownerId: 'owner' }, 'list', { _request: {} })).toMatchObject({ items: [{ sessionId: 'legacy' }] })
    const failure = new Error('sidecar disk failure')
    const error = vi.spyOn(ctx.logger, 'error')
    vi.spyOn(Owners.SessionOwners.prototype, 'ensure').mockRejectedValueOnce(failure)
    ctx.sessions.create(SessionId('failed-sidecar'))
    await vi.waitFor(() => { expect(error).toHaveBeenCalledWith(failure) })
    vi.restoreAllMocks()
  })

  it('rejects failed metadata publication and permits a subsequent serialized retry', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const invalidate = vi.fn()
    ctx.provide('remoteAccess', { invalidate } as unknown as Context['remoteAccess'])
    const records = new Map<string, { sessionId: string; ownerId?: string; denied?: true }>()
    const put = vi.fn(async (key: string, record: { sessionId: string; ownerId?: string; denied?: true }) => { records.set(key, record) })
    const close = vi.fn().mockResolvedValue(undefined)
    const table = { put, get: (key: string) => records.get(key), entries: () => records.entries() }
    const domain = { table: () => table, close } as unknown as ConstructorParameters<typeof Owners.SessionOwners>[1]
    const owners = new Owners.SessionOwners(ctx, domain)
    // The creation event adopts the single-account owner before the real owner lands.
    await owners.ensure(SessionId('session'))
    expect(owners.sessionsOf('owner')).toEqual([SessionId('session')])
    put.mockRejectedValueOnce(new Error('disk full'))
    await expect(owners.assign(SessionId('session'), 'a')).rejects.toThrow('disk full')
    // A failed owner write must never leave the Session with the account the event adopted.
    expect(owners.sessionsOf('owner')).toEqual([])
    expect(owners.sessionsOf('a')).toEqual([])
    expect(invalidate).toHaveBeenCalled()
    await owners.assign(SessionId('session'), 'a')
    expect(owners.sessionsOf('a')).toEqual([SessionId('session')])
    // Nothing to deny when both the owner and the denial write fail, and the failure still surfaces.
    put.mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce(new Error('disk full'))
    await expect(owners.assign(SessionId('other'), 'a')).rejects.toThrow('disk full')
    expect(owners.sessionsOf('a')).toEqual([SessionId('session')])
    await owners.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('refuses damaged ownership metadata rather than adopting it as the single-account owner', async () => {
    const { ctx, root } = await fixture(true)
    await ctx.loader.root.update([])
    const path = join(root, 'data/session_owners/sessions', `s-${Buffer.from('legacy').toString('hex')}.json`)
    await writeFile(path, 'damaged')
    await expect(ctx.plugin(Owners)).rejects.toThrow('Session ownership metadata is damaged')
    expect(ctx.get('sessionOwners')).toBeUndefined()
    expect(ctx.remoteAccess.decide({ principal: A, action: 'session/list', resources: [{ kind: 'global' }] })).toEqual({ kind: 'deny', reason: 'no-allow' })
    expect(await readFile(path, 'utf8')).toBe('damaged')
  })
})
