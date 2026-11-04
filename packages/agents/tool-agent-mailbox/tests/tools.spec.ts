import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentMailbox, SendInput } from '@deepseek-ai/dsh-agent-mailbox'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolAgentMailbox from '../src/index.ts'

interface Call {
  readonly method: 'send' | 'list' | 'interrupt'
  readonly args: readonly unknown[]
}

async function harness(calls: Call[], result: { send?: unknown; list?: unknown; interrupt?: unknown } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const mailbox = {
    async send(...args: unknown[]) {
      calls.push({ method: 'send', args })
      return result.send ?? { messageId: 'm-1', deliveries: [{ recipientId: 'b', state: 'queued' }] }
    },
    list(...args: unknown[]) {
      calls.push({ method: 'list', args })
      return result.list ?? []
    },
    async interrupt(...args: unknown[]) {
      calls.push({ method: 'interrupt', args })
      return args[1] === 'b' ? { interrupted: true } : { interrupted: false }
    },
  } as unknown as AgentMailbox
  ctx.provide('agentMailbox', mailbox)
  ctx.provide('persistentAgents', {} as unknown as Context['persistentAgents'])
  await ctx.plugin(ToolAgentMailbox)
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

const caller = { id: SessionId('a-main'), session: { id: SessionId('a-main') } } as unknown as Agent
const signal = new AbortController().signal

async function run(ctx: Context, name: string, args: Record<string, unknown>, agent: Agent | null = caller) {
  return executeModelToolFixture(ctx, {
    callId: ToolCallId(`call-${name}`),
    name,
    arguments: args,
    signal,
    ...(agent === null ? {} : { agent }),
  })
}

describe('agent mailbox tools', () => {
  it('maps every send option and renders one receipt per recipient', async () => {
    const calls: Call[] = []
    const ctx = await harness(calls, {
      send: {
        messageId: 'm-9',
        deliveries: [{ recipientId: 'b', state: 'started' }, { recipientId: 'c', state: 'queued', error: 'blocked' }],
      },
    })
    const full = await run(ctx, 'agent_send_message', {
      recipients: ['b', 'c'],
      message: 'hello',
      expects_reply: true,
      reply_to_message_id: 'm-1',
      new_thread: true,
      title: 'Side work',
      idempotency_key: 'key-1',
    })
    expect(full.isError).toBe(false)
    expect(calls[0]?.args[1]).toEqual({
      recipients: ['b', 'c'],
      text: 'hello',
      expectsReply: true,
      replyToMessageId: 'm-1',
      newThread: true,
      title: 'Side work',
      idempotencyKey: 'key-1',
    } satisfies SendInput)
    expect(full.isError ? undefined : full.value).toEqual({
      message_id: 'm-9',
      deliveries: [{ agent_id: 'b', state: 'started' }, { agent_id: 'c', state: 'queued', error: 'blocked' }],
    })
    const minimal = await run(ctx, 'agent_send_message', { message: 'plain' })
    expect(minimal.isError).toBe(false)
    expect(calls[1]?.args[1]).toEqual({ text: 'plain' })
    expect(minimal.isError ? undefined : minimal.content[0]).toEqual({ type: 'text', text: 'Message m-9 accepted for b (started), c (queued)' })
  })

  it('lists summaries with and without a blocking reason', async () => {
    const calls: Call[] = []
    const summary = {
      id: 'b', name: 'B', title: 'Receiver', description: '', status: 'working', queued: true, pending: 2,
      workingSessions: [SessionId('b-main')], uncertain: true, blocked: 'quota',
    }
    const plain = {
      id: 'c', name: 'C', title: 'Idle', description: '', status: 'ready', queued: false, pending: 0,
      workingSessions: [], uncertain: false,
    }
    const ctx = await harness(calls, { list: [summary, plain] })
    const result = await run(ctx, 'agent_list', {})
    expect(result.isError).toBe(false)
    expect(result.isError ? undefined : result.value).toEqual([
      {
        id: 'b', name: 'B', title: 'Receiver', description: '', status: 'working', queued: true, pending: 2,
        working_sessions: ['b-main'], uncertain: true, blocked: 'quota',
      },
      {
        id: 'c', name: 'C', title: 'Idle', description: '', status: 'ready', queued: false, pending: 0,
        working_sessions: [], uncertain: false,
      },
    ])
    expect(calls[0]?.method).toBe('list')
  })

  it('interrupts with and without a conversation id', async () => {
    const calls: Call[] = []
    const ctx = await harness(calls)
    const result = await run(ctx, 'agent_interrupt', { agent_id: 'b', session_id: 'b-main' })
    expect(result.isError).toBe(false)
    expect(calls[0]?.args).toEqual([caller, 'b', SessionId('b-main')])
    expect(result.isError ? undefined : result.content[0]).toEqual({ type: 'text', text: 'interruption requested' })
    const plain = await run(ctx, 'agent_interrupt', { agent_id: 'c' })
    expect(plain.isError).toBe(false)
    expect(calls[1]?.args).toEqual([caller, 'c', undefined])
    expect(plain.isError ? undefined : plain.content[0]).toEqual({ type: 'text', text: 'target was not running' })
  })

  it('requires a live calling agent', async () => {
    const calls: Call[] = []
    const ctx = await harness(calls)
    const result = await run(ctx, 'agent_list', {}, null)
    expect(result.isError).toBe(true)
    expect(result.isError ? result.error.message : '').toContain('live persistent agent')
  })
})
