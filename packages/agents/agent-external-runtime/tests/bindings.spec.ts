import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { harness, inherited } from '../../agent-registry/tests/harness.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import * as Owners from '../../agent-runtime/src/owners.ts'
import * as Accounts from '../../agent-runtime/src/accounts.ts'
import * as External from '../src/index.ts'

async function fixture() {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/harness-bindings-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const { ctx } = await harness(root)
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Typert)
  await ctx.plugin(Query, { path: ':memory:' })
  await createSessionTestController(ctx, { defaultModelSelection: () => inherited, cwd: root })
  await ctx.plugin(Gateway)
  await ctx.plugin(Accounts, { tokenDirectory: join(root, 'tokens') })
  await ctx.plugin(Owners)
  const a = (await ctx.accounts.create('A', 'member')).account
  const b = (await ctx.accounts.create('B', 'member')).account
  const homes = [join(root, 'a'), join(root, 'b')]
  const workspace = join(root, 'workspace')
  for (const path of [...homes, workspace]) await mkdir(path)
  const config: External.Config = { bindings: [a, b].map((account, i) => ({ accountId: account.id, runtime: 'claude-sdk', configDirectory: homes[i]!, revision: 1 })) }
  const bind = async (ownerId = a.id, runtime: 'native' | 'claude-sdk' | 'codex-sdk' = 'claude-sdk') => {
    const profile = await ctx.persistentAgents.create({ name: 'External', ownerId, runtime }, inherited)
    const id = SessionId(profile.id)
    await ctx.persistentAgents.bind(id, profile.id)
    return { id, profile }
  }
  return { ctx, root, a, b, homes, workspace, config, bind }
}

it('loads private bindings through Loader, isolates two accounts, rechecks state and removes the service on unload', async () => {
  const f = await fixture()
  await f.ctx.plugin(Loader)
  f.ctx.loader.builtins['external'] = External
  await f.ctx.loader.root.update([{ id: 'external', name: 'cordis:external', config: f.config }])
  await f.ctx.loader.await()
  const a = await f.bind()
  const b = await f.bind(f.b.id)
  const first = await f.ctx.harnessBindings.resolve(a.id, f.workspace)
  expect(first.accountId).toBe(f.a.id)
  expect((await f.ctx.harnessBindings.resolve(b.id, f.workspace)).configDirectory).not.toBe(first.configDirectory)
  first.configDirectory = 'changed'
  expect((await f.ctx.harnessBindings.resolve(a.id, f.workspace)).configDirectory).toBe(f.homes[0])
  await f.ctx.accounts.disable(f.a.id)
  await expect(f.ctx.harnessBindings.resolve(a.id, f.workspace)).rejects.toMatchObject({ code: 'account_inactive' })
  await f.ctx.loader.root.update([])
  await f.ctx.loader.await()
  expect(f.ctx.get('harnessBindings')).toBeUndefined()
})

it('refuses missing identity, inconsistent sidecars, native profiles, missing bindings and workspace overlap', async () => {
  const f = await fixture()
  await External.apply(f.ctx, f.config)
  const resolve = (id: SessionId, workspace = f.workspace) => f.ctx.harnessBindings.resolve(id, workspace)
  await expect(resolve(SessionId('missing'))).rejects.toMatchObject({ code: 'owner_mismatch' })
  const a = await f.bind()
  await f.ctx.sessionOwners.assign(a.id, f.b.id)
  await expect(resolve(a.id)).rejects.toMatchObject({ code: 'owner_mismatch' })
  await f.ctx.sessionOwners.assign(a.id, f.a.id)
  const metadata = vi.spyOn(f.ctx.persistentAgents, 'metadataOf').mockReturnValue({ agentId: a.profile.id, ownerId: f.b.id })
  await expect(resolve(a.id)).rejects.toMatchObject({ code: 'owner_mismatch' })
  metadata.mockRestore()
  await expect(resolve((await f.bind(f.a.id, 'native')).id)).rejects.toMatchObject({ code: 'runtime_native' })
  await expect(resolve((await f.bind(f.a.id, 'codex-sdk')).id)).rejects.toMatchObject({ code: 'binding_missing' })
  await expect(resolve(a.id, f.homes[0])).rejects.toMatchObject({ code: 'binding_conflict' })
  await expect(resolve(a.id, f.root)).rejects.toMatchObject({ code: 'binding_conflict' })
  const child = join(f.homes[0]!, 'child')
  await mkdir(child)
  await expect(resolve(a.id, child)).rejects.toMatchObject({ code: 'binding_conflict' })
})

it('requires an explicit legacy-owner binding and accepts old ownerless metadata without guessing a home', async () => {
  const f = await fixture()
  const a = await f.bind('owner')
  await expect(new External.HarnessBindings(f.ctx, f.config.bindings).resolve(a.id, f.workspace)).rejects.toMatchObject({ code: 'binding_missing' })
  const config = { bindings: [{ ...f.config.bindings[0]!, accountId: 'owner' }] }
  const serviceCtx = f.ctx.extend()
  await External.apply(serviceCtx, config)
  const get = vi.spyOn(serviceCtx.persistentAgents, 'get').mockReturnValue({ ...a.profile, ownerId: undefined })
  const metadata = vi.spyOn(serviceCtx.persistentAgents, 'metadataOf').mockReturnValue({ agentId: a.profile.id })
  expect((await serviceCtx.harnessBindings.resolve(a.id, f.workspace)).accountId).toBe('owner')
  get.mockRestore()
  metadata.mockRestore()
})

it('rejects invalid config, missing/file/network/relative paths, duplicates and cross-owner aliases without reading credentials', async () => {
  const f = await fixture()
  const original = f.config.bindings[0]!
  const file = join(f.root, 'not-directory')
  await writeFile(file, 'not a harness')
  for (const path of ['relative', '\\\\server\\share', '//server/share', file, join(f.root, 'missing')]) {
    await expect(External.apply(f.ctx.extend(), { bindings: [{ ...original, configDirectory: path }] })).rejects.toMatchObject({ code: 'binding_invalid' })
  }
  if (process.platform === 'win32') await expect(External.apply(f.ctx.extend(), { bindings: [{ ...original, configDirectory: '\\root-relative' }] })).rejects.toMatchObject({ code: 'binding_invalid' })
  await expect(External.apply(f.ctx.extend(), { bindings: [{ ...original, revision: 0 }] })).rejects.toThrow()
  await expect(External.apply(f.ctx.extend(), { bindings: [original, original] })).rejects.toMatchObject({ code: 'binding_conflict' })
  const alias = join(f.root, 'alias')
  await symlink(f.homes[0]!, alias, 'junction')
  await expect(External.apply(f.ctx.extend(), { bindings: [original, { ...f.config.bindings[1]!, configDirectory: alias }] })).rejects.toMatchObject({ code: 'binding_conflict' })
  const child = join(f.homes[0]!, 'child')
  await mkdir(child)
  await expect(External.apply(f.ctx.extend(), { bindings: [original, { ...f.config.bindings[1]!, configDirectory: child }] })).rejects.toMatchObject({ code: 'binding_conflict' })
  await expect(External.apply(f.ctx.extend(), { bindings: [{ ...f.config.bindings[1]!, configDirectory: child }, original] })).rejects.toMatchObject({ code: 'binding_conflict' })
  await External.apply(f.ctx, { bindings: [{ ...original, configDirectory: alias }] })
  const a = await f.bind()
  expect((await f.ctx.harnessBindings.resolve(a.id, f.workspace)).configDirectory).toBe(f.homes[0])
  await unlink(alias)
  // Resolution uses the canonical target, so deleting the config alias cannot redirect a live binding.
  expect((await f.ctx.harnessBindings.resolve(a.id, f.workspace)).configDirectory).toBe(f.homes[0])
  await rename(f.homes[0]!, join(f.root, 'old-a'))
  await symlink(f.homes[1]!, f.homes[0]!, 'junction')
  await expect(f.ctx.harnessBindings.resolve(a.id, f.workspace)).rejects.toMatchObject({ code: 'binding_stale' })
  await unlink(f.homes[0]!)
  await rename(join(f.root, 'old-a'), f.homes[0]!)
  const credential = join(f.homes[0]!, 'auth.json')
  await writeFile(credential, 'synthetic credential: never read by the plugin')
  expect(await readFile(credential, 'utf8')).toContain('synthetic')
})
