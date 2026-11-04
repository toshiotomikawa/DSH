import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as Accounts from '../src/accounts.ts'
import * as AccountTools from '../src/account-tools.ts'

async function fixture() {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/account-tools-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'data') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Accounts, { tokenDirectory: join(root, 'tokens') })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const owners = new Map<string, string>()
  ctx.provide('sessionOwners', { ownerOf: (id: SessionId) => owners.get(id) } as never)
  await ctx.plugin(AccountTools)
  onTestFinished(() => ctx.fiber.dispose())
  const agentOf = (id: string): Agent => ({ id: SessionId(id), session: { id: SessionId(id) } }) as unknown as Agent
  const bind = (session: string, ownerId: string): Agent => {
    owners.set(session, ownerId)
    return agentOf(session)
  }
  const run = (name: string, args: Record<string, unknown> = {}, agent: Agent | null) =>
    executeModelToolFixture(ctx, {
      callId: ToolCallId(`call-${name}`), name, arguments: args, signal: new AbortController().signal,
      ...(agent === null ? {} : { agent }),
    })
  return { ctx, accounts: ctx.accounts, bind, agentOf, run }
}

describe('account administration tools', () => {
  it('lists every account for an active administrator only, without any credential', async () => {
    const { accounts, bind, agentOf, run } = await fixture()
    const admin = await accounts.create('Admin', 'administrator')
    const member = await accounts.create('Member')
    const adminToken = (await readFile(admin.tokenFile, 'utf8')).trim()
    const asAdmin = bind('admin-session', admin.account.id)
    const listed = await run('account_list', {}, asAdmin)
    expect(listed.isError).toBe(false)
    expect(JSON.stringify(listed)).not.toContain(adminToken)
    expect(listed.isError ? undefined : listed.value).toEqual([
      { id: admin.account.id, name: 'Admin', role: 'administrator', state: 'active' },
      { id: member.account.id, name: 'Member', role: 'member', state: 'active' },
    ])
    expect((await run('account_list', {}, bind('member-session', member.account.id))).isError).toBe(true)
    expect((await run('account_list', {}, agentOf('unbound'))).isError).toBe(true)
    expect((await run('account_list', {}, null)).isError).toBe(true)
  })

  it('creates an account as a member by default and returns only the token file path', async () => {
    const { ctx, accounts, bind, run } = await fixture()
    const admin = await accounts.create('Admin', 'administrator')
    const asAdmin = bind('admin-session', admin.account.id)
    const logged: string[] = []
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      ctx.logger[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    }
    const created = await run('account_create', { name: 'New' }, asAdmin)
    expect(created.isError).toBe(false)
    const value = (created.isError ? {} : created.value) as { id: string; role: string; token_file: string }
    expect(value.role).toBe('member')
    expect(JSON.stringify(created)).not.toContain('token":"')
    const token = (await readFile(value.token_file, 'utf8')).trim()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    // Neither the model-facing value, the rendered content nor any log line carries the secret.
    expect(JSON.stringify(created)).not.toContain(token)
    expect(logged.join('\n')).not.toContain(token)
    expect(accounts.authenticate(token)).toMatchObject({ id: value.id })
    const elevated = await run('account_create', { name: 'Boss', role: 'administrator' }, asAdmin)
    expect(elevated.isError ? undefined : elevated.value).toMatchObject({ role: 'administrator' })
    expect(JSON.stringify(await run('account_list', {}, asAdmin))).not.toContain(token)
  })

  it('disables, reactivates and archives one named account as an administrator', async () => {
    const { accounts, bind, run } = await fixture()
    const admin = await accounts.create('Admin', 'administrator')
    const target = await accounts.create('Target')
    const asAdmin = bind('admin-session', admin.account.id)
    const disabled = await run('account_disable', { account_id: target.account.id }, asAdmin)
    expect(disabled.isError ? undefined : disabled.value).toMatchObject({ state: 'disabled' })
    const reactivated = await run('account_reactivate', { account_id: target.account.id }, asAdmin)
    expect(reactivated.isError ? undefined : reactivated.value).toMatchObject({ state: 'active' })
    const archived = await run('account_archive', { account_id: target.account.id }, asAdmin)
    expect(archived.isError ? undefined : archived.value).toMatchObject({ state: 'archived' })
    expect((await run('account_archive', { account_id: '  ' }, asAdmin)).isError).toBe(true)
    expect((await run('account_disable', { account_id: 'missing' }, asAdmin)).isError).toBe(true)
    const member = await accounts.create('Member')
    expect((await run('account_archive', { account_id: member.account.id }, bind('member-session', member.account.id))).isError).toBe(true)
  })
})
