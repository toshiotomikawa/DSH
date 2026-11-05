import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import { appendPluginRecord, pluginRecordOf, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionSidecar } from '@deepseek-ai/dsh-experimental-agent-external-runtime'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, onTestFinished, vi } from 'vitest'
import { harness, inherited } from '../../agent-registry/tests/harness.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import * as Memory from '../../agent-memory/src/index.ts'
import * as Mailbox from '../../agent-mailbox/src/index.ts'
import * as Owners from '../../agent-runtime/src/owners.ts'
import * as Accounts from '../../agent-runtime/src/accounts.ts'
import * as Runtime from '../../agent-runtime/src/index.ts'
import * as External from '../src/index.ts'
import { ExternalAgentActivationService } from '../src/driver.ts'
import { ExternalQuotaError } from '../src/quota.ts'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Web from '@deepseek-ai/dsh-host-webserver'
import Schedule from '@deepseek-ai/dsh-schedule'
import Routines from '@deepseek-ai/dsh-agent-routine'
import * as MemoryTools from '../../tool-agent-memory/src/index.ts'

function prompt(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function events(agent: Agent) {
  // oxlint-disable-next-line typescript/no-deprecated -- the test reads the restored prefix and the live suffix
  return agent.session.snapshotEvents()
}

function hold(service: ExternalAgentActivationService): () => void {
  const pending: Array<() => void> = []
  service.sdk = {
    run: input => new Promise((resolve, reject) => {
      service.calls.push(input)
      const finish = (): void => {
        const index = pending.indexOf(finish)
        if (index >= 0) pending.splice(index, 1)
        if (input.signal.aborted) reject(new Error('aborted'))
        else resolve({ text: `external:${input.turn}.${input.step}` })
      }
      if (input.signal.aborted) { finish(); return }
      input.signal.addEventListener('abort', finish, { once: true })
      pending.push(finish)
    }),
  }
  return () => {
    const finish = pending.shift()
    if (finish === undefined) throw new Error('no parked external step')
    finish()
  }
}

async function fixture(external = true) {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/external-driver-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const { ctx, adapter } = await harness(root)
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Memory)
  await ctx.plugin(Typert)
  await ctx.plugin(Query, { path: ':memory:' })
  await createSessionTestController(ctx, { defaultModelSelection: () => inherited, cwd: root })
  await ctx.plugin(Gateway)
  await ctx.plugin(Accounts, { tokenDirectory: join(root, 'tokens') })
  await ctx.plugin(Owners)
  await ctx.plugin(Runtime)
  const account = (await ctx.accounts.create('External', 'member')).account
  const home = join(root, 'harness')
  const workspace = join(root, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  ;(ctx as { workspaceRegistry?: { list(): readonly { path: string }[] } }).workspaceRegistry = {
    list: () => [{ path: workspace }],
  }
  const config: External.Config = {
    bindings: [{ accountId: account.id, runtime: 'claude-sdk', configDirectory: home, revision: 1 }],
  }
  if (external) {
    await External.apply(ctx, config)
    const service = ctx.externalAgentActivation as ExternalAgentActivationService
    service.sdk = { run: (input) => {
      service.calls.push(input)
      input.signal.throwIfAborted()
      return Promise.resolve({ text: `external:${input.turn}.${input.step}` })
    } }
  }
  const selection = vi.spyOn(ctx.persistentAgents, 'selection')
  const create = vi.spyOn(ctx.agents, 'create')
  const profile = await ctx.persistentAgents.create({
    name: 'External', ownerId: account.id, runtime: 'claude-sdk', instructions: 'Stay outside the native API',
  }, inherited)
  const open = async (sessionId = SessionId(`ext-${profile.id}-${Math.random().toString(16).slice(2)}`)) => {
    const handle = await ctx.persistentAgentActivation.createOrResume({
      ownerCtx: ctx, sessionId, agentId: profile.id,
    })
    return handle
  }
  return { ctx, adapter, root, account, workspace, home, config, profile, selection, create, open }
}

it('settles quota once, never repeats consumed inputs and refuses API without profile consent', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  service.sdk = { run: () => Promise.reject(new ExternalQuotaError()) }
  const handle = await f.open()
  handle.agent.followup(prompt('failed input'))
  handle.agent.followup(prompt('queued input'))
  await handle.agent.whenIdle()
  expect(events(handle.agent).filter(event => event.type === 'turn/end')).toHaveLength(1)
  expect(events(handle.agent).filter(event => event.type === 'user/message')).toHaveLength(1)
  expect(events(handle.agent).find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'EXTERNAL_QUOTA_EXHAUSTED' } } } })
  await expect(f.open()).rejects.toBeInstanceOf(ExternalQuotaError)
  await handle.dispose()
  await handle.dispose()
  await expect(f.open()).rejects.toBeInstanceOf(ExternalQuotaError)
  expect(f.adapter.requests).toHaveLength(0)
})

it('uses a reserve only in a new activation, with one live identity and a closed old writer', async () => {
  const f = await fixture()
  await f.ctx.persistentAgents.update(f.profile.id, f.profile.revision, { automaticFallback: true, reserves: [inherited] })
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  service.sdk = { run: () => Promise.reject(new ExternalQuotaError()) }
  const first = await f.open()
  first.agent.followup(prompt('old input'))
  await first.agent.whenIdle()
  expect(f.adapter.requests).toHaveLength(0)
  await expect(f.open()).rejects.toBeInstanceOf(ExternalQuotaError)
  await first.dispose()
  const second = await f.open(first.agent.id)
  onTestFinished(() => second.dispose())
  expect(f.ctx.agents.list().filter(agent => f.ctx.persistentAgents.metadataOf(agent.id)?.agentId === f.profile.id)).toHaveLength(1)
  second.agent.followup(prompt('new input'))
  await second.agent.whenIdle()
  expect(f.adapter.requests).toHaveLength(1)
  expect(events(second.agent).filter(event => event.type === 'turn/end')).toHaveLength(2)
  expect(events(second.agent).filter(event => event.type === 'user/message')).toHaveLength(2)
  await second.dispose()
  await service.clearQuota({ ownerCtx: f.ctx, agentId: f.profile.id })
  await expect(f.open(first.agent.id)).rejects.toMatchObject({ code: 'binding_stale' })
})

it.each(['partial', 'teardown', 'abort'] as const)('refuses a reserve after %s even with consent', async (kind) => {
  const f = await fixture()
  await f.ctx.persistentAgents.update(f.profile.id, f.profile.revision, { automaticFallback: true, reserves: [inherited] })
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  let entered = false
  service.sdk = { run: async (input) => {
    entered = true
    if (kind === 'abort' && !input.signal.aborted) await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
    throw new ExternalQuotaError(undefined, kind === 'partial', kind === 'teardown')
  } }
  const handle = await f.open()
  handle.agent.followup(prompt('input'))
  if (kind === 'abort') {
    await vi.waitFor(() => expect(entered).toBe(true))
    handle.agent.cancel({ kind: 'parent' })
  }
  await handle.agent.whenIdle()
  if (kind === 'teardown') await expect(handle.dispose()).rejects.toBeInstanceOf(ExternalQuotaError)
  else await handle.dispose()
  await expect(f.open()).rejects.toThrow()
  expect(f.adapter.requests).toHaveLength(0)
  expect(events(handle.agent).filter(event => event.type === 'turn/end')).toHaveLength(1)
})

it('closes one routine as failed through Loader and never schedules an automatic retry', async () => {
  const f = await fixture(false)
  await f.ctx.plugin(Loader)
  Object.assign(f.ctx.loader.builtins, { external: External, web: Web, schedule: Schedule, routines: Routines })
  await f.ctx.loader.root.update([
    { id: 'external', name: 'cordis:external', config: f.config },
    { id: 'web', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { id: 'schedule', name: 'cordis:schedule' },
    { id: 'routines', name: 'cordis:routines', config: { tokenFile: join(f.root, 'routine.token'), tickSeconds: 3600 } },
  ])
  await f.ctx.loader.await()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  service.sdk = { run: () => Promise.reject(new ExternalQuotaError(Date.now() + 60000)) }
  const settle = vi.spyOn(f.ctx.agentRoutines.engine, 'settle')
  const created = new Map<string, Agent>()
  f.ctx.on('agent/created', ({ agent }) => { created.set(agent.id, agent) })
  const routine = await f.ctx.agentRoutines.engine.createRoutine({ agentId: f.profile.id, name: 'Quota', instruction: 'One input', trigger: 'script' })
  const { run } = await f.ctx.agentRoutines.engine.trigger(routine.id, { source: 'manual' })
  const worker = created.get(run.sessionId!)!
  await worker.whenIdle()
  await f.ctx.agentRoutines.engine.tick()
  expect(f.ctx.agentRoutines.engine.run(run.id)?.state).toBe('falha')
  expect(settle).toHaveBeenCalledTimes(1)
  await f.ctx.agentRoutines.engine.tick()
  expect(settle).toHaveBeenCalledTimes(1)
  expect(events(worker).filter(event => event.type === 'turn/end')).toHaveLength(1)
  expect(events(worker).filter(event => event.type === 'user/message')).toHaveLength(1)
  expect(f.adapter.requests).toHaveLength(0)
})

it('refuses a reserve after a real admitted tool call', async () => {
  const f = await fixture()
  await f.ctx.plugin(MemoryTools)
  await f.ctx.persistentAgents.update(f.profile.id, f.profile.revision, { automaticFallback: true, reserves: [inherited] })
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  service.sdk = { run: async (input) => {
    const result = await input.tools.call('remember-once', 'remember', { text: 'One durable effect', inclusion: 'essential' })
    expect(result.isError).toBe(false)
    throw new ExternalQuotaError()
  } }
  const handle = await f.open()
  handle.agent.followup(prompt('Remember'))
  await handle.agent.whenIdle()
  expect(events(handle.agent).filter(event => event.type === 'tool/call')).toHaveLength(1)
  await handle.dispose()
  await expect(f.open()).rejects.toBeInstanceOf(ExternalQuotaError)
  expect(f.adapter.requests).toHaveLength(0)
})

it('keeps owner-scoped refusals through storage reopen, expires clean quota and requires a released lease to clear', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const key = service.quota.key(f.account.id, f.profile.id)
  expect(service.quota.key('other', f.profile.id)).not.toBe(key)
  await service.quota.refuse(key, { cause: 'quota_exhausted', afterEffects: false, resetAt: Date.now() - 1 })
  expect(await service.quota.get(key)).toBeUndefined()
  await service.quota.refuse(key, { cause: 'aborted', afterEffects: false })
  const release = service.quota.acquire(key)
  await expect(service.quota.clear(key)).rejects.toThrow('still live')
  release()
  await service.clearQuota({ ownerCtx: f.ctx, agentId: f.profile.id })
  expect(await service.quota.get(key)).toBeUndefined()
  const get = vi.spyOn(f.ctx.persistentAgents, 'get').mockReturnValue({ ...f.profile, ownerId: undefined })
  await service.clearQuota({ ownerCtx: f.ctx, agentId: f.profile.id })
  get.mockRestore()
  await service.quota.refuse(key, { cause: 'teardown_failed', afterEffects: true })
  await expect(f.open()).rejects.toMatchObject({ code: 'EXTERNAL_TEARDOWN_FAILED' })
  await f.ctx.fiber.dispose()
  const reopened = await harness(f.root)
  onTestFinished(() => reopened.ctx.fiber.dispose())
  const { quotaDomain, ExternalQuotaState } = await import('../src/quota.ts')
  const domain = await reopened.ctx.storageDomain.open(quotaDomain)
  onTestFinished(() => domain.close())
  expect(await new ExternalQuotaState(domain).get(key)).toEqual({ cause: 'teardown_failed', afterEffects: true })
})

it.each(['missing', 'unsupported', 'unavailable', 'supported'] as const)('revalidates the reserve before a new native session: %s', async (mode) => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  await service.quota.refuse(service.quota.key(f.account.id, f.profile.id), { cause: 'quota_exhausted', afterEffects: false })
  vi.spyOn(f.ctx.persistentAgents, 'get').mockReturnValue({ ...f.profile, automaticFallback: true,
    reserves: mode === 'missing' ? [] : [{ ...inherited, reasoningEffort: 'low' }] })
  const original = await f.ctx.llm.resolveModelInfo('mock', 'test')
  vi.spyOn(f.ctx.llm, 'resolveModelInfo').mockResolvedValue({ ...original,
    ...(mode === 'unavailable' ? {} : { reasoning: { efforts: mode === 'supported' ? [{ id: ReasoningEffortId('low'), name: 'Low' }] : [] } }) })
  if (mode !== 'supported') {
    await expect(f.open()).rejects.toThrow(mode === 'missing' ? 'quota exhausted' : 'Unsupported reserve')
    expect(f.create).not.toHaveBeenCalled()
  } else {
    const handle = await f.open()
    onTestFinished(() => handle.dispose())
    expect(handle.agent.options.reasoningEffort).toBe('low')
    expect(f.adapter.requests).toHaveLength(0)
  }
})

it('publishes an external agent without selecting or calling the native model', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const handle = await f.open()
  onTestFinished(() => handle.dispose())
  await expect(f.open()).rejects.toThrow('still live')
  expect(f.ctx.agents.get(handle.agent.id)).toBe(handle.agent)
  expect(f.selection).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  handle.agent.followup(prompt('hello'))
  await handle.agent.whenIdle()
  expect(f.adapter.requests).toHaveLength(0)
  expect(events(handle.agent).some(event => event.type === 'request/header')).toBe(false)
  expect(events(handle.agent).some(event => event.type === 'assistant/message')).toBe(true)
  expect(service.calls).toHaveLength(1)
  expect(service.calls[0]).toMatchObject({ instructions: 'Stay outside the native API', sdkSessionId: `fake:${handle.agent.id}` })
  const sidecar = events(handle.agent).map(event => pluginRecordOf(event)).find(record => record !== undefined)
  expect(sidecar?.data).toMatchObject({
    ownerId: f.account.id, agentId: f.profile.id, sessionId: handle.agent.id,
    runtime: 'claude-sdk', revision: 1, sdkSessionId: `fake:${handle.agent.id}`,
  })
  expect(events(handle.agent).filter(event => event.type === 'agent/inbox/spliced').every(event => event.data.outcome === undefined)).toBe(true)
  expect(() => handle.agent.model.select({ provider: 'mock', model: 'test' })).toThrow('External agent runtime refuses API model selection')
})

it('drains an SDK on unload and prevents another service instance from publishing the same identity', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  hold(service)
  const handle = await f.open()
  handle.agent.followup(prompt('cancel on unload'))
  await vi.waitFor(() => expect(service.calls).toHaveLength(1))
  const other = new ExternalAgentActivationService(service.quota, () => { throw new Error('unexpected teardown failure') })
  await expect(other.createOrResume({ ownerCtx: f.ctx, sessionId: SessionId('other'), agentId: f.profile.id })).rejects.toThrow('still live')
  await service.close()
  expect(f.ctx.agents.get(handle.agent.id)).toBeUndefined()
  await expect(f.open()).rejects.toThrow('closed')
  expect(f.adapter.requests).toHaveLength(0)
})

it('drains a pending admission on unload without returning a usable late handle', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  let release!: () => void
  const held = new Promise<undefined>((resolve) => { release = () => resolve(undefined) })
  const stat = vi.spyOn(f.ctx.sessionPersistence, 'stat').mockImplementationOnce(() => held)
  const pending = f.open()
  const refusal = expect(pending).rejects.toThrow('closed')
  await vi.waitFor(() => expect(stat).toHaveBeenCalled())
  const closed = service.close()
  release()
  await refusal
  await closed
  expect(f.ctx.agents.list()).toHaveLength(0)
})

it('runs a queued followup as a later turn and a steer as another step', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const release = hold(service)
  const handle = await f.open()
  onTestFinished(() => handle.dispose())
  handle.agent.followup(prompt('first'))
  await vi.waitFor(() => expect(service.calls).toHaveLength(1))
  handle.agent.followup(prompt('second'))
  handle.agent.steer(prompt('steer'))
  release()
  await vi.waitFor(() => expect(service.calls.length).toBeGreaterThanOrEqual(2))
  expect(service.calls[1]?.step).toBe(2)
  expect(events(handle.agent).filter(event => event.type === 'turn/end')).toHaveLength(0)
  release()
  await vi.waitFor(() => expect(service.calls).toHaveLength(3))
  expect(service.calls[2]).toMatchObject({ turn: 2, step: 1 })
  release()
  await handle.agent.whenIdle()
  const ends = events(handle.agent).filter(event => event.type === 'turn/end')
  expect(ends.map(event => event.data.reason.kind)).toEqual(['completed', 'completed'])
  expect(f.adapter.requests).toHaveLength(0)
})

it('cancels the active turn, keeps a queued followup only when asked, and drops an idle inject', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const release = hold(service)
  const parked = await f.open()
  onTestFinished(() => parked.dispose())
  parked.agent.inject(prompt('parked'))
  parked.agent.cancel({ kind: 'user' })
  expect(parked.agent.status).toBe('idle')
  expect(parked.agent.inbox.nextStep).toHaveLength(0)
  await parked.dispose()
  const held = await f.open()
  onTestFinished(() => held.dispose())
  held.agent.inject(prompt('held'))
  held.agent.cancel({ kind: 'user' }, { keepInbox: true })
  expect(held.agent.inbox.nextStep).toHaveLength(1)
  await held.dispose()
  const kept = await f.open()
  onTestFinished(() => kept.dispose())
  kept.agent.followup(prompt('active'))
  await vi.waitFor(() => expect(service.calls).toHaveLength(1))
  kept.agent.followup(prompt('queued'))
  kept.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await vi.waitFor(() => expect(service.calls).toHaveLength(2))
  release()
  await kept.agent.whenIdle()
  expect(events(kept.agent).filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['aborted', 'completed'])
  await kept.dispose()
  const dropped = await f.open()
  onTestFinished(() => dropped.dispose())
  dropped.agent.followup(prompt('drop'))
  await vi.waitFor(() => expect(service.calls).toHaveLength(3))
  dropped.agent.followup(prompt('discarded'))
  const discarded: string[] = []
  dropped.agent.ctx.on('agent/inbox/discarded', ({ message }) => {
    discarded.push(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
  })
  dropped.agent.cancel({ kind: 'parent' })
  await dropped.agent.whenIdle()
  expect(dropped.agent.inbox.nextTurn).toHaveLength(0)
  expect(discarded).toContain('discarded')
  expect(events(dropped.agent).filter(event => event.type === 'turn/end')).toHaveLength(1)
  expect(f.adapter.requests).toHaveLength(0)
})

it('returns a routine admission before the fake SDK finishes and settles that turn once', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const release = hold(service)
  const settled: unknown[] = []
  f.ctx.provide('agentRoutines', {
    engine: { settle: (_runId: string, outcome: unknown) => { settled.push(outcome); return Promise.resolve(true) } },
  } as Context['agentRoutines'])
  const started = await f.ctx.agentRoutineBridge.runner.start({
    runId: 'run-1', agent: { id: f.profile.id, name: f.profile.name, ownerId: f.account.id }, prompt: 'routine',
  })
  await vi.waitFor(() => {
    const agent = f.ctx.agents.get(SessionId(started.sessionId))
    const end = agent === undefined ? undefined : events(agent).find(event => event.type === 'turn/end')
    expect(service.calls, JSON.stringify(end?.data ?? agent?.status ?? 'missing')).toHaveLength(1)
  })
  expect(f.ctx.agents.get(SessionId(started.sessionId))?.status).toBe('running')
  expect(settled).toHaveLength(0)
  expect(f.selection).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  release()
  await vi.waitFor(() => expect(settled).toHaveLength(1))
  expect(settled[0]).toMatchObject({ kind: 'completed', text: 'external:1.1' })
  await vi.waitFor(() => expect(f.ctx.agents.get(SessionId(started.sessionId))).toBeUndefined())
  expect(settled).toHaveLength(1)
  expect(f.adapter.requests).toHaveLength(0)
})

it('resumes the same fake session, restores an unclaimed inject, and refuses a stale binding or a lost session id', { timeout: 15000 }, async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const sessionId = SessionId(`ext-resume-${f.profile.id}`)
  const first = await f.open(sessionId)
  first.agent.followup(prompt('remember'))
  await first.agent.whenIdle()
  first.agent.inject(prompt('still queued'))
  const sdkSessionId = service.calls[0]?.sdkSessionId
  await first.dispose()
  const second = await f.open(sessionId)
  expect(second.agent.inbox.nextStep.map(message => message.content)).toEqual([[{ type: 'text', text: 'still queued' }]])
  second.agent.followup(prompt('again'))
  await second.agent.whenIdle()
  expect(service.calls[1]?.sdkSessionId).toBe(sdkSessionId)
  expect(events(second.agent).filter(event => event.type === 'turn/start').length).toBeGreaterThan(1)
  appendPluginRecord(second.agent.session, 'plugin:agent-external-runtime/session', {
    ownerId: 'not-the-owner', agentId: f.profile.id, sessionId, runtime: 'claude-sdk', revision: 1, sdkSessionId: sdkSessionId ?? '',
  })
  await second.dispose()
  await expect(f.open(sessionId)).rejects.toMatchObject({ code: 'owner_mismatch' })
  const revised = SessionId(`ext-revised-${f.profile.id}`)
  const third = await f.open(revised)
  third.agent.followup(prompt('bound'))
  await third.agent.whenIdle()
  await third.dispose()
  await External.apply(f.ctx, { bindings: [{ ...f.config.bindings[0]!, revision: 2 }] })
  await expect(f.open(revised)).rejects.toMatchObject({ code: 'binding_stale' })
  const orphan = SessionId(`ext-orphan-${f.profile.id}`)
  await f.ctx.persistentAgents.bind(orphan, f.profile.id)
  const prepared = f.ctx.sessions.prepare(orphan, { meta: { cwd: f.workspace } })
  const writer = await f.ctx.sessionPersistence.create(prepared.header)
  await writer.append([{ type: 'turn/start', seq: SessionSeq(0), time: Date.now(), data: { turn: 1 } }])
  await writer.close()
  await expect(f.open(orphan)).rejects.toMatchObject({ code: 'binding_stale' })
  expect(f.ctx.agents.get(orphan)).toBeUndefined()
  expect(f.adapter.requests).toHaveLength(0)
  expect(f.create).not.toHaveBeenCalled()
})

it('keeps native profiles on the loop and refuses an external profile when the plugin is absent', async () => {
  const f = await fixture(false)
  const native = await f.ctx.persistentAgents.create({ name: 'Native', ownerId: f.account.id, runtime: 'native' }, inherited)
  const sessionId = SessionId(`native-${native.id}`)
  await f.ctx.persistentAgents.bind(sessionId, native.id)
  const handle = await f.ctx.persistentAgentActivation.createOrResume({ ownerCtx: f.ctx, sessionId, agentId: native.id })
  expect(f.create).toHaveBeenCalled()
  expect(f.selection).toHaveBeenCalled()
  await handle.dispose()
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  const again = await f.ctx.persistentAgentActivation.createOrResume({ ownerCtx: f.ctx, sessionId, agentId: native.id })
  onTestFinished(() => again.dispose())
  expect(resume).toHaveBeenCalled()
  await expect(f.ctx.persistentAgentActivation.createOrResume({
    ownerCtx: new Context(), sessionId: SessionId('no-registry'), agentId: native.id,
  })).rejects.toThrow('Persistent agent registry is unavailable')
  const read = f.ctx.get.bind(f.ctx)
  const host = new Proxy(f.ctx, {
    get(target, prop, receiver) {
      if (prop === 'get') return (name: string) => name === 'sessionPersistence' ? undefined : read(name)
      return Reflect.get(target, prop, receiver)
    },
  })
  await expect(f.ctx.persistentAgentActivation.createOrResume({
    ownerCtx: host, sessionId: SessionId(`no-persistence-${native.id}`), agentId: native.id,
  })).rejects.toThrow('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
  await expect(f.ctx.persistentAgentActivation.createOrResume({
    ownerCtx: f.ctx, sessionId: SessionId(`missing-${f.profile.id}`), agentId: f.profile.id,
  })).rejects.toThrow('External agent runtime is unavailable')
  expect(f.adapter.requests).toHaveLength(0)
})

it('wakes mail for an external profile through the activation port', { timeout: 15000 }, async () => {
  const f = await fixture()
  await f.ctx.plugin(Mailbox)
  const senderProfile = await f.ctx.persistentAgents.create({ name: 'Sender', ownerId: f.account.id, runtime: 'native' }, inherited)
  const senderSession = SessionId(`agent-${senderProfile.id}`)
  await f.ctx.persistentAgents.bind(senderSession, senderProfile.id)
  const sender = await f.ctx.agents.create({ sessionId: senderSession, agentOptions: inherited })
  onTestFinished(() => sender.dispose())
  const before = f.adapter.requests.length
  await f.ctx.agentMailbox.send(sender.agent, { recipients: [f.profile.id], text: 'hello external', expectsReply: false })
  const target = SessionId(`agent-${f.profile.id}`)
  await vi.waitFor(() => {
    const agent = f.ctx.agents.get(target)
    expect(agent, 'recipient missing').toBeDefined()
    const list = events(agent!)
    const end = list.find(event => event.type === 'turn/end')
    expect(end?.data.reason.kind ?? 'pending', JSON.stringify(end?.data ?? list.map(event => event.type))).not.toBe('error')
    expect(list.some(event => event.type === 'assistant/message')).toBe(true)
  }, { timeout: 5000 })
  expect(f.adapter.requests).toHaveLength(before)
  expect(events(f.ctx.agents.get(target)!).some(event => event.type === 'request/header')).toBe(false)
})

it('runs maintenance only while idle and tears the agent down to quiescence', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const release = hold(service)
  const handle = await f.open()
  const maintained = await handle.agent.runMaintenance(async () => {
    expect(handle.agent.status).toBe('idle')
    return 'done'
  })
  expect(maintained).toBe('done')
  handle.agent.followup(prompt('busy'))
  await vi.waitFor(() => expect(service.calls).toHaveLength(1))
  expect(() => { handle.agent.runMaintenance(async () => 'no') }).toThrow('agent is busy')
  release()
  await handle.agent.whenIdle()
  await handle.dispose()
  expect(f.ctx.agents.get(handle.agent.id)).toBeUndefined()
  await expect(handle.agent.whenIdle()).resolves.toBeUndefined()
})

it('rejects another account before a stale revision', async () => {
  const f = await fixture()
  const accountB = (await f.ctx.accounts.create('Other', 'member')).account
  const homeB = join(f.root, 'harness-b')
  await mkdir(homeB)
  const sessionId = SessionId(`ext-cross-${f.profile.id}`)
  const first = await f.open(sessionId)
  first.agent.followup(prompt('owned'))
  await first.agent.whenIdle()
  const sdkSessionId = (f.ctx.externalAgentActivation as ExternalAgentActivationService).calls[0]?.sdkSessionId ?? ''
  appendPluginRecord(first.agent.session, 'plugin:agent-external-runtime/session', {
    ownerId: accountB.id, agentId: f.profile.id, sessionId, runtime: 'claude-sdk', revision: 1, sdkSessionId,
  })
  await first.dispose()
  await External.apply(f.ctx, {
    bindings: [
      { accountId: f.account.id, runtime: 'claude-sdk', configDirectory: f.home, revision: 2 },
      { accountId: accountB.id, runtime: 'claude-sdk', configDirectory: homeB, revision: 2 },
    ],
  })
  await expect(f.open(sessionId)).rejects.toMatchObject({ code: 'owner_mismatch' })
})

it('edits the durable inbox and records a non-error turn failure', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const handle = await f.open()
  onTestFinished(() => handle.dispose())
  const held = prompt('held')
  const lead = prompt('lead')
  handle.agent.inbox.append('next-turn', held)
  handle.agent.inbox.prepend('next-turn', lead)
  expect(handle.agent.inbox.nextTurn.map(message => message.id)).toEqual([lead.id, held.id])
  const replacement = prompt('replacement')
  expect(handle.agent.inbox.replace(held.id, replacement)).toBe(true)
  expect(handle.agent.inbox.remove(replacement.id)).toBe(true)
  expect(handle.agent.inbox.remove(lead.id)).toBe(true)
  expect(handle.agent.inbox.replace(MessageId('missing'), held)).toBe(false)
  expect(handle.agent.inbox.remove(MessageId('missing'))).toBe(false)
  const step = prompt('step')
  handle.agent.inbox.append('next-step', step)
  expect(() => handle.agent.inbox.prepend('next-turn', step)).toThrow(`message "${step.id}" is already pending`)
  const extra = prompt('extra')
  handle.agent.inbox.splice('next-step', Number.NaN, 0, [extra])
  expect(handle.agent.inbox.nextStep.map(message => message.id)).toEqual([extra.id, step.id])
  const swapped = prompt('swapped')
  expect(handle.agent.inbox.splice('next-step', -1, 1, [swapped]).map(message => message.id)).toEqual([step.id])
  expect(handle.agent.inbox.splice('next-step', 0, Number.NaN, [])).toEqual([])
  expect(handle.agent.inbox.splice('next-step', 0, -1, [])).toEqual([])
  handle.agent.inbox.clear()
  service.sdk = { run: () => Promise.reject('boom') }
  handle.agent.followup(prompt('fail'))
  await handle.agent.whenIdle()
  expect(events(handle.agent).filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({
    kind: 'error', error: { message: 'boom', code: 'UNKNOWN' },
  })
  hold(service)
  handle.agent.followup(prompt('hook'))
  await vi.waitFor(() => expect(service.calls).toHaveLength(1))
  handle.agent.cancel({ kind: 'hook', reason: 'stop' })
  handle.agent.cancel({ kind: 'user' })
  await handle.agent.whenIdle()
  expect(events(handle.agent).filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({
    kind: 'aborted', reason: { kind: 'hook', reason: 'stop' },
  })
})

it('closes a new session when startup publication fails', async () => {
  const f = await fixture()
  f.ctx.on('agent/created', () => { throw new Error('startup failed') })
  await expect(f.open()).rejects.toThrow('startup failed')
})

it('covers workspace, sidecar, codex resume, and an abort between steps', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const current = await f.open()
  expect(current.agent.model.current()).toBeUndefined()
  await current.dispose()
  const native = await f.ctx.persistentAgents.create({ name: 'NativeEdge', ownerId: f.account.id, runtime: 'native' }, inherited)
  await expect(service.createOrResume({
    ownerCtx: f.ctx, sessionId: SessionId(`native-edge-${native.id}`), agentId: native.id,
  })).rejects.toMatchObject({ code: 'runtime_native' })
  await expect(service.createOrResume({
    ownerCtx: new Context(), sessionId: SessionId('no-registry'), agentId: f.profile.id,
  })).rejects.toMatchObject({ code: 'binding_missing' })
  const read = f.ctx.get.bind(f.ctx)
  const host = new Proxy(f.ctx, {
    get(target, prop, receiver) {
      if (prop === 'get') return (name: string) => name === 'harnessBindings' ? undefined : read(name)
      return Reflect.get(target, prop, receiver)
    },
  })
  await expect(service.createOrResume({
    ownerCtx: host, sessionId: SessionId(`no-binding-${f.profile.id}`), agentId: f.profile.id,
  })).rejects.toMatchObject({ code: 'binding_missing' })
  const registry = f.ctx as { workspaceRegistry?: { list(): readonly unknown[] } }
  registry.workspaceRegistry = { list: () => [null, 1, { nope: true }, { path: '' }, { path: 4 }] }
  await expect(f.open()).rejects.toMatchObject({ code: 'binding_missing' })
  delete registry.workspaceRegistry
  await expect(f.open()).rejects.toMatchObject({ code: 'binding_missing' })
  registry.workspaceRegistry = { list: () => [{ path: f.workspace }] }
  const quiet = SessionId(`ext-quiet-${f.profile.id}`)
  await f.ctx.persistentAgents.bind(quiet, f.profile.id)
  const prepared = f.ctx.sessions.prepare(quiet, { meta: { cwd: f.workspace } })
  const quietWriter = await f.ctx.sessionPersistence.create(prepared.header)
  await quietWriter.append([{
    type: 'plugin:agent-external-runtime/other', seq: SessionSeq(0), time: Date.now(), data: { n: 1 }, ignorable: true,
  } as never])
  await quietWriter.close()
  const quietHandle = await f.open(quiet)
  await quietHandle.dispose()
  const bare = SessionId(`ext-nocwd-${f.profile.id}`)
  await f.ctx.persistentAgents.bind(bare, f.profile.id)
  const bareSession = f.ctx.sessions.prepare(bare, { meta: {} })
  const bareWriter = await f.ctx.sessionPersistence.create(bareSession.header)
  await bareWriter.append([{
    type: 'plugin:agent-external-runtime/other', seq: SessionSeq(0), time: Date.now(), data: { n: 1 }, ignorable: true,
  } as never])
  await bareWriter.close()
  const bareHandle = await f.open(bare)
  await bareHandle.dispose()
  const base = {
    ownerId: f.account.id, agentId: f.profile.id, runtime: 'claude-sdk', revision: 1, sdkSessionId: 'fake:x',
  }
  const broken = [
    null,
    { ...base, ownerId: 1 },
    { ...base, agentId: 1 },
    { ...base, sessionId: 1 },
    { ...base, runtime: 'nope' },
    { ...base, revision: 1.5 },
    { ...base, revision: 0 },
    { ...base, revision: '1' },
    { ...base, sdkSessionId: '' },
    { ...base, sdkSessionId: 1 },
  ]
  for (const [index, data] of broken.entries()) {
    const sessionId = SessionId(`ext-bad-${index}-${f.profile.id}`)
    await f.ctx.persistentAgents.bind(sessionId, f.profile.id)
    const row = f.ctx.sessions.prepare(sessionId, { meta: { cwd: f.workspace } })
    const writer = await f.ctx.sessionPersistence.create(row.header)
    const fields = data as { sessionId?: unknown } | null
    const payload = fields === null ? null : { ...fields, sessionId: fields.sessionId ?? sessionId }
    await writer.append([{
      type: 'plugin:agent-external-runtime/session', seq: SessionSeq(0), time: Date.now(),
      data: payload, ignorable: true,
    } as never])
    await writer.close()
    await expect(f.open(sessionId)).rejects.toMatchObject({ code: 'binding_stale' })
  }
  const homeC = join(f.root, 'harness-codex')
  await mkdir(homeC)
  await External.apply(f.ctx, {
    bindings: [f.config.bindings[0]!, { accountId: f.account.id, runtime: 'codex-sdk', configDirectory: homeC, revision: 1 }],
  })
  const codex = await f.ctx.persistentAgents.create({
    name: 'Codex', ownerId: f.account.id, runtime: 'codex-sdk', instructions: 'codex',
  }, inherited)
  const codexId = SessionId(`ext-codex-${codex.id}`)
  const firstCodex = await f.ctx.persistentAgentActivation.createOrResume({ ownerCtx: f.ctx, sessionId: codexId, agentId: codex.id })
  await firstCodex.dispose()
  const secondCodex = await f.ctx.persistentAgentActivation.createOrResume({ ownerCtx: f.ctx, sessionId: codexId, agentId: codex.id })
  await secondCodex.dispose()
  const replacement = f.ctx.externalAgentActivation as ExternalAgentActivationService
  replacement.sdk = { run: () => Promise.reject(new Error('plain')) }
  const failed = await f.open()
  failed.agent.followup(prompt('plain'))
  await failed.agent.whenIdle()
  expect(events(failed.agent).filter(event => event.type === 'turn/end').at(-1)?.data.reason).toMatchObject({
    kind: 'error', error: { message: 'plain' },
  })
  await failed.dispose()
  replacement.sdk = { run: () => Promise.resolve({ text: 'ok' }) }
  const boundary = await f.open()
  f.ctx.on('session/event', (_session, event) => {
    if (event.type === 'step/end') boundary.agent.cancel({ kind: 'parent' })
  })
  boundary.agent.followup(prompt('boundary'))
  await boundary.agent.whenIdle()
  expect(events(boundary.agent).filter(event => event.type === 'turn/end').at(-1)?.data.reason).toMatchObject({
    kind: 'aborted', reason: { kind: 'parent' },
  })
  await boundary.dispose()
})

function portClosed(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = httpRequest({
      hostname: target.hostname, port: target.port, path: target.pathname, method: 'GET', timeout: 1000,
    }, () => { reject(new Error('still open')) })
    req.on('error', () => resolve())
    req.on('timeout', () => { req.destroy(); resolve() })
    req.end()
  })
}

it('aborts only the account that ended and closes its loopback port', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  hold(service)
  const handle = await f.open()
  onTestFinished(() => handle.dispose())
  handle.agent.followup(prompt('live'))
  await vi.waitFor(() => expect(service.calls).toHaveLength(1))
  const endpoint = service.calls[0]?.tools.endpoint ?? ''
  const other = (await f.ctx.accounts.create('Other', 'member')).account
  await f.ctx.accounts.disable(other.id)
  expect(handle.agent.status).toBe('running')
  await f.ctx.accounts.disable(f.account.id)
  await handle.agent.whenIdle()
  expect(events(handle.agent).filter(event => event.type === 'turn/end').at(-1)?.data.reason).toMatchObject({
    kind: 'aborted', reason: { kind: 'disposed' },
  })
  await portClosed(endpoint)
})

it('fails a turn opened after the account is disabled', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const handle = await f.open()
  onTestFinished(() => handle.dispose())
  await f.ctx.accounts.disable(f.account.id)
  handle.agent.followup(prompt('late'))
  await handle.agent.whenIdle()
  expect(service.calls).toHaveLength(0)
  expect(events(handle.agent).filter(event => event.type === 'turn/end').at(-1)?.data.reason).toMatchObject({
    kind: 'error', error: { message: 'External harness: account_inactive' },
  })
})

it('closes the loopback port when the fake SDK fails and keeps the credential out of the transcript', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  let endpoint = ''
  let secret = ''
  service.sdk = {
    run: (input) => {
      service.calls.push(input)
      endpoint = input.tools.endpoint
      const header = input.tools.authorizationHeader()
      secret = header.slice('Bearer '.length)
      expect(endpoint).not.toContain(secret)
      expect(secret.length).toBeGreaterThan(0)
      expect(input.runtime).toBe('claude-sdk')
      expect(input.tools.childEnv()).toEqual({ MCP_LOOPBACK_AUTHORIZATION: header })
      return Promise.reject(new Error('sdk failed'))
    },
  }
  const handle = await f.open()
  onTestFinished(() => handle.dispose())
  handle.agent.followup(prompt('boom'))
  await handle.agent.whenIdle()
  expect(events(handle.agent).filter(event => event.type === 'turn/end').at(-1)?.data.reason).toMatchObject({
    kind: 'error', error: { message: 'sdk failed' },
  })
  expect(JSON.stringify(events(handle.agent))).not.toContain(secret)
  await portClosed(endpoint)
})

it('cancels the live turn when a later tool call sees an inactive account', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  service.sdk = {
    run: async (input) => {
      service.calls.push(input)
      const accounts = f.ctx.accounts
      const list = accounts.list.bind(accounts)
      accounts.list = () => list().map(entry => entry.id === f.account.id ? { ...entry, state: 'disabled' } : entry)
      const result = await input.tools.call('late', 'remember', { text: 'late' })
      expect(result.code).toBe('tool_denied')
      return { text: 'ignored' }
    },
  }
  const handle = await f.open()
  onTestFinished(() => handle.dispose())
  handle.agent.followup(prompt('late'))
  await handle.agent.whenIdle()
  const reason = events(handle.agent).filter(event => event.type === 'turn/end').at(-1)?.data.reason
  expect(reason, JSON.stringify(reason)).toMatchObject({
    kind: 'aborted', reason: { kind: 'disposed' },
  })
})

it('stores a captured claude session and ignores a placeholder or an empty id', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const captured = '11111111-1111-4111-8111-111111111111'
  service.sdk = {
    run: (input) => {
      service.calls.push(input)
      if (input.sdkSessionId.startsWith('fake:')) return Promise.resolve({ text: 'opened', sdkSessionId: captured })
      if (service.calls.length === 2) return Promise.resolve({ text: 'empty', sdkSessionId: '' })
      if (service.calls.length === 3) return Promise.resolve({ text: 'placeholder', sdkSessionId: 'fake:other' })
      return Promise.resolve({ text: 'kept', sdkSessionId: captured })
    },
  }
  const sessionId = SessionId(`ext-capture-${f.profile.id}`)
  const handle = await f.open(sessionId)
  handle.agent.followup(prompt('hello'))
  await handle.agent.whenIdle()
  handle.agent.followup(prompt('blank'))
  await handle.agent.whenIdle()
  handle.agent.followup(prompt('placeholder'))
  await handle.agent.whenIdle()
  handle.agent.followup(prompt('same'))
  await handle.agent.whenIdle()
  await handle.dispose()
  const again = await f.open(sessionId)
  onTestFinished(() => again.dispose())
  again.agent.followup(prompt('cold'))
  await again.agent.whenIdle()
  expect(service.calls[0]).toMatchObject({ cwd: f.workspace, configDirectory: f.home, sdkSessionId: `fake:${sessionId}` })
  expect(service.calls[1]?.sdkSessionId).toBe(captured)
  expect(service.calls.at(-1)?.sdkSessionId).toBe(captured)
  const records = events(again.agent).map(event => pluginRecordOf(event)).flatMap(record => record === undefined ? [] : [record.data])
  expect(records.map(record => (record as SessionSidecar).sdkSessionId)).toEqual([`fake:${sessionId}`, captured])
  expect(JSON.stringify(events(again.agent))).not.toContain(f.home)
})

interface SessionTable {
  entries(): IterableIterator<[string, { agentId: string; ownerId?: string | undefined }]>
  put(key: string, value: { agentId: string }): Promise<void>
}

function sessionRows(registry: object): SessionTable {
  const domain = (registry as unknown as { domain: { table(name: 'sessions'): SessionTable } }).domain
  return domain.table('sessions')
}

it('denies a bound session with no owner before a stale revision', async () => {
  const f = await fixture()
  const sessionId = SessionId(`ext-no-owner-${f.profile.id}`)
  const table = sessionRows(f.ctx.persistentAgents)
  const before = new Set([...table.entries()].map(([key]) => key))
  const first = await f.open(sessionId)
  first.agent.followup(prompt('owned'))
  await first.agent.whenIdle()
  await first.dispose()
  const added = [...table.entries()].find(([key]) => !before.has(key))
  if (added === undefined) throw new Error('missing session row')
  await table.put(added[0], { agentId: added[1].agentId })
  const binding = f.config.bindings[0]
  if (binding === undefined) throw new Error('missing binding')
  await External.apply(f.ctx, { bindings: [{ ...binding, revision: 2 }] })
  await expect(f.open(sessionId)).rejects.toMatchObject({ code: 'owner_mismatch' })
  expect(f.ctx.agents.get(sessionId)).toBeUndefined()
})

it('resumes a log that already ends at end-seed', async () => {
  const f = await fixture()
  const sessionId = SessionId(`ext-end-seed-${f.profile.id}`)
  await f.ctx.persistentAgents.bind(sessionId, f.profile.id)
  const prepared = f.ctx.sessions.prepare(sessionId, { meta: { cwd: f.workspace } })
  const writer = await f.ctx.sessionPersistence.create(prepared.header)
  await writer.append([{ type: 'session/end-seed', seq: SessionSeq(0), time: Date.now(), data: {} }])
  await writer.close()
  const handle = await f.open(sessionId)
  onTestFinished(() => handle.dispose())
  expect(events(handle.agent).filter(event => event.type === 'session/end-seed')).toHaveLength(1)
})

it('keeps the publication error when the writer close is rejected', async () => {
  const f = await fixture()
  const stored = SessionId(`ext-close-stored-${f.profile.id}`)
  const first = await f.open(stored)
  first.agent.followup(prompt('stored'))
  await first.agent.whenIdle()
  await first.dispose()
  const persistence = f.ctx.sessionPersistence as unknown as {
    persistBatch: (
      header: { id: string },
      events: readonly unknown[],
      materialized: boolean,
      inherited: number,
    ) => Promise<void>
  }
  const drainRefusal = new Error('storage refused the drain')
  let armed = false
  let drains = 0
  const original = persistence.persistBatch.bind(persistence)
  const spy = vi.spyOn(persistence, 'persistBatch').mockImplementation((header, events, materialized, inherited) => {
    if (!armed) return original(header, events, materialized, inherited)
    drains += 1
    return Promise.reject(drainRefusal)
  })
  f.ctx.on('agent/created', ({ agent }) => {
    agent.session.append('turn/start', { turn: 1 })
    armed = true
    throw new Error('startup failed')
  })
  try {
    await expect(f.open(stored)).rejects.toThrow('startup failed')
    await expect(f.open()).rejects.toThrow('startup failed')
    expect(drains).toBe(2)
  } finally {
    spy.mockRestore()
  }
})
