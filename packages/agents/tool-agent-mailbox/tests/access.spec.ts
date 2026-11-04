import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentMailbox } from '@deepseek-ai/dsh-agent-mailbox'
import type { PersistentAgentId } from '@deepseek-ai/dsh-agent-registry'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { harness as registryHarness, inherited, live } from '../../agent-registry/tests/harness.ts'
import * as ToolAgentMailbox from '../src/index.ts'

const A: Principal = { kind: 'account', ownerId: 'a' }
const B: Principal = { kind: 'account', ownerId: 'b' }
const signal = new AbortController().signal

function as(ctx: Context, principal: Principal): Context {
  const invocation = { peer: { principal }, signal } as unknown as RemoteInvocation
  return ctx.extend({ invocation })
}

function grantsFake() {
  const stored = new Map<string, number>()
  return {
    stored,
    async grant(ownerId: string, granteeId: string) { stored.set(`${ownerId}>${granteeId}`, stored.size) },
    async revoke(ownerId: string, granteeId: string) { stored.delete(`${ownerId}>${granteeId}`) },
    allows: (ownerId: string, granteeId: string) => stored.has(`${ownerId}>${granteeId}`),
    list: (ownerId: string) => [...stored.keys()].filter(key => key.startsWith(`${ownerId}>`)).map(key => key.slice(ownerId.length + 1)),
  }
}

async function fixture(withGrants = true) {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/access-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const f = await registryHarness(root)
  onTestFinished(() => f.ctx.fiber.dispose())
  const ctx = f.ctx
  const grants = grantsFake()
  if (withGrants) ctx.provide('accountGrants', grants)
  ctx.provide('agentMailbox', {} as AgentMailbox)
  await ctx.plugin(ToolAgentMailbox)
  const a1 = await as(ctx, A).persistentAgents.create({ name: 'A1' }, inherited)
  const a2 = await as(ctx, A).persistentAgents.create({ name: 'A2' }, inherited)
  const b1 = await as(ctx, B).persistentAgents.create({ name: 'B1' }, inherited)
  const sectionA = await as(ctx, A).persistentAgents.createSection('Work')
  const sectionB = await as(ctx, B).persistentAgents.createSection('Home')
  const agentA = await live(ctx, 'a-main', a1.id)
  const agentB = await live(ctx, 'b-main', b1.id)
  const run = (name: string, args: Record<string, unknown>, agent?: Agent) => executeModelToolFixture(ctx, {
    callId: ToolCallId(`call-${name}`), name, arguments: args, signal, ...(agent === undefined ? {} : { agent }),
  })
  const value = async (name: string, args: Record<string, unknown>, agent: Agent) => {
    const result = await run(name, args, agent)
    if (result.isError) throw result.error
    return result.value
  }
  const failure = async (name: string, args: Record<string, unknown>, agent: Agent) => {
    const result = await run(name, args, agent)
    if (!result.isError) throw new Error('expected a failure')
    return result.error.message
  }
  return { ctx, grants, a1, a2, b1, sectionA, sectionB, agentA, agentB, run, value, failure }
}

describe('account grant tools', () => {
  it('lets only the caller account grant and list, one way and idempotently', async () => {
    const f = await fixture()
    expect(await f.value('agent_grant_access', { account_id: ' b ' }, f.agentA)).toEqual({ account_id: 'b' })
    await f.value('agent_grant_access', { account_id: 'b' }, f.agentA)
    expect(await f.value('agent_list_grants', {}, f.agentA)).toEqual([{ account_id: 'b' }])
    expect(await f.value('agent_list_grants', {}, f.agentB)).toEqual([])
    expect(f.grants.allows('a', 'b')).toBe(true)
    expect(f.grants.allows('b', 'a')).toBe(false)
    const rendered = await f.run('agent_grant_access', { account_id: 'c' }, f.agentA)
    expect(rendered.isError ? undefined : rendered.content[0]).toEqual({ type: 'text', text: 'access granted to c' })
  })

  it('rejects empty and own-account grants and callers without a persistent agent', async () => {
    const f = await fixture()
    expect(await f.failure('agent_grant_access', { account_id: '  ' }, f.agentA)).toContain('must not be empty')
    expect(await f.failure('agent_grant_access', { account_id: 'a' }, f.agentA)).toContain('already reaches')
    const noAgent = await f.run('agent_grant_access', { account_id: 'b' })
    expect(noAgent.isError ? noAgent.error.message : '').toContain('live persistent agent')
    expect(f.grants.stored.size).toBe(0)
  })

  it('states the real scope of a revoke: undelivered mail is refused, a running turn keeps what it got (grants audit 2)', async () => {
    const f = await fixture()
    const text = f.ctx.tools.get('agent_revoke_access')!.description
    expect(text).toContain('not been delivered yet are cut at once and recorded as refused')
    expect(text).toContain('a turn that already received a message keeps it')
    expect(text).not.toContain('takes effect at once')
  })

  it('revokes at once and gives other accounts the same error as a missing grant', async () => {
    const f = await fixture()
    await f.value('agent_grant_access', { account_id: 'b' }, f.agentA)
    expect(f.grants.allows('a', 'b')).toBe(true)
    const foreign = await f.failure('agent_revoke_access', { account_id: 'a' }, f.agentB)
    const missing = await f.failure('agent_revoke_access', { account_id: 'nobody' }, f.agentB)
    expect(foreign).toBe('Unknown grant: a')
    expect(missing).toBe('Unknown grant: nobody')
    expect(f.grants.allows('a', 'b')).toBe(true)
    const rendered = await f.run('agent_revoke_access', { account_id: 'b' }, f.agentA)
    expect(rendered.isError ? undefined : rendered.content[0]).toEqual({ type: 'text', text: 'access revoked from b' })
    expect(f.grants.allows('a', 'b')).toBe(false)
    expect(await f.value('agent_list_grants', {}, f.agentA)).toEqual([])
    expect(await f.failure('agent_revoke_access', { account_id: 'b' }, f.agentA)).toBe('Unknown grant: b')
  })

  it('reports that grants are unavailable when the owner policy is not mounted', async () => {
    const f = await fixture(false)
    expect(await f.failure('agent_grant_access', { account_id: 'b' }, f.agentA)).toBe('Account grants are not enabled')
    expect(await f.failure('agent_list_grants', {}, f.agentA)).toBe('Account grants are not enabled')
  })
})

describe('section tools', () => {
  it('lists only the caller sections with their members', async () => {
    const f = await fixture()
    await f.value('agent_move_section', { agent_id: f.a1.id, section_id: f.sectionA.id }, f.agentA)
    expect(await f.value('agent_list_sections', {}, f.agentA)).toEqual([{ id: f.sectionA.id, name: 'Work', agent_ids: [f.a1.id] }])
    expect(await f.value('agent_list_sections', {}, f.agentB)).toEqual([{ id: f.sectionB.id, name: 'Home', agent_ids: [] }])
  })

  it('moves and ungroups while keeping the agent identity', async () => {
    const f = await fixture()
    const moved = await f.run('agent_move_section', { agent_id: f.a1.id, section_id: f.sectionA.id }, f.agentA)
    expect(moved.isError ? undefined : moved.value).toEqual({ agent_id: f.a1.id, section_id: f.sectionA.id })
    expect(moved.isError ? undefined : moved.content[0]).toEqual({ type: 'text', text: `${f.a1.id} moved to ${f.sectionA.id}` })
    expect(f.ctx.persistentAgents.get(f.a1.id)).toMatchObject({ id: f.a1.id, name: 'A1', sectionId: f.sectionA.id })
    const freed = await f.run('agent_move_section', { agent_id: f.a1.id }, f.agentA)
    expect(freed.isError ? undefined : freed.value).toEqual({ agent_id: f.a1.id })
    expect(freed.isError ? undefined : freed.content[0]).toEqual({ type: 'text', text: `${f.a1.id} has no section` })
    expect(f.ctx.persistentAgents.get(f.a1.id).sectionId).toBeUndefined()
  })

  it('answers a foreign agent or section exactly like a missing one', async () => {
    const f = await fixture()
    const foreignAgent = await f.failure('agent_move_section', { agent_id: f.b1.id }, f.agentA)
    const missingAgent = await f.failure('agent_move_section', { agent_id: 'missing' }, f.agentA)
    expect(foreignAgent).toBe(`Unknown persistent agent: ${f.b1.id}`)
    expect(missingAgent).toBe('Unknown persistent agent: missing')
    const foreignSection = await f.failure('agent_move_section', { agent_id: f.a1.id, section_id: f.sectionB.id }, f.agentA)
    const missingSection = await f.failure('agent_move_section', { agent_id: f.a1.id, section_id: 'missing' }, f.agentA)
    expect(foreignSection).toBe(`Unknown section: ${f.sectionB.id}`)
    expect(missingSection).toBe('Unknown section: missing')
    expect(f.ctx.persistentAgents.get(f.a1.id).sectionId).toBeUndefined()
    expect(f.ctx.persistentAgents.get(f.b1.id).sectionId).toBeUndefined()
  })

  it('treats records without an owner as the single-account owner', async () => {
    const profile = { id: 'legacy' as PersistentAgentId, name: 'Legacy', sectionId: 's-1', revision: 1 }
    const registry = {
      of: () => profile.id,
      get: () => profile,
      list: () => [profile],
      listSections: () => [{ id: 's-1', name: 'Old', revision: 1 }],
      assignSection: async () => profile,
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.provide('persistentAgents', registry as unknown as Context['persistentAgents'])
    ctx.provide('agentMailbox', {} as AgentMailbox)
    await ctx.plugin(ToolAgentMailbox)
    onTestFinished(() => ctx.fiber.dispose())
    const agent = { id: SessionId('legacy-main') } as unknown as Agent
    const call = (name: string, args: Record<string, unknown>) => executeModelToolFixture(ctx, {
      callId: ToolCallId(`legacy-${name}`), name, arguments: args, signal, agent,
    })
    const sections = await call('agent_list_sections', {})
    expect(sections.isError ? undefined : sections.value).toEqual([{ id: 's-1', name: 'Old', agent_ids: ['legacy'] }])
    const moved = await call('agent_move_section', { agent_id: 'legacy', section_id: 's-1' })
    expect(moved.isError ? undefined : moved.value).toEqual({ agent_id: 'legacy', section_id: 's-1' })
    const grant = await call('agent_grant_access', { account_id: 'owner' })
    expect(grant.isError ? grant.error.message : '').toContain('already reaches')
  })
})
