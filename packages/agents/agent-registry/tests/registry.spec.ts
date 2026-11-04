import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, it, expect, onTestFinished } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PersistentAgentId } from '../src/index.ts'
import { harness, live, inherited, Adapter } from './harness.ts'

async function fixture() {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/registry-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const f = await harness(root)
  onTestFinished(() => f.ctx.fiber.dispose())
  return { ...f, root }
}

describe('durable persistent profiles', () => {
  it('preserves identity, first task, history and pending references across edits and reopen (1,2,5)', async () => {
    const { ctx, root, registryFiber } = await fixture()
    const profile = await ctx.persistentAgents.create({ name: 'One', title: 'Old', instructions: 'Literal {{keep}}', firstTask: 'First', ownerId: 'owner', reserves: [inherited], automaticFallback: true }, inherited)
    const agent = await live(ctx, 'conversation', profile.id)
    const secondSession = await live(ctx, 'second-conversation', profile.id)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const history = agent.session.snapshotEvents()
    const routine = { agentId: profile.id, pending: true }
    const message = { recipientId: profile.id, pending: true }
    const changed = await ctx.persistentAgents.update(profile.id, 1, { title: 'New' })
    expect(changed).toEqual({ ...profile, title: 'New', revision: 2, updatedAt: changed.updatedAt })
    const renamed = await ctx.persistentAgents.update(profile.id, 2, { name: 'Renamed', avatarSeed: 'stable' })
    expect(renamed.avatar).toEqual({ kind: 'generated', value: 'stable' })
    expect(routine.agentId).toBe(renamed.id)
    expect(message.recipientId).toBe(renamed.id)
    expect(agent.session.snapshotEvents()).toEqual(history)
    await ctx.sessions.flush(agent.session)
    await registryFiber.dispose()
    await ctx.fiber.dispose()
    const reopened = await harness(root)
    onTestFinished(() => reopened.ctx.fiber.dispose())
    expect(reopened.ctx.persistentAgents.get(profile.id)).toEqual(renamed)
    expect(reopened.ctx.persistentAgents.metadataOf(agent.id)).toEqual({ agentId: profile.id, ownerId: 'owner' })
    expect(reopened.ctx.persistentAgents.metadataOf(secondSession.id)).toEqual({ agentId: profile.id, ownerId: 'owner' })
    expect(reopened.ctx.persistentAgents.list()).toEqual([renamed])
    const resumed = await reopened.ctx.agents.resume({ resumeSessionId: agent.id, agentOptions: inherited })
    expect(resumed.agent.session.snapshotEvents().slice(0, history.length)).toEqual(history)
    expect(resumed.agent.session.snapshotEvents().at(-1)?.type).toBe('session/end-seed')
    expect(await reopened.ctx.persistentAgents.selection(profile.id)).toEqual(inherited)
    expect(agent.model.current()).toEqual(inherited)
    expect(await readFile(join(root, 'data/agents/profiles', `${profile.id}.json`), 'utf8')).toContain('Renamed')
  })

  it('validates models, effort, partial batches and stale profile revisions before writing (3,5)', async () => {
    const { ctx } = await fixture()
    const profile = await ctx.persistentAgents.create({ name: 'One' }, inherited)
    await expect(ctx.persistentAgents.create({ name: 'Bad', model: { provider: 'mock', model: 'missing' } }, inherited)).rejects.toThrow('Unknown model')
    await expect(ctx.persistentAgents.update(profile.id, 1, { model: { ...inherited, reasoningEffort: 'bad' } })).rejects.toThrow('Unsupported reasoning effort')
    expect(ctx.persistentAgents.get(profile.id)).toEqual(profile)
    const result = await ctx.persistentAgents.updateMany([{ id: profile.id, revision: 1, patch: { title: 'New' } }, { id: PersistentAgentId('absent'), revision: 1, patch: { title: 'Bad' } }])
    expect(result[0]).toHaveProperty('profile.title', 'New')
    expect(result[1]).toHaveProperty('error')
    await expect(ctx.persistentAgents.update(profile.id, 1, { name: 'Stale' })).rejects.toThrow('revision conflict')
    await expect(ctx.persistentAgents.create({ name: ' ' }, inherited)).rejects.toThrow()
    await expect(ctx.persistentAgents.bind(SessionId('first'), PersistentAgentId('missing'))).rejects.toThrow('Unknown')
    expect(ctx.persistentAgents.metadataOf(SessionId('absent'))).toBeUndefined()
    const other = await ctx.persistentAgents.create({ name: 'Two' }, inherited)
    await ctx.persistentAgents.bind(SessionId('first'), profile.id)
    await expect(ctx.persistentAgents.bind(SessionId('first'), other.id)).rejects.toThrow('different persistent agent')
    await ctx.persistentAgents.bind(SessionId('first'), profile.id)
    const unbound = await ctx.agents.create({ sessionId: SessionId('unbound') })
    expect(() => ctx.persistentAgents.of(unbound.agent)).toThrow('no persistent agent')
  })

  it('stores supported explicit effort and validates every reserve without switching', async () => {
    const { ctx } = await fixture()
    const adapter = new Adapter([], { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }] })
    ctx.llm.registerAdapter(['effort'], adapter)
    const model = { provider: 'effort', model: 'test', reasoningEffort: 'medium', account: 'account-1' }
    const profile = await ctx.persistentAgents.create({ name: 'Effort', model, reserves: [inherited] }, inherited)
    expect(await ctx.persistentAgents.selection(profile.id)).toEqual({ provider: 'effort', model: 'test', reasoningEffort: 'medium' })
    await expect(ctx.persistentAgents.update(profile.id, 1, { reserves: [{ provider: 'mock', model: 'absent' }] })).rejects.toThrow('Unknown model')
    expect(ctx.persistentAgents.get(profile.id).model).toEqual(model)
    const inheritedProfile = await ctx.persistentAgents.create({ name: 'Inherited effort', model: { account: 'alternate' } }, model)
    expect(inheritedProfile.model).toEqual({ ...model, account: 'alternate' })
    const changed = await ctx.persistentAgents.update(inheritedProfile.id, 1, { model: { account: 'new-account' } })
    expect(changed.model).toEqual({ ...model, account: 'new-account' })
  })

  it('serializes session binding and rejects concurrent stale edits', async () => {
    const { ctx } = await fixture()
    const profile = await ctx.persistentAgents.create({ name: 'Concurrent' }, inherited)
    const edits = await Promise.allSettled([
      ctx.persistentAgents.update(profile.id, 1, { name: 'First' }),
      ctx.persistentAgents.update(profile.id, 1, { title: 'Second' }),
    ])
    expect(edits.filter(edit => edit.status === 'fulfilled')).toHaveLength(1)
    expect(edits.filter(edit => edit.status === 'rejected')).toHaveLength(1)
    const other = await ctx.persistentAgents.create({ name: 'Other' }, inherited)
    const bindings = await Promise.allSettled([ctx.persistentAgents.bind(SessionId('race'), profile.id), ctx.persistentAgents.bind(SessionId('race'), other.id)])
    expect(bindings.map(binding => binding.status)).toEqual(['fulfilled', 'rejected'])
    expect(ctx.persistentAgents.metadataOf(SessionId('race'))?.agentId).toBe(profile.id)
  })

  it('rejects invalid, oversized or ambiguous avatars without losing the old image (4)', async () => {
    const { ctx, root } = await fixture()
    const image = join(root, 'avatar.png')
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toFile(image)
    const original = await ctx.persistentAgents.create({ name: 'Image', avatarPath: image }, inherited)
    expect(original.avatar.value).toMatch(/^data:image\/png;base64,/)
    await expect(ctx.persistentAgents.update(original.id, 1, { avatarPath: image, avatarSeed: 'x' })).rejects.toThrow('Choose')
    await writeFile(image, 'not an image')
    await expect(ctx.persistentAgents.update(original.id, 1, { avatarPath: image })).rejects.toThrow()
    await writeFile(image, Buffer.alloc(512 * 1024 + 1))
    await expect(ctx.persistentAgents.update(original.id, 1, { avatarPath: image })).rejects.toThrow('512 KB')
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).gif().toFile(image)
    await expect(ctx.persistentAgents.update(original.id, 1, { avatarPath: image })).rejects.toThrow('PNG, JPEG or WebP')
    expect(ctx.persistentAgents.get(original.id)).toEqual(original)
  })
})
