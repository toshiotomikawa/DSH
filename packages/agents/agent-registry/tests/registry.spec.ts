import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
  it('reads legacy ownerless profiles as the single-account owner and stamps new session bindings', async () => {
    const { ctx, root, registryFiber } = await fixture()
    const profile = await ctx.persistentAgents.create({ name: 'Legacy' }, inherited)
    await registryFiber.dispose()
    const path = join(root, 'data/agents/profiles', `${profile.id}.json`)
    const legacy = JSON.parse(await readFile(path, 'utf8')) as { record: { ownerId?: string } }
    delete legacy.record.ownerId
    await writeFile(path, JSON.stringify(legacy))
    await ctx.fiber.dispose()
    const reopened = await harness(root)
    onTestFinished(() => reopened.ctx.fiber.dispose())
    const assignments: string[] = []
    reopened.ctx.provide('sessionOwners', { assign: async (_id, ownerId) => { assignments.push(ownerId) }, ownerOf: () => undefined })
    const invocation = (ownerId: string) => reopened.ctx.extend({ invocation: {
      peer: { principal: { kind: 'account', ownerId } },
    } as never })
    expect(invocation('owner').persistentAgents.get(profile.id).ownerId).toBeUndefined()
    expect(() => invocation('other').persistentAgents.get(profile.id)).toThrow('Unknown persistent agent')
    await reopened.ctx.persistentAgents.bind(SessionId('legacy-session'), profile.id)
    expect(assignments).toEqual(['owner'])
    expect((await reopened.ctx.persistentAgents.update(profile.id, 1, { ownerId: 'owner' })).ownerId).toBe('owner')
  })
  it('preserves identity, first task, history and pending references across edits and reopen (1)', async () => {
    const { ctx, root, registryFiber } = await fixture()
    const profile = await ctx.persistentAgents.create({ name: 'One', title: 'Old', instructions: 'Literal {{keep}}', firstTask: 'First', ownerId: 'owner', reserves: [inherited], automaticFallback: true }, inherited)
    const agent = await live(ctx, 'conversation', profile.id)
    const secondSession = await live(ctx, 'second-conversation', profile.id)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const history = agent.session.snapshotEvents()
    const changed = await ctx.persistentAgents.update(profile.id, 1, { title: 'New' })
    expect(changed).toEqual({ ...profile, title: 'New', revision: 2, updatedAt: changed.updatedAt })
    const renamed = await ctx.persistentAgents.update(profile.id, 2, { name: 'Renamed', avatarSeed: 'stable' })
    expect(renamed.avatar).toEqual({ kind: 'generated', value: 'stable' })
    expect(renamed.id).toBe(profile.id)
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

  it('keeps same-named agents distinct and resolves session references by id after a rename (2)', async () => {
    const { ctx } = await fixture()
    const first = await ctx.persistentAgents.create({ name: 'Twin' }, inherited)
    const second = await ctx.persistentAgents.create({ name: 'Twin' }, inherited)
    expect(first.id).not.toBe(second.id)
    const session = await live(ctx, 'twin-session', first.id)
    await ctx.persistentAgents.update(first.id, 1, { name: 'Renamed twin' })
    expect(ctx.persistentAgents.metadataOf(session.id)).toEqual({ agentId: first.id, ownerId: 'owner' })
    expect(ctx.persistentAgents.get(first.id).name).toBe('Renamed twin')
    expect(ctx.persistentAgents.get(second.id).name).toBe('Twin')
  })

  it('keeps session ids that differ only in case as separate durable documents (high 1)', async () => {
    const { ctx, registryFiber, root } = await fixture()
    const upper = await ctx.persistentAgents.create({ name: 'Upper' }, inherited)
    const lower = await ctx.persistentAgents.create({ name: 'Lower' }, inherited)
    await ctx.persistentAgents.bind(SessionId('Session'), upper.id)
    await ctx.persistentAgents.bind(SessionId('session'), lower.id)
    // Windows folds case, so the two bindings must not share one file.
    expect(await readdir(join(root, 'data/agents/sessions'))).toHaveLength(2)
    await registryFiber.dispose()
    await ctx.fiber.dispose()
    const reopened = await harness(root)
    onTestFinished(() => reopened.ctx.fiber.dispose())
    expect(reopened.ctx.persistentAgents.metadataOf(SessionId('Session'))?.agentId).toBe(upper.id)
    expect(reopened.ctx.persistentAgents.metadataOf(SessionId('session'))?.agentId).toBe(lower.id)
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

  it('stores supported explicit effort, validates every reserve and rejects unusable consent or account (4)', async () => {
    const { ctx } = await fixture()
    const adapter = new Adapter([], { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }] })
    ctx.llm.registerAdapter(['effort'], adapter)
    const model = { provider: 'effort', model: 'test', reasoningEffort: 'medium' }
    const profile = await ctx.persistentAgents.create({ name: 'Effort', model, reserves: [inherited], automaticFallback: true }, inherited)
    expect(await ctx.persistentAgents.selection(profile.id)).toEqual({ provider: 'effort', model: 'test', reasoningEffort: 'medium' })
    await expect(ctx.persistentAgents.update(profile.id, 1, { reserves: [{ provider: 'mock', model: 'absent' }] })).rejects.toThrow('Unknown model')
    expect(ctx.persistentAgents.get(profile.id).model).toEqual(model)
    // Consent without a usable reserve would silently promise a switch that cannot happen.
    await expect(ctx.persistentAgents.create({ name: 'No reserve', automaticFallback: true }, inherited)).rejects.toThrow('requires at least one reserve')
    await expect(ctx.persistentAgents.update(profile.id, 1, { automaticFallback: true, reserves: [] })).rejects.toThrow('requires at least one reserve')
    // The native loop has no account selector, so a route must not store one it cannot honour.
    const withAccount = { provider: 'mock', model: 'test', account: 'ghost' }
    await expect(ctx.persistentAgents.create({ name: 'Account', model: withAccount }, inherited)).rejects.toThrow('account')
    expect(ctx.persistentAgents.get(profile.id).model).toEqual(model)
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

describe('flat sidebar sections', () => {
  it('groups and renames without touching identity, and ungroups members when deleted', async () => {
    const { ctx } = await fixture()
    const a = await ctx.persistentAgents.create({ name: 'A' }, inherited)
    const b = await ctx.persistentAgents.create({ name: 'B' }, inherited)
    const ungrouped = await ctx.persistentAgents.create({ name: 'C' }, inherited)
    const section = await ctx.persistentAgents.createSection('  Trabalho  ')
    expect(section).toMatchObject({ name: 'Trabalho', ownerId: 'owner', revision: 1 })
    await ctx.persistentAgents.createSection('Segundo')
    expect(ctx.persistentAgents.listSections().map(item => item.name)).toEqual(['Trabalho', 'Segundo'])
    expect((await ctx.persistentAgents.create({ name: 'Created grouped', sectionId: section.id }, inherited)).sectionId).toBe(section.id)
    await expect(ctx.persistentAgents.create({ name: 'Foreign group', sectionId: 'missing' }, inherited)).rejects.toThrow('Unknown section')
    expect((await ctx.persistentAgents.assignSection(a.id, section.id)).sectionId).toBe(section.id)
    expect((await ctx.persistentAgents.update(ungrouped.id, 1, { sectionId: section.id })).sectionId).toBe(section.id)
    expect((await ctx.persistentAgents.update(ungrouped.id, 2, { sectionId: null })).sectionId).toBeUndefined()
    const renamed = await ctx.persistentAgents.renameSection(section.id, 'Pessoal')
    expect(renamed).toMatchObject({ name: 'Pessoal', revision: 2 })
    expect(ctx.persistentAgents.get(a.id)).toMatchObject({ id: a.id, name: 'A', sectionId: section.id })
    expect((await ctx.persistentAgents.assignSection(a.id, null)).sectionId).toBeUndefined()
    await ctx.persistentAgents.assignSection(a.id, section.id)
    await ctx.persistentAgents.assignSection(b.id, section.id)
    await ctx.persistentAgents.deleteSection(section.id)
    expect(ctx.persistentAgents.listSections().map(item => item.name)).toEqual(['Segundo'])
    expect(ctx.persistentAgents.get(a.id).sectionId).toBeUndefined()
    expect(ctx.persistentAgents.get(a.id).name).toBe('A')
    expect(ctx.persistentAgents.get(b.id).sectionId).toBeUndefined()
    expect(ctx.persistentAgents.get(b.id).name).toBe('B')
    await expect(ctx.persistentAgents.createSection('')).rejects.toThrow()
    await expect(ctx.persistentAgents.createSection('x'.repeat(41))).rejects.toThrow()
    await expect(ctx.persistentAgents.assignSection(a.id, 'missing')).rejects.toThrow('Unknown section')
  })

  it('keeps sections inside the authenticated account and lets the host account see them', async () => {
    const { ctx } = await fixture()
    const as = (ownerId: string) => ctx.extend({ invocation: { peer: { principal: { kind: 'account', ownerId } } } as never })
    const a = as('a')
    const b = as('b')
    const sectionA = await a.persistentAgents.createSection('Only A')
    const profileB = await b.persistentAgents.create({ name: 'B agent' }, inherited)
    expect(await b.persistentAgents.listSections()).toEqual([])
    expect(ctx.persistentAgents.listSections().map(section => section.id)).toEqual([sectionA.id])
    await expect(b.persistentAgents.assignSection(profileB.id, sectionA.id)).rejects.toThrow('Unknown section')
    await expect(b.persistentAgents.renameSection(sectionA.id, 'stolen')).rejects.toThrow('Unknown section')
    await expect(b.persistentAgents.deleteSection(sectionA.id)).rejects.toThrow('Unknown section')
    expect((await a.persistentAgents.create({ name: 'A agent' }, inherited)).ownerId).toBe('a')
  })

  it('persists a section and its membership across a registry reopen', async () => {
    const { ctx, root, registryFiber } = await fixture()
    const profile = await ctx.persistentAgents.create({ name: 'Persisted' }, inherited)
    const section = await ctx.persistentAgents.createSection('Kept')
    await ctx.persistentAgents.assignSection(profile.id, section.id)
    const agent = await live(ctx, 'sectioned', profile.id)
    expect(ctx.persistentAgents.of(agent)).toBe(profile.id)
    await registryFiber.dispose()
    await ctx.fiber.dispose()
    const reopened = await harness(root)
    onTestFinished(() => reopened.ctx.fiber.dispose())
    expect(reopened.ctx.persistentAgents.listSections()).toEqual([{ ...section, revision: 1 }])
    expect(reopened.ctx.persistentAgents.get(profile.id).sectionId).toBe(section.id)
  })

  it('reads legacy ownerless sections and profiles as the host account', async () => {
    const { ctx, root, registryFiber } = await fixture()
    const section = await ctx.persistentAgents.createSection('Legacy group')
    const profile = await ctx.persistentAgents.create({ name: 'Legacy member' }, inherited)
    await registryFiber.dispose()
    for (const path of [join(root, 'data/agents/sections', `${section.id}.json`), join(root, 'data/agents/profiles', `${profile.id}.json`)]) {
      const stored = JSON.parse(await readFile(path, 'utf8')) as { record: { ownerId?: string } }
      delete stored.record.ownerId
      await writeFile(path, JSON.stringify(stored))
    }
    await ctx.fiber.dispose()
    const reopened = await harness(root)
    onTestFinished(() => reopened.ctx.fiber.dispose())
    const legacy = reopened.ctx.persistentAgents
    expect(legacy.listSections().map(item => item.id)).toEqual([section.id])
    const asOwner = reopened.ctx.extend({ invocation: { peer: { principal: { kind: 'account', ownerId: 'owner' } } } as never })
    expect(asOwner.persistentAgents.listSections().map(item => item.id)).toEqual([section.id])
    expect((await legacy.assignSection(profile.id, section.id)).sectionId).toBe(section.id)
    expect((await legacy.update(profile.id, 2, { sectionId: section.id })).sectionId).toBe(section.id)
    expect((await legacy.update(profile.id, 3, { ownerId: 'owner' })).ownerId).toBe('owner')
    await expect(legacy.update(profile.id, 4, { ownerId: 'other' })).rejects.toThrow('Agent owner cannot be changed')
    expect((await legacy.renameSection(section.id, 'Renamed legacy')).name).toBe('Renamed legacy')
  })

  it('refuses a stale rename after a concurrent section revision change', async () => {
    const { ctx } = await fixture()
    const section = await ctx.persistentAgents.createSection('Race group')
    const outcomes = await Promise.allSettled([
      ctx.persistentAgents.renameSection(section.id, 'First'),
      ctx.persistentAgents.renameSection(section.id, 'Second'),
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = outcomes.find(outcome => outcome.status === 'rejected')
    expect(rejected).toMatchObject({ reason: expect.objectContaining({ message: 'Section revision conflict; read the sections again' }) })
  })

  it('refuses a stale section assignment after a concurrent revision change', async () => {
    const { ctx } = await fixture()
    const profile = await ctx.persistentAgents.create({ name: 'Race' }, inherited)
    const section = await ctx.persistentAgents.createSection('Race group')
    const outcomes = await Promise.allSettled([
      ctx.persistentAgents.assignSection(profile.id, section.id),
      ctx.persistentAgents.assignSection(profile.id, section.id),
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = outcomes.find(outcome => outcome.status === 'rejected')
    expect(rejected).toMatchObject({ reason: expect.objectContaining({ message: 'Agent revision conflict; read the profile again' }) })
  })
})
