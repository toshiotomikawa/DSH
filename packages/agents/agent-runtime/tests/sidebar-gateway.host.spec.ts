import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Typert, { type TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import { expect, it, onTestFinished } from 'vitest'
import { harness, inherited } from '../../agent-registry/tests/harness.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { HostConnectionService } from '../../../client/connection/src/rpc-host.ts'
import type { BrowserAuth } from '../../../client/connection/src/browser-auth.ts'
import * as Sidebar from '../../../client/ui-sidebar/src/index.ts'
import type { AgentSidebarSnapshot } from '../../../client/ui-sidebar/src/types.ts'
import * as Owners from '../src/owners.ts'
import * as Accounts from '../src/accounts.ts'
import * as AccountAuth from '../src/account-auth.ts'

// The generated typert artifact exists only after a build. Read it lazily so a clean checkout can
// load this file and skip the gateway test instead of failing to import a missing module.
const typertHostPath = new URL('../../../client/ui-sidebar/lib/typert.host.js', import.meta.url)
const typertHost = existsSync(typertHostPath) ? await import(typertHostPath.href) : null

it.skipIf(typertHost === null)('admits only the five account sidebar actions through Gateway and keeps two authenticated accounts isolated', async () => {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/sidebar-gateway-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const { ctx } = await harness(root)
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as unknown as Context['workspaceRegistry'])
  await ctx.plugin(Typert)
  await ctx.plugin(Query, { path: ':memory:' })
  await createSessionTestController(ctx, { defaultModelSelection: () => inherited, cwd: root })
  await ctx.plugin(Gateway)
  await ctx.plugin(Accounts, { tokenDirectory: join(root, 'tokens') })
  await ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [], {
      isAuthenticated: () => false, authenticateApi: () => undefined,
    } as unknown as BrowserAuth)
  })
  await ctx.plugin(AccountAuth)
  await ctx.plugin(Owners)
  await ctx.plugin(Sidebar)
  if (typertHost === null) throw new Error('the gateway test needs the generated typert artifact')
  ctx.typert.register(typertHost.TYPERT as TypertContribution)

  const account = async (name: string) => {
    const entry = await ctx.accounts.create(name)
    const token = (await readFile(entry.tokenFile, 'utf8')).trim()
    const admitted = ctx.connection.admit({ headers: { host: '127.0.0.1:4096', authorization: `Bearer ${token}` } })
    if (!('peer' in admitted)) throw new Error('account admission failed')
    expect(admitted.peer.principal).toEqual({ kind: 'account', ownerId: entry.account.id })
    const agent = await ctx.persistentAgents.create({ name, ownerId: entry.account.id }, inherited)
    const call = (method: string, args: Record<string, unknown> = {}) =>
      ctx.typertGateway.invoke({ peer: admitted.peer, namespace: 'agentSidebar', method, args })
    const list = async () => await call('list') as AgentSidebarSnapshot
    return { agent, call, list, peer: admitted.peer }
  }
  const a = await account('A'), b = await account('B')
  await a.call('createSection', { name: 'A section' })
  await b.call('createSection', { name: 'B section' })
  const sectionA = (await a.list()).sections[0]!
  const sectionB = (await b.list()).sections[0]!
  expect((await a.list()).agents.map(agent => agent.id)).toEqual([a.agent.id])
  expect((await b.list()).agents.map(agent => agent.id)).toEqual([b.agent.id])
  expect((await a.list()).sections).toEqual([sectionA])
  expect((await b.list()).sections).toEqual([sectionB])
  await a.call('renameSection', { id: sectionA.id, name: 'Renamed A' })
  await a.call('moveAgent', { id: a.agent.id, sectionId: sectionA.id })
  expect(await a.list()).toMatchObject({ agents: [{ sectionId: sectionA.id }], sections: [{ name: 'Renamed A' }] })
  for (const [caller, own, foreign] of [[a, sectionA, b], [b, sectionB, a]] as const) {
    const foreignSection = (await foreign.list()).sections[0]!
    await expect(caller.call('renameSection', { id: foreignSection.id, name: 'Stolen' })).rejects.toThrow('Unknown section')
    await expect(caller.call('deleteSection', { id: foreignSection.id })).rejects.toThrow('Unknown section')
    await expect(caller.call('moveAgent', { id: foreign.agent.id, sectionId: own.id })).rejects.toThrow()
    await expect(caller.call('moveAgent', { id: caller.agent.id, sectionId: foreignSection.id })).rejects.toThrow('Unknown section')
  }
  expect((await b.list()).sections).toEqual([sectionB])
  await a.call('moveAgent', { id: a.agent.id, sectionId: null })
  await a.call('deleteSection', { id: sectionA.id })
  expect(await a.list()).toMatchObject({ agents: [{ id: a.agent.id }], sections: [] })
  expect((await b.list()).sections).toEqual([sectionB])
  const baseline = ctx.remoteAccess.snapshotFor(a.peer.principal)
  if (baseline.owner) throw new Error('account must not receive owner bypass')
  const global = baseline.grants.find(grant => grant.resource.kind === 'global')!
  expect([...global.actions].sort()).toEqual([
    'agentSidebar/createSection', 'agentSidebar/deleteSection', 'agentSidebar/list', 'agentSidebar/moveAgent', 'agentSidebar/renameSection',
    'session/control', 'session/create', 'session/list', 'session/search',
  ])
  await expect(a.call('exportAll')).rejects.toThrow()
})
