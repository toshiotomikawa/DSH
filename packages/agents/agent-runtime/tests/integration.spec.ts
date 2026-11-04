import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import * as Memory from '@deepseek-ai/dsh-agent-memory'
import * as MemoryTools from '@deepseek-ai/dsh-tool-agent-memory'
import * as Mailbox from '@deepseek-ai/dsh-agent-mailbox'
import * as MailboxTools from '@deepseek-ai/dsh-tool-agent-mailbox'
import Routines, { TRIGGER_PATH } from '@deepseek-ai/dsh-agent-routine'
import * as RoutineTools from '@deepseek-ai/dsh-tool-agent-routine'
import Schedule, { ScheduleId } from '@deepseek-ai/dsh-schedule'
import * as ScheduleTools from '@deepseek-ai/dsh-tool-schedule'
import type { Context } from '@deepseek-ai/cordis'
import Web from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage, LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, it, expect, onTestFinished, vi } from 'vitest'
import { harness, live, Adapter, inherited } from '../../agent-registry/tests/harness.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Runtime from '../src/index.ts'

class Exchange extends Adapter {
  a = ''
  b = ''
  actions: Array<StreamChunk[] | Error | 'hang'> | undefined
  override async * stream(request: GenerateOptions) {
    this.requests.push(request)
    if (this.actions) {
      const action = this.actions.shift()
      if (action instanceof Error) throw action
      if (action === 'hang') {
        await new Promise<void>((_resolve, reject) => {
          request.signal!.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
        })
        return
      }
      yield* action ?? textResponse('done')
      return
    }
    const content = JSON.stringify(request.messages)
    const relay = request.messages.findLast(message => message.source?.kind === 'agent-mailbox')
    const isB = request.sessionId === `agent-${this.b}`
    if (isB && relay?.source?.kind === 'agent-mailbox' && !request.messages.some(message => message.role === 'tool')) {
      yield* toolCallResponse('reply', 'agent_send_message', { message: 'Reply from B', reply_to_message_id: relay.source.messageId, expects_reply: false })
    } else if (content.includes('SCRIPT-PAYLOAD')) {
      yield* textResponse('Routine finished with payload')
    } else if (!relay && !request.messages.some(message => message.role === 'tool')) {
      yield* toolCallResponse('send', 'agent_send_message', { recipients: [this.b], message: 'Hello B' })
    } else {
      yield* textResponse(isB ? 'B replied' : 'A received reply')
    }
  }
}

async function fixture() {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/integration-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const adapter = new Exchange([])
  const f = await harness(root, adapter)
  const created = new Map<string, Agent>()
  f.ctx.on('agent/created', ({ agent }) => { created.set(agent.id, agent) })
  onTestFinished(() => f.ctx.fiber.dispose())
  await f.ctx.plugin(Loader)
  Object.assign(f.ctx.loader.builtins, {
    memory: Memory, memoryTools: MemoryTools, runtime: Runtime, mailbox: Mailbox, mailboxTools: MailboxTools,
    web: Web, schedule: Schedule, routines: Routines, routineTools: RoutineTools,
  })
  const yaml = (await readFile(new URL('./cordis.yml', import.meta.url), 'utf8')).replace('!!js tokenFile', JSON.stringify(join(root, 'routine.token')))
  // Parse through the Loader itself, including schema defaults and service readiness.
  await f.ctx.loader.root.update(load(yaml) as EntryOptions[])
  await f.ctx.loader.await()
  const a = await f.ctx.persistentAgents.create({ name: 'A', instructions: 'Persistent A', ownerId: 'owner' }, inherited)
  const b = await f.ctx.persistentAgents.create({ name: 'B' }, inherited)
  adapter.a = a.id
  adapter.b = b.id
  const sessionId = SessionId(`agent-${a.id}`)
  await f.ctx.agentDirectory.prepare!(f.ctx.agentDirectory.find(a.id)!, sessionId)
  const handle = await f.ctx.agents.create({ sessionId, agentOptions: inherited })
  onTestFinished(() => handle.dispose())
  return { ...f, adapter, root, a, b, agent: handle.agent, created }
}

describe('persistent agent host integration', () => {
  it('keeps agent discovery and interruption within the caller owner, including legacy ownerless profiles', async () => {
    const f = await fixture()
    const foreign = await f.ctx.persistentAgents.create({ name: 'Other account', ownerId: 'other' }, inherited)
    expect(f.ctx.agentDirectory.visible(f.agent).map(item => item.id)).not.toContain(foreign.id)
    expect(f.ctx.agentDirectory.mayInterrupt(f.agent, f.ctx.agentDirectory.find(foreign.id)!)).toBe(false)
    expect(f.ctx.agentDirectory.mayInterrupt(f.agent, { ...f.ctx.agentDirectory.find(foreign.id)!, id: 'absent' })).toBe(false)
    const list = f.ctx.persistentAgents.list.bind(f.ctx.persistentAgents)
    const get = f.ctx.persistentAgents.get.bind(f.ctx.persistentAgents)
    const legacy = <T extends { ownerId?: string | undefined }>(profile: T): T => {
      const copy = { ...profile }
      delete copy.ownerId
      return copy
    }
    vi.spyOn(f.ctx.persistentAgents, 'list').mockImplementation(() => list().map(legacy))
    vi.spyOn(f.ctx.persistentAgents, 'get').mockImplementation(id => legacy(get(id)))
    expect(f.ctx.agentDirectory.visible(f.agent)).toHaveLength(3)
    expect(f.ctx.agentDirectory.mayInterrupt(f.agent, f.ctx.agentDirectory.find(f.b.id)!)).toBe(true)
    expect(f.ctx.agentDirectory.reaches!(f.a.id, f.b.id)).toBe(true)
    expect(f.ctx.agentRoutineBridge.agents(f.a.id)?.ownerId).toBe('owner')
    f.agent.session.append('turn/start', { turn: 1 })
    await f.ctx.agentMemory.remember(f.agent, { text: 'Legacy memory' })
    f.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await f.ctx.agentMemory.settled(f.agent.id)
    expect(await readFile(join(f.root, 'data/agent_memory/books', `${f.a.id}.json`), 'utf8')).toContain('"ownerId": "owner"')
    vi.restoreAllMocks()
  })
  it('admits another owner to directory and interruption only through an explicit grant', async () => {
    const f = await fixture()
    const shared = await f.ctx.persistentAgents.create({ name: 'Shared', ownerId: 'a' }, inherited)
    const callerProfile = await f.ctx.persistentAgents.create({ name: 'Caller B', ownerId: 'b' }, inherited)
    const caller = await live(f.ctx, 'caller-b', callerProfile.id)
    onTestFinished(() => caller.ctx.fiber.dispose())
    expect(f.ctx.agentDirectory.visible(caller).map(item => item.id)).toEqual([callerProfile.id])
    f.ctx.provide('accountGrants', {
      allows: (owner: string, grantee: string) => owner === 'a' && grantee === 'b',
    } as never)
    expect(f.ctx.agentDirectory.visible(caller).map(item => item.id).sort()).toEqual([callerProfile.id, shared.id].sort())
    expect(f.ctx.agentDirectory.mayInterrupt(caller, f.ctx.agentDirectory.find(shared.id)!)).toBe(true)
    // The grant is directional: the host-account agent learns nothing about either account's profiles.
    expect(f.ctx.agentDirectory.visible(f.agent).map(item => item.id)).not.toContain(callerProfile.id)
  })
  it('cuts directory and interruption access the moment the grant is revoked', async () => {
    const f = await fixture()
    const shared = await f.ctx.persistentAgents.create({ name: 'Shared', ownerId: 'a' }, inherited)
    const callerProfile = await f.ctx.persistentAgents.create({ name: 'Caller B', ownerId: 'b' }, inherited)
    const caller = await live(f.ctx, 'caller-b', callerProfile.id)
    onTestFinished(() => caller.ctx.fiber.dispose())
    const stored = new Set(['a>b'])
    f.ctx.provide('accountGrants', { allows: (owner: string, grantee: string) => stored.has(`${owner}>${grantee}`) } as never)
    expect(f.ctx.agentDirectory.visible(caller).map(item => item.id)).toContain(shared.id)
    stored.delete('a>b')
    expect(f.ctx.agentDirectory.visible(caller).map(item => item.id)).toEqual([callerProfile.id])
    expect(f.ctx.agentDirectory.mayInterrupt(caller, f.ctx.agentDirectory.find(shared.id)!)).toBe(false)
  })
  it('answers the delivery-time reach check from the live grant, so a revoke cuts pending mail (grants audit 1)', async () => {
    const f = await fixture()
    const shared = await f.ctx.persistentAgents.create({ name: 'Shared', ownerId: 'a' }, inherited)
    const callerProfile = await f.ctx.persistentAgents.create({ name: 'Caller B', ownerId: 'b' }, inherited)
    const stored = new Set(['a>b'])
    f.ctx.provide('accountGrants', { allows: (owner: string, grantee: string) => stored.has(`${owner}>${grantee}`) } as never)
    const reaches = (from: string, to: string): boolean => f.ctx.agentDirectory.reaches!(from, to)
    expect(reaches(callerProfile.id, shared.id)).toBe(true)
    expect(reaches(shared.id, callerProfile.id)).toBe(false)
    stored.delete('a>b')
    expect(reaches(callerProfile.id, shared.id)).toBe(false)
    expect(reaches(callerProfile.id, callerProfile.id)).toBe(true)
    expect(reaches('gone', shared.id)).toBe(false)
    expect(reaches(shared.id, 'gone')).toBe(false)
  })
  it('refuses generic calendar edits that bypass routine ownership and the three-minute floor', async () => {    const f = await fixture()
    f.ctx.provide('sessionController', {} as Context['sessionController'])
    await f.ctx.plugin(ScheduleTools)
    const routine = await f.ctx.agentRoutines.engine.createRoutine({
      agentId: f.a.id, name: 'Owned calendar', instruction: 'Run', trigger: 'schedule',
      schedule: { kind: 'interval', everySeconds: 180 }, timeZone: 'UTC',
    })
    const id = ScheduleId(routine.scheduleTaskId!)
    const original = await f.ctx.schedule.view({ id })
    const start = new Date(Date.now() + 3_600_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const rrule = `DTSTART:${start}\nRRULE:FREQ=MINUTELY;INTERVAL=1`
    for (const patch of [{ target: 'this_session', rrule }, { target: 'new_once' }, { rrule }, { action: 'delete' }]) {
      const result = await executeToolFixture(f.ctx, {
        agent: f.agent, callId: ToolCallId('bypass'), signal: new AbortController().signal,
        name: 'schedule_edit', arguments: { id, action: 'update', ...patch },
      })
      expect(result.value).toMatchObject({ code: 'invalid_selector' })
      expect(JSON.stringify(result.value)).toContain('routine_update')
      expect(await f.ctx.schedule.view({ id })).toEqual(original)
    }
    await expect(f.ctx.schedule.remoteEdit({ id, action: 'delete' })).rejects.toThrow('routine_update')
    await expect(f.ctx.agentRoutines.engine.editRoutine(routine.id, {
      schedule: { kind: 'interval', everySeconds: 60 },
    })).rejects.toThrow()
    await f.ctx.agentRoutines.engine.editRoutine(routine.id, { name: 'Still owned', active: false })
    expect(await f.ctx.schedule.view({ id })).toMatchObject({ title: 'Still owned', target: { kind: 'new' }, status: 'paused' })
    const ordinary = await f.ctx.schedule.create({ title: 'Ordinary', prompt: 'Run', timing: { kind: 'rrule', rrule }, target: { kind: 'new' } })
    expect(await f.ctx.schedule.remoteEdit({ id: ordinary.id, action: 'update', patch: { title: 'Ordinary changed' } })).toMatchObject({ title: 'Ordinary changed' })
    const tasks = (await f.ctx.schedule['getDomain']()).table('tasks')
    await tasks.put(id, { ...tasks.get(id)!, status: 'ended' })
    await tasks.put(ordinary.id, { ...tasks.get(ordinary.id)!, status: 'ended' })
    await expect(f.ctx.schedule.deleteInactive()).rejects.toThrow('routine_update')
    expect(await f.ctx.schedule.view({ id })).toMatchObject({ title: 'Still owned' })
    expect(await f.ctx.schedule.view({ id: ordinary.id })).toMatchObject({ title: 'Ordinary changed' })
    await f.ctx.agentRoutines.engine.deleteRoutine(routine.id)
    expect(await f.ctx.schedule.view({ id })).toMatchObject({ code: 'schedule_not_found' })
    expect(await f.ctx.schedule.deleteInactive()).toEqual({ deleted: 1 })
  })
  it('keeps working when a routine calendar change notice is claimed', async () => {
    const f = await fixture()
    // Existing hosts can have involved sessions from edits made before routine ownership was enforced.
    f.ctx.provide('sessionController', {} as Context['sessionController'])
    const routine = await f.ctx.agentRoutines.engine.createRoutine({
      agentId: f.a.id, name: 'Notice', instruction: 'Run', trigger: 'schedule',
      schedule: { kind: 'interval', everySeconds: 180 }, timeZone: 'UTC',
    })
    const domain = await f.ctx.schedule['getDomain']()
    const tasks = domain.table('tasks')
    const id = ScheduleId(routine.scheduleTaskId!)
    await tasks.put(id, { ...tasks.get(id)!, involvedSessionIds: [f.agent.id] })
    await f.ctx.agentRoutines.engine.editRoutine(routine.id, { name: 'Changed' })
    await vi.waitFor(() => {
      expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep].some(message =>
        message.content.some(block => block.type === 'text' && block.text.startsWith('[SCHEDULE CHANGE]')))).toBe(true)
    })
    f.adapter.actions = [textResponse('Work survived the notice')]
    f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue working' }], source: { kind: 'user' } }))
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('completed')
  })
  it('lets the calendar record delivery without a duplicate model execution', async () => {
    const f = await fixture()
    f.ctx.provide('sessionController', {
      async create({ sessionId }: { sessionId: SessionId }) {
        const handle = await f.ctx.agents.create({ sessionId, agentOptions: inherited })
        onTestFinished(() => handle.dispose())
      },
    } as unknown as Context['sessionController'])
    f.ctx.on('schedule/resolve-agent', (id, next) => {
      const agent = f.ctx.agents.get(id)
      return agent === undefined ? next() : Promise.resolve(agent)
    })
    const routine = await f.ctx.agentRoutines.engine.createRoutine({
      agentId: f.a.id, name: 'Calendar', instruction: 'Run', trigger: 'schedule',
      schedule: { kind: 'interval', everySeconds: 180 }, timeZone: 'America/Sao_Paulo',
    })
    f.adapter.actions = [textResponse('Calendar result')]
    await f.ctx.schedule.run({ id: ScheduleId(routine.scheduleTaskId!) })
    await vi.waitFor(() => { expect(f.ctx.agentRoutines.engine.history(routine.id)[0]?.sessionId).toBeDefined() })
    const run = f.ctx.agentRoutines.engine.history(routine.id)[0]!
    await f.created.get(run.sessionId!)!.whenIdle()
    await f.ctx.agentRoutines.engine.tick()
    expect(f.ctx.agentRoutines.engine.run(run.id)).toMatchObject({ state: 'sucesso_relato', result: 'Calendar result' })
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.adapter.requests[0]?.sessionId).toBe(run.sessionId)
    f.ctx.emit('agent/inbox/claimed', { agent: f.agent, turn: 1, message: createUserMessage({
      content: [{ type: 'reasoning', text: 'not scheduler framing' }], source: { kind: 'schedule' },
    }) })

    // A normal reminder and a user's lookalike text retain their ordinary turns.
    f.adapter.actions = [textResponse('ordinary'), textResponse('user')]
    const carrier = [...f.created.values()].find(agent => agent.id !== f.agent.id && agent.id !== run.sessionId)!
    carrier.followup(createUserMessage({ content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nordinary reminder' }], source: { kind: 'schedule' } }))
    await carrier.whenIdle()
    carrier.followup(createUserMessage({ content: [{ type: 'text', text: `schedule_id_json: ${JSON.stringify(routine.scheduleTaskId)}` }], source: { kind: 'user' } }))
    await carrier.whenIdle()
    expect(f.adapter.requests).toHaveLength(3)
  })
  it('delivers A to B and a reply, then runs an authenticated script payload in a fresh A session', async () => {
    const f = await fixture()
    f.agent.session.append('turn/start', { turn: 1 })
    await f.ctx.agentMemory.remember(f.agent, { text: 'Essential A fact', inclusion: 'essential' })
    f.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await f.ctx.agentMemory.settled(f.agent.id)
    f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Send a message to B' }], source: { kind: 'user' } }))
    await f.agent.whenIdle()
    await f.ctx.agentMailbox.flush()
    const b = f.ctx.agents.get(SessionId(`agent-${f.b.id}`))!
    await b.whenIdle()
    await f.ctx.agentMailbox.flush()
    await f.agent.whenIdle()
    await f.ctx.agentMailbox.settled()
    expect(f.ctx.persistentAgents.of(b)).toBe(f.b.id)
    expect(f.agent.id).not.toBe(f.a.id)
    expect(f.ctx.agentRoutineBridge.agentOfSession!(f.agent.id)).toBe(f.a.id)
    expect(JSON.stringify(f.agent.session.snapshotEvents())).toContain('Reply from B')
    expect(f.adapter.requests.filter(request => request.sessionId === f.agent.id).every(request => JSON.stringify(request.messages).includes('Essential A fact'))).toBe(true)
    expect(f.ctx.agentMailbox.list(f.agent).every(target => target.pending === 0)).toBe(true)

    const routine = await f.ctx.agentRoutines.engine.createRoutine({ agentId: f.a.id, name: 'Script', instruction: 'Process the supplied payload', trigger: 'script', active: false, scriptEnabled: true })
    const token = await readFile(join(f.root, 'routine.token'), 'utf8')
    const response = await fetch(`http://127.0.0.1:${f.ctx.webServer.port}${TRIGGER_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json' }, body: JSON.stringify({ routineId: routine.id, payload: { event: 'SCRIPT-PAYLOAD' } }) })
    expect(response.status).toBe(202)
    const receipt = await response.json() as { runId: string }
    const admitted = f.ctx.agentRoutines.engine.run(receipt.runId)!
    expect(admitted.sessionId).not.toBe(f.agent.id)
    const worker = f.created.get(admitted.sessionId!)!
    await worker.whenIdle()
    // A serial engine operation is a barrier after the turn/end observer queued settle.
    await f.ctx.agentRoutines.engine.tick()
    const done = f.ctx.agentRoutines.engine.run(receipt.runId)!
    expect(done).toMatchObject({ state: 'sucesso_relato', result: 'Routine finished with payload' })
    expect(f.ctx.persistentAgents.of(worker)).toBe(f.a.id)
    const prompt = JSON.stringify(f.adapter.requests.find(request => request.sessionId === worker.id)?.messages)
    expect(prompt).toContain('Essential A fact')
    expect(prompt).toContain('DADOS EXTERNOS')
    expect(prompt).toContain('SCRIPT-PAYLOAD')
    const listed = await executeToolFixture(f.ctx, { agent: f.agent, callId: ToolCallId('routines'), signal: new AbortController().signal, name: 'routine_list', arguments: {} })
    expect(listed.isError).toBeFalsy()
  })

  it('settles quota, authentication, failure and cancellation without waiting inside admission', async () => {
    const f = await fixture()
    const scenarios = [
      { failure: new LlmError('quota', 'QUOTA', { providerRetryAfterMs: 60000 }), state: 'espera_cota' },
      { failure: new LlmError('rate', 'OTHER', { status: 429 }), state: 'espera_cota' },
      { failure: new LlmError('invalid reset', 'QUOTA', { providerRetryAfterMs: Number.MAX_VALUE }), state: 'espera_cota' },
      { failure: new LlmError('auth', 'AUTH', { status: 401 }), state: 'falha' },
      { failure: new LlmError('auth', 'AUTH', { status: 403 }), state: 'falha' },
      { failure: new LlmError('other', 'UNKNOWN'), state: 'falha' },
    ]
    for (const [index, scenario] of scenarios.entries()) {
      f.adapter.actions = [scenario.failure]
      const routine = await f.ctx.agentRoutines.engine.createRoutine({ agentId: f.a.id, name: `Failure ${index}`, instruction: 'Run', trigger: 'script' })
      const { run } = await f.ctx.agentRoutines.engine.trigger(routine.id, { source: 'manual' })
      await f.created.get(run.sessionId!)!.whenIdle()
      await f.ctx.agentRoutines.engine.tick()
      expect(f.ctx.agentRoutines.engine.run(run.id)?.state).toBe(scenario.state)
    }
    f.adapter.actions = [toolCallResponse('effect', 'remember', { text: 'not committed' }), new LlmError('quota after tool', 'QUOTA')]
    const uncertain = await f.ctx.agentRoutines.engine.createRoutine({ agentId: f.a.id, name: 'Uncertain', instruction: 'Run', trigger: 'script' })
    const { run } = await f.ctx.agentRoutines.engine.trigger(uncertain.id, { source: 'manual' })
    await f.created.get(run.sessionId!)!.whenIdle()
    await f.ctx.agentRoutines.engine.tick()
    expect(f.ctx.agentRoutines.engine.run(run.id)).toMatchObject({ state: 'falha', uncertain: true })
    expect(await f.ctx.agentMemory.search(f.a.id, 'committed')).toEqual([])

    f.adapter.actions = ['hang']
    const blocked = await f.ctx.agentRoutines.engine.createRoutine({ agentId: f.a.id, name: 'Cancelled', instruction: 'Run', trigger: 'script' })
    const { run: active } = await f.ctx.agentRoutines.engine.trigger(blocked.id, { source: 'manual' })
    await f.ctx.agentRoutineBridge.runner.cancel(active.sessionId!)
    await f.created.get(active.sessionId!)!.whenIdle()
    await f.ctx.agentRoutines.engine.tick()
    expect(f.ctx.agentRoutines.engine.run(active.id)?.state).toBe('cancelada')
    await f.ctx.agentRoutineBridge.runner.cancel('absent')
    expect(f.ctx.agentDirectory.find('absent')).toBeUndefined()
    expect(f.ctx.agentRoutineBridge.agents('absent')).toBeUndefined()
    expect(f.ctx.agentRoutineBridge.agentOfSession!('absent')).toBeUndefined()
    expect(f.ctx.agentDirectory.visible(f.agent).map(entry => entry.id)).toEqual([f.a.id, f.b.id])
    expect(f.ctx.agentDirectory.mayInterrupt(f.agent, f.ctx.agentDirectory.find(f.b.id)!)).toBe(true)
    const id = f.ctx.agentDirectory.thread(f.ctx.agentDirectory.find(f.b.id)!)
    await f.ctx.agentDirectory.prepare!(f.ctx.agentDirectory.find(f.b.id)!, id)
    expect(f.ctx.agentRoutineBridge.agentOfSession!(id)).toBe(f.b.id)
    const unbound = await f.ctx.agents.create({ sessionId: SessionId('unbound'), agentOptions: inherited })
    onTestFinished(() => unbound.dispose())
    expect(() => f.ctx.agentDirectory.describe(unbound.agent)).toThrow('no persistent agent')
    const profiles = f.ctx.persistentAgents.list()
    const listing = vi.spyOn(f.ctx.persistentAgents, 'list').mockReturnValue([])
    expect(() => f.ctx.agentDirectory.describe(f.agent)).toThrow('Unknown persistent agent')
    listing.mockReturnValue(profiles.map(profile => ({ ...profile, model: { ...profile.model, reasoningEffort: 'low' } })))
    expect(f.ctx.agentDirectory.find(f.a.id)?.model?.reasoningEffort).toBe('low')
    listing.mockRestore()
    f.adapter.actions = [textResponse('settlement failure')]
    const settle = vi.spyOn(f.ctx.agentRoutines.engine, 'settle').mockRejectedValueOnce(new Error('storage unavailable'))
    const warn = vi.spyOn(f.ctx.logger, 'warn')
    const failing = await f.ctx.agentRoutines.engine.createRoutine({ agentId: f.a.id, name: 'Storage failure', instruction: 'Run', trigger: 'script' })
    const { run: failed } = await f.ctx.agentRoutines.engine.trigger(failing.id, { source: 'manual' })
    await f.created.get(failed.sessionId!)!.whenIdle()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('storage unavailable')) })
    settle.mockRestore()
    f.adapter.actions = ['hang']
    const closing = await f.ctx.agentRoutines.engine.createRoutine({ agentId: f.b.id, name: 'Closing', instruction: 'Run', trigger: 'script' })
    await f.ctx.agentRoutines.engine.trigger(closing.id, { source: 'manual' })
    const bridge = f.ctx.agentRoutineBridge
    const runtime = f.ctx.loader.root.tree.store.runtime!
    await runtime.fiber!.dispose()
    expect(f.ctx.get('agentDirectory')).toBeUndefined()
    await expect(bridge.runner.start({ runId: 'closed', agent: { id: f.a.id, name: 'A' }, prompt: 'Run' })).rejects.toThrow('closed')
    vi.restoreAllMocks()
  })

  it('refuses routine admission without the owning routine service', async () => {
    const f = await fixture()
    await f.ctx.loader.root.tree.store.routines!.fiber!.dispose()
    f.ctx.emit('agent/inbox/claimed', { agent: f.agent, turn: 1, message: createUserMessage({
      content: [{ type: 'text', text: 'ordinary reminder' }], source: { kind: 'schedule' },
    }) })
    await expect(f.ctx.agentRoutineBridge.runner.start({ runId: 'missing', agent: { id: f.a.id, name: 'A' }, prompt: 'Run' })).rejects.toThrow('unavailable')
  })
})
