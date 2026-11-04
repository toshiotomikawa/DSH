import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Mailbox from '../src/index.ts'
import type { MailboxDirectory, MailboxTarget } from '../src/index.ts'

class ScriptedDirectory implements MailboxDirectory {
  readonly targets = new Map<string, MailboxTarget>()
  readonly bySession = new Map<string, MailboxTarget>()
  readonly hidden = new Set<string>()
  readonly authority = new Set<string>()
  readonly failFind = new Set<string>()
  private threads = 0

  add(target: MailboxTarget): MailboxTarget {
    this.targets.set(target.id, target)
    this.bySession.set(target.sessionId, target)
    return target
  }

  describe(agent: Agent): MailboxTarget {
    const target = this.bySession.get(agent.id)
    if (target === undefined) throw new Error(`Unknown live session: ${agent.id}`)
    return target
  }

  visible(caller: Agent): readonly MailboxTarget[] {
    const own = this.describe(caller)
    return [...this.targets.values()].filter(target => target.id !== own.id && !this.hidden.has(target.id))
  }

  find(agentId: string): MailboxTarget | undefined {
    if (this.failFind.delete(agentId)) throw new Error('registry unavailable')
    return this.targets.get(agentId)
  }

  mayInterrupt(caller: Agent, target: MailboxTarget): boolean {
    return this.authority.has(`${this.describe(caller).id}->${target.id}`)
  }

  thread(target: MailboxTarget, _title?: string): SessionId {
    this.threads += 1
    const sessionId = SessionId(`${target.sessionId}-thread-${this.threads}`)
    this.bySession.set(sessionId, target)
    return sessionId
  }
}

class TextAdapter extends MockAdapter {
  requestCount = 0

  constructor(private readonly body: string = 'ok', private readonly delayMs = 0) {
    super([])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    this.requestCount += 1
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs))
    yield* textResponse(this.body)
  }
}

class GateAdapter extends MockAdapter {
  hold = true
  requestCount = 0
  private releases: Array<() => void> = []

  constructor(private readonly body: string = 'held') {
    super([])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requestCount += 1
    if (this.hold) {
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        this.releases.push(resolve)
      })
    }
    yield* textResponse(this.body)
  }

  release(): void {
    this.hold = false
    for (const resolve of this.releases.splice(0)) resolve()
  }
}

async function harness(root: string, adapters: Record<string, MockAdapter>, mountMailbox = true) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'data') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  for (const [route, adapter] of Object.entries(adapters)) ctx.llm.registerAdapter([route], adapter)
  const directory = new ScriptedDirectory()
  ctx.provide('agentDirectory', directory)
  if (mountMailbox) await ctx.plugin(Mailbox)
  return { ctx, directory }
}

async function agent(ctx: Context, sessionId: string, route = 'mock-a'): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    agentOptions: { provider: route, model: 'test' },
  })
  return handle.agent
}

function options(route: string): AgentOptions {
  return { provider: route, model: 'test' }
}

async function storedMessages(root: string): Promise<Array<Record<string, unknown>>> {
  const directory = join(root, 'data/agent_mailbox/messages')
  try {
    const files = await readdir(directory)
    return await Promise.all(files.map(async (name) => {
      const stored = JSON.parse(await readFile(join(directory, name), 'utf8')) as { record: Record<string, unknown> }
      return stored.record
    }))
  } catch {
    return []
  }
}

async function persistedSession(root: string, id: string, turns: readonly { turn: number; end?: 'completed' | 'aborted' }[]): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const handle = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: Date.now(), isSeeded: false,
  })
  const events: SessionEvent[] = turns.length === 0
    ? [{ type: 'session/end-seed', seq: SessionSeq(0), time: Date.now(), data: {} }]
    : turns.flatMap<SessionEvent>((turn, index) => [
      { type: 'turn/start', seq: SessionSeq(index * 2), time: Date.now(), data: { turn: turn.turn } },
      ...turn.end === undefined ? [] : [{
        type: 'turn/end' as const, seq: SessionSeq(index * 2 + 1), time: Date.now(),
        data: { turn: turn.turn, reason: turn.end === 'completed' ? { kind: 'completed' as const } : { kind: 'aborted' as const, reason: { kind: 'user' as const } } },
      }],
    ])
  await handle.append(events)
  await handle.flush()
  await handle.close()
  await ctx.fiber.dispose()
}

async function seedMessage(
  root: string,
  input: { id: string; recipientId: string; sessionId: string; state: string; turn?: number; text?: string },
): Promise<void> {
  const directory = join(root, 'data/agent_mailbox/messages')
  await mkdir(directory, { recursive: true })
  const record = {
    id: input.id,
    senderId: 'a',
    senderName: 'A',
    senderSessionId: 'a-main',
    text: input.text ?? input.id,
    expectsReply: true,
    createdAt: Date.now(),
    deliveries: [{
      recipientId: input.recipientId,
      sessionId: input.sessionId,
      state: input.state,
      attempts: 1,
      ...(input.turn === undefined ? {} : { turn: input.turn }),
    }],
  }
  await writeFile(join(directory, `${input.id}.json`), JSON.stringify({ version: 1, record }), 'utf8')
}

async function fixture(adapters: Record<string, MockAdapter> = {}) {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/mailbox-'))
  const built = await harness(root, adapters)
  onTestFinished(async () => {
    await built.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ...built, root }
}

describe('agent mailbox', () => {
  it('delivers a message to another root, returns the reply to the origin conversation, and reports the receipt (1)', async () => {
    const a = new TextAdapter('a-ok')
    const b = new TextAdapter('b-ok')
    const { ctx, directory } = await fixture({ 'mock-a': a, 'mock-b': b })
    directory.add({ id: 'a', name: 'A', title: 'Sender', description: '', sessionId: SessionId('a-main'), model: options('mock-a'), ownerId: 'owner-1' })
    directory.add({ id: 'b', name: 'B', title: 'Receiver', description: '', sessionId: SessionId('b-main'), model: options('mock-b'), ownerId: 'owner-1' })
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    const receipt = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'do the work' })
    expect(receipt.deliveries).toEqual([{ recipientId: 'b', state: 'queued' }])
    await ctx.agentMailbox.flush()
    await receiver.whenIdle()
    expect(receiver.session.deriveMessages().some(message => JSON.stringify(message.content).includes('do the work'))).toBe(true)
    const reply = await ctx.agentMailbox.send(receiver, { replyToMessageId: receipt.messageId, text: 'done' })
    expect(reply.deliveries).toEqual([{ recipientId: 'a', state: 'queued' }])
    await ctx.agentMailbox.flush()
    await sender.whenIdle()
    expect(sender.session.deriveMessages().some(message => JSON.stringify(message.content).includes('done'))).toBe(true)
    const summaries = ctx.agentMailbox.list(sender)
    expect(summaries.find(summary => summary.id === 'b')).toMatchObject({ status: 'ready', queued: false, pending: 0 })
  })

  it('conserves a queued delivery across restart, retries once, and resumes the target later (2)', async () => {
    await mkdir('.dsh-test', { recursive: true })
    const root = await mkdtemp(join(process.cwd(), '.dsh-test/mailbox-restart-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const target = { id: 'b', name: 'B', title: 'Receiver', description: '', sessionId: SessionId('b-main'), model: options('mock-b') }

    const first = await harness(root, { 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() })
    first.directory.add({ id: 'a', name: 'A', title: 'Sender', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    first.directory.add(target)
    const sender = await agent(first.ctx, 'a-main')
    sender.followup(createUserMessage({ content: [{ type: 'text', text: 'warm the log' }], source: { kind: 'user' } }))
    await sender.whenIdle()
    first.directory.failFind.add('b')
    const receipt = await first.ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'queued across restart', idempotencyKey: 'queued' })
    await first.ctx.agentMailbox.settled()
    const repeated = await first.ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'queued across restart', idempotencyKey: 'queued' })
    expect(repeated.messageId).toBe(receipt.messageId)
    expect(repeated.deliveries[0]).toMatchObject({ state: 'queued', error: 'Error: registry unavailable' })
    const queued = (await storedMessages(root)).find(message => message['id'] === receipt.messageId) as { deliveries: Array<Record<string, unknown>> }
    expect(queued.deliveries[0]).toMatchObject({ state: 'queued', attempts: 1, error: 'Error: registry unavailable' })
    expect(first.ctx.agentMailbox.list(sender).find(summary => summary.id === 'b'))
      .toMatchObject({ status: 'queued', queued: true, blocked: 'Error: registry unavailable' })
    await first.ctx.fiber.dispose()

    const secondAdapter = new TextAdapter('second')
    const second = await harness(root, { 'mock-a': new TextAdapter(), 'mock-b': secondAdapter })
    second.directory.add({ id: 'a', name: 'A', title: 'Sender', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    second.directory.add(target)
    const secondSender = (await second.ctx.agents.resume({ resumeSessionId: SessionId('a-main') })).agent
    await second.ctx.agentMailbox.flush()
    const secondReceiver = second.ctx.agents.get(SessionId('b-main'))
    expect(secondReceiver).toBeDefined()
    await secondReceiver!.whenIdle()
    await second.ctx.agentMailbox.flush()
    expect(secondAdapter.requestCount).toBe(1)
    await second.ctx.agentMailbox.flush()
    expect(secondAdapter.requestCount).toBe(1)
    expect(second.ctx.agentMailbox.list(secondSender).find(summary => summary.id === 'b'))
      .toMatchObject({ status: 'ready', queued: false, pending: 1 })
    const delivered = (await storedMessages(root)).find(message => message['id'] === receipt.messageId) as { deliveries: Array<Record<string, unknown>> }
    expect(delivered.deliveries[0]).toMatchObject({ state: 'completed', attempts: 2 })
    await second.ctx.fiber.dispose()

    const thirdAdapter = new TextAdapter('third')
    const third = await harness(root, { 'mock-a': new TextAdapter(), 'mock-b': thirdAdapter })
    third.directory.add({ id: 'a', name: 'A', title: 'Sender', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    third.directory.add(target)
    const thirdSender = (await third.ctx.agents.resume({ resumeSessionId: SessionId('a-main') })).agent
    await third.ctx.agentMailbox.send(thirdSender, { recipients: ['b'], text: 'resume the target' })
    await third.ctx.agentMailbox.flush()
    const thirdReceiver = third.ctx.agents.get(SessionId('b-main'))
    await thirdReceiver!.whenIdle()
    await third.ctx.agentMailbox.flush()
    expect(thirdAdapter.requestCount).toBe(1)
    expect(thirdReceiver!.session.deriveMessages().some(message => JSON.stringify(message.content).includes('resume the target'))).toBe(true)
    await third.ctx.fiber.dispose()
  })

  it('repeats an idempotent send without a second message and rejects changed payloads (2)', async () => {
    const { ctx, directory, root } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter(), 'mock-c': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    directory.add({ id: 'c', name: 'C', title: '', description: '', sessionId: SessionId('c-main'), model: options('mock-c') })
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    await agent(ctx, 'c-main')
    const first = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'one', idempotencyKey: 'same' })
    const repeated = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'one', idempotencyKey: 'same' })
    expect(repeated.messageId).toBe(first.messageId)
    expect(await storedMessages(root)).toHaveLength(1)
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'two', idempotencyKey: 'same' }))
      .rejects.toThrow('different message')
    await expect(ctx.agentMailbox.send(sender, { recipients: ['c'], text: 'one', idempotencyKey: 'same' }))
      .rejects.toThrow('different message')
    const plain = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'plain' })
    const plainAgain = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'plain' })
    expect(plainAgain.messageId).not.toBe(plain.messageId)

    const reply = await ctx.agentMailbox.send(receiver, { replyToMessageId: first.messageId, text: 'answer', idempotencyKey: 'reply' })
    const replyAgain = await ctx.agentMailbox.send(receiver, { replyToMessageId: first.messageId, text: 'answer', idempotencyKey: 'reply' })
    expect(replyAgain.messageId).toBe(reply.messageId)
    await expect(ctx.agentMailbox.send(receiver, { replyToMessageId: first.messageId, text: 'changed', idempotencyKey: 'reply' }))
      .rejects.toThrow('different message')
    await expect(ctx.agentMailbox.send(receiver, { replyToMessageId: first.messageId, text: 'again' }))
      .rejects.toThrow('already answered')
  })

  it('queues for a busy target and keeps one turn at a time (3)', async () => {
    const gated = new GateAdapter('first-turn')
    const { ctx, directory } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': gated })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'first task' })
    await ctx.agentMailbox.flush()
    await vi.waitFor(() => { expect(receiver.status).toBe('running') })
    const second = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'second task' })
    await ctx.agentMailbox.flush()
    expect(gated.requestCount).toBe(1)
    expect(receiver.status).toBe('running')
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ status: 'working', pending: 2 })
    gated.release()
    await receiver.whenIdle()
    await ctx.agentMailbox.flush()
    expect(gated.requestCount).toBe(2)
    expect(receiver.session.deriveMessages().some(message => JSON.stringify(message.content).includes('second task'))).toBe(true)
    expect(second.deliveries[0]).toEqual({ recipientId: 'b', state: 'queued' })
  })

  it('keeps expectsReply pending until a valid answer and creates no cycle (4)', async () => {
    const { ctx, directory } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    const request = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'needs an answer' })
    await ctx.agentMailbox.flush()
    await receiver.whenIdle()
    await ctx.agentMailbox.flush()
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ pending: 1 })
    await ctx.agentMailbox.send(receiver, { replyToMessageId: request.messageId, text: 'answer' })
    await ctx.agentMailbox.flush()
    await sender.whenIdle()
    await ctx.agentMailbox.flush()
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ pending: 0 })
    expect(ctx.agentMailbox.list(receiver).find(summary => summary.id === 'a')).toMatchObject({ pending: 0 })

    const informational = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'informative', expectsReply: false })
    await ctx.agentMailbox.flush()
    await receiver.whenIdle()
    await ctx.agentMailbox.flush()
    expect(informational.deliveries[0]).toEqual({ recipientId: 'b', state: 'queued' })
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ pending: 0 })
    await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'still waiting' })
    await ctx.agentMailbox.flush()
    await receiver.whenIdle()
    await ctx.agentMailbox.flush()
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ pending: 1 })
  })

  it('delivers to several recipients, keeps unanswered requests, and rejects an invalid batch before writing (5)', async () => {
    const { ctx, directory, root } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter(), 'mock-c': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    directory.add({ id: 'c', name: 'C', title: '', description: '', sessionId: SessionId('c-main'), model: options('mock-c') })
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    const other = await agent(ctx, 'c-main', 'mock-c')
    const request = await ctx.agentMailbox.send(sender, { recipients: ['b', 'c'], text: 'both' })
    await ctx.agentMailbox.flush()
    await receiver.whenIdle()
    await other.whenIdle()
    await ctx.agentMailbox.flush()
    await ctx.agentMailbox.send(receiver, { replyToMessageId: request.messageId, text: 'b answered' })
    await ctx.agentMailbox.flush()
    await sender.whenIdle()
    await ctx.agentMailbox.flush()
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ pending: 0 })
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'c')).toMatchObject({ pending: 1 })
    const before = (await storedMessages(root)).length
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b', 'missing'], text: 'partial' }))
      .rejects.toThrow('Unknown or invisible agent')
    expect(await storedMessages(root)).toHaveLength(before)
  })

  it('opens a thread for one target and returns the answer to the origin conversation (6)', async () => {
    const { ctx, directory } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    directory.add({ id: 'c', name: 'C', title: '', description: '', sessionId: SessionId('c-main'), model: options('mock-b') })
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    const request = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'thread task', newThread: true, title: 'Side work' })
    await ctx.agentMailbox.flush()
    const thread = ctx.agents.get(SessionId('b-main-thread-1'))
    expect(thread).toBeDefined()
    expect(receiver.status).toBe('idle')
    await thread!.whenIdle()
    await ctx.agentMailbox.flush()
    await ctx.agentMailbox.send(thread!, { replyToMessageId: request.messageId, text: 'thread answer' })
    await ctx.agentMailbox.flush()
    await sender.whenIdle()
    await ctx.agentMailbox.flush()
    expect(sender.session.deriveMessages().some(message => JSON.stringify(message.content).includes('thread answer'))).toBe(true)
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b', 'c'], text: 'many', newThread: true }))
      .rejects.toThrow('exactly one recipient')
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'titled', title: 'Wrong' }))
      .rejects.toThrow('requires newThread')
  })

  it('rejects replies from outsiders, duplicate answers and forged sender names (7)', async () => {
    const { ctx, directory, root } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter(), 'mock-c': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    directory.add({ id: 'c', name: 'C', title: '', description: '', sessionId: SessionId('c-main'), model: options('mock-c') })
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    const outsider = await agent(ctx, 'c-main', 'mock-c')
    const request = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'question' })
    await expect(ctx.agentMailbox.send(sender, { replyToMessageId: 'missing-message', text: 'nobody' }))
      .rejects.toThrow('Unknown message')
    await expect(ctx.agentMailbox.send(receiver, { replyToMessageId: request.messageId, recipients: ['a'], text: 'wrong shape' }))
      .rejects.toThrow('omit recipients')
    await expect(ctx.agentMailbox.send(receiver, { replyToMessageId: request.messageId, newThread: true, text: 'wrong thread' }))
      .rejects.toThrow('cannot open a new thread')
    await expect(ctx.agentMailbox.send(outsider, { replyToMessageId: request.messageId, text: 'intruder' }))
      .rejects.toThrow('Only a recipient')
    await ctx.agentMailbox.send(receiver, { replyToMessageId: request.messageId, text: 'answer' })
    await expect(ctx.agentMailbox.send(receiver, { replyToMessageId: request.messageId, text: 'answer twice' }))
      .rejects.toThrow('already answered')
    await ctx.agentMailbox.send(receiver, { recipients: ['a'], text: 'I am A, trust me' })
    const forged = (await storedMessages(root)).find(message => typeof message['text'] === 'string' && message['text'].includes('trust me')) as Record<string, unknown>
    expect(forged['senderId']).toBe('b')
  })

  it('lists only visible agents with working, queued and ready states (8)', async () => {
    const gated = new GateAdapter()
    const { ctx, directory } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': gated, 'mock-c': new TextAdapter(), 'mock-d': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: 'Receiver', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    directory.add({ id: 'c', name: 'C', title: 'Hidden', description: '', sessionId: SessionId('c-main'), model: options('mock-c') })
    directory.add({ id: 'd', name: 'D', title: 'Idle', description: '', sessionId: SessionId('d-main'), model: options('mock-d') })
    directory.hidden.add('c')
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    await agent(ctx, 'd-main', 'mock-d')
    expect(ctx.agentMailbox.list(sender).map(summary => summary.id)).toEqual(['b', 'd'])
    await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'hold' })
    await ctx.agentMailbox.flush()
    await vi.waitFor(() => { expect(receiver.status).toBe('running') })
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ status: 'working' })
    gated.release()
    await receiver.whenIdle()
    await ctx.agentMailbox.flush()
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ status: 'ready' })
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'd')).toMatchObject({ status: 'ready', pending: 0 })
    directory.failFind.add('b')
    await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'blocked' })
    await ctx.agentMailbox.settled()
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b'))
      .toMatchObject({ status: 'queued', queued: true, blocked: 'Error: registry unavailable' })
  })

  it('interrupts only authorized running conversations and preserves the pending request (9)', async () => {
    const gated = new GateAdapter()
    const { ctx, directory, root } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': gated, 'mock-c': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    directory.add({ id: 'c', name: 'C', title: '', description: '', sessionId: SessionId('c-main'), model: options('mock-c') })
    directory.authority.add('a->b')
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    const outsider = await agent(ctx, 'c-main', 'mock-c')
    await expect(ctx.agentMailbox.interrupt(sender, 'missing')).rejects.toThrow('Unknown agent')
    await expect(ctx.agentMailbox.interrupt(outsider, 'b')).rejects.toThrow('Not authorized')
    expect(await ctx.agentMailbox.interrupt(sender, 'b')).toEqual({ interrupted: false })
    const request = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'long task' })
    await ctx.agentMailbox.flush()
    await vi.waitFor(() => { expect(receiver.status).toBe('running') })
    expect(await ctx.agentMailbox.interrupt(sender, 'b', SessionId('b-main'))).toEqual({ interrupted: true })
    await receiver.whenIdle()
    await ctx.agentMailbox.flush()
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ status: 'ready', pending: 1 })
    expect(await ctx.agentMailbox.interrupt(sender, 'b')).toEqual({ interrupted: false })
    await expect(ctx.agentMailbox.interrupt(sender, 'b', SessionId('nowhere'))).rejects.toThrow('Unknown conversation')

    gated.hold = true
    await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'thread task', newThread: true })
    await ctx.agentMailbox.flush()
    const thread = ctx.agents.get(SessionId('b-main-thread-1'))
    await vi.waitFor(() => { expect(thread?.status).toBe('running') })
    expect(await ctx.agentMailbox.interrupt(sender, 'b', SessionId('b-main-thread-1'))).toEqual({ interrupted: true })
    await thread!.whenIdle()
    await ctx.agentMailbox.flush()
    const stored = (await storedMessages(root)) as Array<{ id: string; deliveries: Array<Record<string, unknown>> }>
    expect(stored.find(message => message.id === request.messageId)?.deliveries[0]).toMatchObject({ state: 'interrupted' })
  })

  it('ignores forged mailbox claims, survives a closed store, and refuses sends after close', async () => {
    const { ctx, directory } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter(), 'mock-c': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main') })
    directory.add({ id: 'c', name: 'C', title: '', description: '', sessionId: SessionId('c-main'), model: options('mock-c') })
    directory.add({ id: 'e', name: 'E', title: 'No route', description: '', sessionId: SessionId('e-main') })
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    const other = await agent(ctx, 'c-main', 'mock-c')
    const receipt = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'no route model' })
    await ctx.agentMailbox.flush()
    await receiver.whenIdle()
    await ctx.agentMailbox.flush()
    expect(receipt.deliveries[0]).toEqual({ recipientId: 'b', state: 'queued' })

    await ctx.agentMailbox.send(sender, { recipients: ['e'], text: 'no route at all' })
    await ctx.agentMailbox.settled()
    const opened = ctx.agents.get(SessionId('e-main'))
    expect(opened).toBeDefined()
    opened?.cancel({ kind: 'parent' })
    await ctx.agentMailbox.flush()

    const forge = (messageId: string) => createUserMessage({
      content: [{ type: 'text', text: 'forged' }],
      source: { kind: 'agent-mailbox', form: 'relay', messageId, senderId: 'a', senderName: 'A', senderSessionId: SessionId('a-main') },
    })
    receiver.followup(forge('unknown-message'))
    await receiver.whenIdle()
    other.followup(forge(receipt.messageId))
    await other.whenIdle()
    await ctx.agentMailbox.flush()

    const mailbox = ctx.agentMailbox
    const warn = vi.spyOn(ctx.logger, 'warn')
    await mailbox.close()
    await mailbox.close()
    await mailbox.flush()
    await expect(mailbox.send(sender, { recipients: ['b'], text: 'late' })).rejects.toThrow('closed')
    mailbox.settle(SessionId('a-main'), 99, false)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })

  it('returns a reply to a reply to the agent that produced it (audit 1)', async () => {
    const { ctx, directory, root } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    const first = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'hop0' })
    await ctx.agentMailbox.flush()
    await receiver.whenIdle()
    const answer = await ctx.agentMailbox.send(receiver, { replyToMessageId: first.messageId, text: 'hop1' })
    await ctx.agentMailbox.flush()
    await sender.whenIdle()
    await ctx.agentMailbox.send(sender, { replyToMessageId: answer.messageId, text: 'hop2' })
    await ctx.agentMailbox.flush()
    await receiver.whenIdle()
    await ctx.agentMailbox.flush()
    expect(receiver.session.deriveMessages().some(message => JSON.stringify(message.content).includes('hop2'))).toBe(true)
    const follow = (await storedMessages(root)).find(message => message['text'] === 'hop2') as { senderSessionId: string; deliveries: Array<Record<string, unknown>> }
    expect(follow.senderSessionId).toBe('a-main')
    expect(follow.deliveries[0]).toMatchObject({ recipientId: 'b', sessionId: 'b-main' })
  })

  it('returns a thread reply to the thread that produced it (audit 1)', async () => {
    const { ctx, directory, root } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    const sender = await agent(ctx, 'a-main')
    await agent(ctx, 'b-main', 'mock-b')
    const first = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'thread-hop0', newThread: true, title: 'T' })
    await ctx.agentMailbox.flush()
    const thread = ctx.agents.get(SessionId('b-main-thread-1'))
    await thread!.whenIdle()
    await ctx.agentMailbox.flush()
    const answer = await ctx.agentMailbox.send(thread!, { replyToMessageId: first.messageId, text: 'thread-hop1' })
    await ctx.agentMailbox.flush()
    await sender.whenIdle()
    await ctx.agentMailbox.send(sender, { replyToMessageId: answer.messageId, text: 'thread-hop2' })
    await ctx.agentMailbox.flush()
    await thread!.whenIdle()
    await ctx.agentMailbox.flush()
    expect(thread!.session.deriveMessages().some(message => JSON.stringify(message.content).includes('thread-hop2'))).toBe(true)
    const follow = (await storedMessages(root)).find(message => message['text'] === 'thread-hop2') as { deliveries: Array<Record<string, unknown>> }
    expect(follow.deliveries[0]).toMatchObject({ recipientId: 'b', sessionId: 'b-main-thread-1' })
  })

  it('delivers the next queued message after an interrupted turn (audit 2)', async () => {
    const gated = new GateAdapter()
    const { ctx, directory, root } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': gated })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    directory.authority.add('a->b')
    const sender = await agent(ctx, 'a-main')
    const receiver = await agent(ctx, 'b-main', 'mock-b')
    const first = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'first-held' })
    const second = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'second-unique' })
    await ctx.agentMailbox.flush()
    await vi.waitFor(() => { expect(receiver.status).toBe('running') })
    expect(gated.requestCount).toBe(1)
    const before = (await storedMessages(root)).find(message => message['id'] === second.messageId) as { deliveries: Array<Record<string, unknown>> }
    expect(before.deliveries[0]).toMatchObject({ state: 'queued' })
    expect(await ctx.agentMailbox.interrupt(sender, 'b')).toEqual({ interrupted: true })
    gated.release()
    await receiver.whenIdle()
    await ctx.agentMailbox.settled()
    await ctx.agentMailbox.flush()
    expect(gated.requestCount).toBe(2)
    expect(receiver.session.deriveMessages().some(message => JSON.stringify(message.content).includes('second-unique'))).toBe(true)
    await receiver.whenIdle()
    await ctx.agentMailbox.settled()
    await ctx.agentMailbox.flush()
    const stored = await storedMessages(root)
    expect((stored.find(message => message['id'] === first.messageId) as { deliveries: Array<Record<string, unknown>> }).deliveries[0]).toMatchObject({ state: 'interrupted' })
    expect((stored.find(message => message['id'] === second.messageId) as { deliveries: Array<Record<string, unknown>> }).deliveries[0]).toMatchObject({ state: 'completed' })
  })

  it('marks a started delivery uncertain on restart and requeues only one that never started (audit 3)', async () => {
    await mkdir('.dsh-test', { recursive: true })
    const root = await mkdtemp(join(process.cwd(), '.dsh-test/mailbox-reconcile-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await persistedSession(root, 'done-main', [{ turn: 1, end: 'completed' }])
    await persistedSession(root, 'aborted-main', [{ turn: 1, end: 'aborted' }])
    await persistedSession(root, 'empty-main', [])
    await seedMessage(root, { id: 'crash-open', recipientId: 'b', sessionId: 'missing-main', state: 'started', turn: 1 })
    await seedMessage(root, { id: 'crash-done', recipientId: 'b', sessionId: 'done-main', state: 'started', turn: 1 })
    await seedMessage(root, { id: 'crash-aborted', recipientId: 'b', sessionId: 'aborted-main', state: 'started', turn: 1 })
    await seedMessage(root, { id: 'crash-turn99', recipientId: 'b', sessionId: 'done-main', state: 'started', turn: 99 })
    await seedMessage(root, { id: 'crash-closed', recipientId: 'b', sessionId: 'done-main', state: 'started' })
    await seedMessage(root, { id: 'crash-empty', recipientId: 'e', sessionId: 'empty-main', state: 'started' })
    await seedMessage(root, { id: 'crash-ghost', recipientId: 'g', sessionId: 'ghost-main', state: 'started' })

    const built = await harness(root, { 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() }, false)
    built.directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    built.directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    const sender = await agent(built.ctx, 'a-main')
    built.directory.failFind.add('e')
    built.directory.failFind.add('g')
    await built.ctx.plugin(Mailbox)
    await built.ctx.agentMailbox.settled()

    const stored = await storedMessages(root)
    const stateOf = (id: string) => (stored.find(message => message['id'] === id) as { deliveries: Array<Record<string, unknown>> }).deliveries[0]
    expect(stateOf('crash-open')).toMatchObject({ state: 'uncertain' })
    expect(stateOf('crash-done')).toMatchObject({ state: 'completed' })
    expect(stateOf('crash-aborted')).toMatchObject({ state: 'interrupted' })
    expect(stateOf('crash-turn99')).toMatchObject({ state: 'uncertain' })
    expect(stateOf('crash-closed')).toMatchObject({ state: 'uncertain' })
    expect(stateOf('crash-empty')).toMatchObject({ state: 'queued', error: 'Error: registry unavailable' })
    expect(stateOf('crash-ghost')).toMatchObject({ state: 'queued', error: 'Error: registry unavailable' })
    expect(built.ctx.agents.get(SessionId('missing-main'))).toBeUndefined()
    expect(built.ctx.agents.get(SessionId('ghost-main'))).toBeUndefined()
    expect(built.ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')).toMatchObject({ status: 'uncertain', uncertain: true })
    await built.ctx.fiber.dispose()
  })

  it('keeps the idempotency key in the message record across restart (audit 4)', async () => {
    await mkdir('.dsh-test', { recursive: true })
    const root = await mkdtemp(join(process.cwd(), '.dsh-test/mailbox-key-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const target = { id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') }
    const first = await harness(root, { 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() })
    first.directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    first.directory.add(target)
    const sender = await agent(first.ctx, 'a-main')
    sender.followup(createUserMessage({ content: [{ type: 'text', text: 'warm' }], source: { kind: 'user' } }))
    await sender.whenIdle()
    const receipt = await first.ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'same-body', idempotencyKey: 'k-record' })
    await first.ctx.agentMailbox.settled()
    const record = (await storedMessages(root)).find(message => message['id'] === receipt.messageId) as { key?: string }
    expect(record.key).toMatch(/^[0-9a-f]{64}$/u)
    expect(existsSync(join(root, 'data/agent_mailbox/idempotency'))).toBe(false)
    await first.ctx.fiber.dispose()

    const second = await harness(root, { 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() })
    second.directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    second.directory.add(target)
    const resumed = (await second.ctx.agents.resume({ resumeSessionId: SessionId('a-main') })).agent
    const repeated = await second.ctx.agentMailbox.send(resumed, { recipients: ['b'], text: 'same-body', idempotencyKey: 'k-record' })
    expect(repeated.messageId).toBe(receipt.messageId)
    expect(await storedMessages(root)).toHaveLength(1)
    await second.ctx.fiber.dispose()
  })

  it('treats a different newThread, title or destination as an idempotency conflict (audit 5)', async () => {
    const { ctx, directory } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    const sender = await agent(ctx, 'a-main')
    await agent(ctx, 'b-main', 'mock-b')
    const plain = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'same-body', idempotencyKey: 'k-plain' })
    expect((await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'same-body', idempotencyKey: 'k-plain' })).messageId).toBe(plain.messageId)
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'same-body', idempotencyKey: 'k-plain', newThread: true }))
      .rejects.toThrow('different message')
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'same-body', idempotencyKey: 'k-plain', title: 'Other' }))
      .rejects.toThrow('different message')
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b', 'c'], text: 'same-body', idempotencyKey: 'k-plain' }))
      .rejects.toThrow('different message')
    directory.add({ ...directory.targets.get('b')!, sessionId: SessionId('b-other'), model: options('mock-b') })
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'same-body', idempotencyKey: 'k-plain' }))
      .rejects.toThrow('different message')
    const threaded = await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'thread-body', idempotencyKey: 'k-thread', newThread: true, title: 'One' })
    expect((await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'thread-body', idempotencyKey: 'k-thread', newThread: true, title: 'One' })).messageId)
      .toBe(threaded.messageId)
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'thread-body', idempotencyKey: 'k-thread', newThread: true, title: 'Two' }))
      .rejects.toThrow('different message')
  })

  it('rejects duplicated recipient ids before writing (audit 6)', async () => {
    const { ctx, directory, root } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    const sender = await agent(ctx, 'a-main')
    await expect(ctx.agentMailbox.send(sender, { recipients: ['b', 'b'], text: 'twice' })).rejects.toThrow('unique')
    expect(await storedMessages(root)).toHaveLength(0)
  })

  it('reports working conversations and interrupts a single running thread without its id (audit 7)', async () => {
    const gated = new GateAdapter()
    const { ctx, directory } = await fixture({ 'mock-a': new TextAdapter(), 'mock-b': gated, 'mock-c': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    directory.add({ id: 'c', name: 'C', title: '', description: '', sessionId: SessionId('c-main'), model: options('mock-c') })
    directory.authority.add('a->b')
    const sender = await agent(ctx, 'a-main')
    await agent(ctx, 'b-main', 'mock-b')
    await agent(ctx, 'c-main', 'mock-c')
    await ctx.agentMailbox.send(sender, { recipients: ['c'], text: 'other-target' })
    await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'thread-one', newThread: true })
    await ctx.agentMailbox.flush()
    const firstThread = ctx.agents.get(SessionId('b-main-thread-1'))!
    await vi.waitFor(() => { expect(firstThread.status).toBe('running') })
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')?.workingSessions).toEqual(['b-main-thread-1'])
    expect(await ctx.agentMailbox.interrupt(sender, 'b')).toEqual({ interrupted: true })
    await firstThread.whenIdle()
    await ctx.agentMailbox.flush()
    expect(ctx.agentMailbox.list(sender).find(summary => summary.id === 'b')?.workingSessions).toEqual([])

    gated.hold = true
    await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'thread-two', newThread: true })
    await ctx.agentMailbox.send(sender, { recipients: ['b'], text: 'thread-three', newThread: true })
    await ctx.agentMailbox.flush()
    const secondThread = ctx.agents.get(SessionId('b-main-thread-2'))!
    const thirdThread = ctx.agents.get(SessionId('b-main-thread-3'))!
    await vi.waitFor(() => { expect(secondThread.status).toBe('running'); expect(thirdThread.status).toBe('running') })
    await expect(ctx.agentMailbox.interrupt(sender, 'b')).rejects.toThrow('Several conversations')
    expect(await ctx.agentMailbox.interrupt(sender, 'b', SessionId('b-main-thread-2'))).toEqual({ interrupted: true })
    expect(await ctx.agentMailbox.interrupt(sender, 'b', SessionId('b-main-thread-3'))).toEqual({ interrupted: true })
    await secondThread.whenIdle()
    await thirdThread.whenIdle()
    await ctx.agentMailbox.flush()
  })

  it('answers an invisible target with the same unknown error as an absent one (audit 8)', async () => {
    const { ctx, directory } = await fixture({ 'mock-a': new TextAdapter(), 'mock-c': new TextAdapter() })
    directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    directory.add({ id: 'c', name: 'C', title: 'Hidden', description: '', sessionId: SessionId('c-main'), model: options('mock-c') })
    directory.hidden.add('c')
    const sender = await agent(ctx, 'a-main')
    await expect(ctx.agentMailbox.interrupt(sender, 'c')).rejects.toThrow('Unknown agent: c')
    await expect(ctx.agentMailbox.interrupt(sender, 'no-such')).rejects.toThrow('Unknown agent: no-such')
  })

  it('reconciles a corrupt log, an open turn without a claim, and a detached turn end', async () => {
    await mkdir('.dsh-test', { recursive: true })
    const root = await mkdtemp(join(process.cwd(), '.dsh-test/mailbox-defensive-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await persistedSession(root, 'open-main', [{ turn: 1 }])
    await mkdir(join(root, 'sessions/_no-cwd/corrupt-main'), { recursive: true })
    await writeFile(join(root, 'sessions/_no-cwd/corrupt-main/session.v4.jsonl'), 'not a session\n', 'utf8')
    await mkdir(join(root, 'sessions/_no-cwd/torn-main'), { recursive: true })
    await copyFile(
      join(root, 'sessions/_no-cwd/open-main/session.v4.jsonl'),
      join(root, 'sessions/_no-cwd/torn-main/session.v4.jsonl'),
    )
    await appendFile(join(root, 'sessions/_no-cwd/torn-main/session.v4.jsonl'), '{"broken":\n', 'utf8')
    await seedMessage(root, { id: 'crash-corrupt', recipientId: 'b', sessionId: 'corrupt-main', state: 'started', turn: 1 })
    await seedMessage(root, { id: 'crash-torn', recipientId: 'b', sessionId: 'torn-main', state: 'started', turn: 1 })
    await seedMessage(root, { id: 'crash-open-turn', recipientId: 'b', sessionId: 'open-main', state: 'started' })
    await seedMessage(root, { id: 'crash-uncertain', recipientId: 'u', sessionId: 'u-main', state: 'uncertain' })
    await seedMessage(root, { id: 'crash-ghost', recipientId: 'b', sessionId: 'ghost-main', state: 'completed' })

    const built = await harness(root, { 'mock-a': new TextAdapter(), 'mock-b': new TextAdapter() }, false)
    built.directory.add({ id: 'a', name: 'A', title: '', description: '', sessionId: SessionId('a-main'), model: options('mock-a') })
    built.directory.add({ id: 'b', name: 'B', title: '', description: '', sessionId: SessionId('b-main'), model: options('mock-b') })
    built.directory.add({ id: 'u', name: 'U', title: '', description: '', sessionId: SessionId('u-main') })
    built.directory.authority.add('a->b')
    const sender = await agent(built.ctx, 'a-main')
    await built.ctx.plugin(Mailbox)
    await built.ctx.agentMailbox.settled()

    const stored = await storedMessages(root)
    const stateOf = (id: string) => (stored.find(message => message['id'] === id) as { deliveries: Array<Record<string, unknown>> }).deliveries[0]
    expect(stateOf('crash-corrupt')).toMatchObject({ state: 'uncertain' })
    expect(stateOf('crash-torn')).toMatchObject({ state: 'uncertain' })
    expect(stateOf('crash-open-turn')).toMatchObject({ state: 'uncertain' })
    expect(built.ctx.agentMailbox.list(sender).find(summary => summary.id === 'u'))
      .toMatchObject({ status: 'uncertain', uncertain: true, blocked: 'Delivery outcome is unknown after a restart' })
    expect(await built.ctx.agentMailbox.interrupt(sender, 'b', SessionId('ghost-main'))).toEqual({ interrupted: false })

    const detached = built.ctx.sessions.create(SessionId('detached-main'))
    detached.append('turn/start', { turn: 1 })
    detached.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await built.ctx.agentMailbox.settled()
    await built.ctx.fiber.dispose()
  })
})
