import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import { appendPluginRecord, pluginRecordOf, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
  if (external) await External.apply(ctx, config)
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

it('publishes an external agent without selecting or calling the native model', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const handle = await f.open()
  onTestFinished(() => handle.dispose())
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

it('cancels the active turn, keeps a queued followup only when asked, and ignores a cancel while idle', async () => {
  const f = await fixture()
  const service = f.ctx.externalAgentActivation as ExternalAgentActivationService
  const release = hold(service)
  const parked = await f.open()
  onTestFinished(() => parked.dispose())
  parked.agent.inject(prompt('parked'))
  parked.agent.cancel({ kind: 'user' })
  expect(parked.agent.status).toBe('idle')
  expect(parked.agent.inbox.nextStep).toHaveLength(1)
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

it('resumes the same fake session, restores an unclaimed inject, and refuses a stale binding or a lost session id', async () => {
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
  onTestFinished(() => handle.dispose())
  expect(f.create).toHaveBeenCalled()
  expect(f.selection).toHaveBeenCalled()
  await expect(f.ctx.persistentAgentActivation.createOrResume({
    ownerCtx: f.ctx, sessionId: SessionId(`missing-${f.profile.id}`), agentId: f.profile.id,
  })).rejects.toThrow('External agent runtime is unavailable')
  expect(f.adapter.requests).toHaveLength(0)
})

it('wakes mail for an external profile through the activation port', async () => {
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
  await vi.waitFor(() => expect(events(f.ctx.agents.get(target)!).some(event => event.type === 'assistant/message')).toBe(true))
  expect(f.adapter.requests).toHaveLength(before)
  expect(events(f.ctx.agents.get(target)!).some(event => event.type === 'request/header')).toBe(false)
})

it('runs maintenance only while idle and tears the agent down to quiescence', async () => {
  const f = await fixture()
  const handle = await f.open()
  const maintained = await handle.agent.runMaintenance(async () => {
    expect(handle.agent.status).toBe('idle')
    return 'done'
  })
  expect(maintained).toBe('done')
  await handle.dispose()
  expect(f.ctx.agents.get(handle.agent.id)).toBeUndefined()
  await expect(handle.agent.whenIdle()).resolves.toBeUndefined()
})
