import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import { describe, expect, it, onTestFinished } from 'vitest'
import { harness, inherited } from '../../../agents/agent-registry/tests/harness.ts'
import { AgentSidebar, apply } from '../src/index.ts'
import * as Sidebar from '../src/index.ts'

async function fixture(loader = false) {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/sidebar-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const { ctx, registryFiber } = await harness(root)
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('typert', {} as never)
  if (loader) {
    await registryFiber.dispose()
    await ctx.plugin(Loader)
    ctx.loader.builtins.sidebar = Sidebar
    const rows = load(await readFile(new URL('./sidebar.cordis.yml', import.meta.url), 'utf8')) as EntryOptions[]
    await ctx.loader.root.update(rows)
    await ctx.loader.await()
  } else { await ctx.plugin({ apply }) }
  return {
    ctx, root,
    account: (ownerId: string) => ctx.extend({ invocation: { peer: { principal: { kind: 'account', ownerId } } } as never }),
    signal: new AbortController().signal,
  }
}

describe('agent sidebar Remote adapter', () => {
  it('boots from Loader configuration, creates the shared registry and commits visible edits to disk', async () => {
    const { ctx, account, signal, root } = await fixture(true)
    const a = account('a')
    const profile = await a.persistentAgents.create({ name: 'Durable' }, inherited)
    await a.agentSidebar.createSection('Work')
    const section = a.agentSidebar.list(signal).sections[0]!
    await a.agentSidebar.moveAgent(profile.id, section.id)
    const disk = JSON.parse(await readFile(join(root, 'data/agents/profiles', `${profile.id}.json`), 'utf8')) as { record: { sectionId: string } }
    expect(disk.record.sectionId).toBe(section.id)
    expect(a.agentSidebar.list(signal).agents[0]?.sectionId).toBe(section.id)
    await ctx.loader.root.update([])
    await ctx.loader.await()
    expect(ctx.get('agentSidebar')).toBeUndefined()
  })
  it('projects only this account, delegates all edits, retains agents on deletion, and rejects cross-account ids', async () => {
    const { ctx, account, signal } = await fixture()
    const a = account('a'), b = account('b')
    const agentA = await a.persistentAgents.create({ name: 'Ada', instructions: 'private' }, inherited)
    const agentB = await b.persistentAgents.create({ name: 'Private' }, inherited)
    await a.agentSidebar.createSection('Trabalho')
    await b.agentSidebar.createSection('Private section')
    const section = a.agentSidebar.list(signal).sections[0]!
    const foreign = b.agentSidebar.list(signal).sections[0]!
    expect(a.agentSidebar.list(signal)).toEqual({ agents: [{ id: agentA.id, name: 'Ada', title: '', sectionId: undefined }], sections: [section] })
    await a.agentSidebar.moveAgent(agentA.id, section.id)
    expect(a.agentSidebar.list(signal).agents[0]?.sectionId).toBe(section.id)
    await a.agentSidebar.renameSection(section.id, 'Equipe')
    expect(a.agentSidebar.list(signal).sections[0]?.name).toBe('Equipe')
    await expect(a.agentSidebar.renameSection(foreign.id, 'Taken')).rejects.toThrow()
    await expect(a.agentSidebar.deleteSection(foreign.id)).rejects.toThrow()
    await expect(a.agentSidebar.moveAgent(agentB.id, section.id)).rejects.toThrow()
    await expect(a.agentSidebar.moveAgent(agentA.id, foreign.id)).rejects.toThrow()
    await expect(a.agentSidebar.createSection(' ')).rejects.toThrow()
    await a.agentSidebar.moveAgent(agentA.id, null)
    await a.agentSidebar.moveAgent(agentA.id, section.id)
    await a.agentSidebar.deleteSection(section.id)
    expect(a.agentSidebar.list(signal)).toEqual({ agents: [{ id: agentA.id, name: 'Ada', title: '', sectionId: undefined }], sections: [] })
    expect(b.persistentAgents.get(agentB.id).name).toBe('Private')
    expect(() => ctx.agentSidebar.list(signal)).toThrow('authenticated invocation')
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } as never })
    expect(owner.agentSidebar.list(signal)).toEqual({ agents: [], sections: [] })
    expect(() => owner.agentSidebar.list(AbortSignal.abort())).toThrow()
    expect(ctx.agentSidebar).toBeInstanceOf(AgentSidebar)
  })
})
