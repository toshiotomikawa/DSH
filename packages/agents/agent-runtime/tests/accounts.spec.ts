import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { describe, it, expect, onTestFinished, vi } from 'vitest'
import * as Accounts from '../src/accounts.ts'
import * as AccountAuth from '../src/account-auth.ts'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'

async function fixture() {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/accounts-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'data') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Accounts, { tokenDirectory: join(root, 'tokens') })
  onTestFinished(() => ctx.fiber.dispose())
  return { ctx, root, accounts: ctx.accounts }
}

/** Mint an account and read back the token the operator would deliver. */
async function mint(accounts: Accounts.Accounts, name: string, role?: Accounts.AccountRole) {
  const created = await accounts.create(name, role)
  const token = (await readFile(created.tokenFile, 'utf8')).trim()
  return { ...created, token }
}

describe('accounts domain', () => {
  it('creates an active account, writes its token to a restricted file and stores only the hash', async () => {
    const { ctx, root, accounts } = await fixture()
    const { account, token, tokenFile } = await mint(accounts, 'Ada', 'administrator')
    expect(account).toMatchObject({ name: 'Ada', role: 'administrator', state: 'active', revision: 1 })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(tokenFile.startsWith(join(root, 'tokens'))).toBe(true)
    if (process.platform !== 'win32') expect(((await stat(tokenFile)).mode & 0o777)).toBe(0o600)
    expect(accounts.list()).toEqual([account])
    expect(accounts.get(account.id)).toEqual(account)
    // The plaintext token never reaches durable storage.
    const stored = await readFile(join(root, 'data/accounts/credentials', `${account.id}.json`), 'utf8').catch(() => '')
    expect(stored).not.toContain(token)
    expect(accounts.authenticate(token)).toMatchObject({ id: account.id })
    await ctx.fiber.dispose()
  })

  it('removes the token file when the account record cannot be saved', async () => {
    const { root, accounts } = await fixture()
    const table = ((accounts as unknown as {
      domain: { table(name: string): { put(key: string, record: unknown): Promise<void> } }
    }).domain).table('credentials')
    const publish = table.put.bind(table)
    table.put = async () => { throw new Error('disk full') }
    await expect(accounts.create('Doomed')).rejects.toThrow('disk full')
    table.put = publish
    expect(await readdir(join(root, 'tokens'))).toEqual([])
  })

  it('defaults the token directory to DSH_HOME, then the user home', () => {
    const saved = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = 'C:/dsh-home'
      const home = new Accounts.Accounts(new Context(), {} as never)
      expect((home as unknown as { tokens: string }).tokens).toBe(join('C:/dsh-home', 'accounts', 'tokens'))
      delete process.env.DSH_HOME
      const user = new Accounts.Accounts(new Context(), {} as never)
      expect((user as unknown as { tokens: string }).tokens).toBe(join(homedir(), '.dsh', 'accounts', 'tokens'))
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  it('never overwrites an existing token file', async () => {
    const { root } = await fixture()
    const file = await Accounts.writeEntryToken(join(root, 'tokens'), 'account-1', 'first-token')
    await expect(Accounts.writeEntryToken(join(root, 'tokens'), 'account-1', 'second-token'))
      .rejects.toMatchObject({ code: 'EEXIST' })
    expect((await readFile(file, 'utf8')).trim()).toBe('first-token')
  })

  it('authenticates only active accounts and never an empty or unknown token', async () => {
    const { accounts } = await fixture()
    const { account, token } = await mint(accounts, 'Member')
    expect(account.role).toBe('member')
    expect(accounts.authenticate('')).toBeUndefined()
    expect(accounts.authenticate('wrong')).toBeUndefined()
    expect(accounts.authenticate(token)).toMatchObject({ id: account.id })
    await accounts.disable(account.id)
    expect(accounts.authenticate(token)).toBeUndefined()
    await accounts.reactivate(account.id)
    expect(accounts.authenticate(token)).toMatchObject({ id: account.id })
    await accounts.archive(account.id)
    expect(accounts.authenticate(token)).toBeUndefined()
  })

  it('rejects absent accounts and illegal transitions', async () => {
    const { accounts } = await fixture()
    expect(() => accounts.get('missing')).toThrow('Unknown account: missing')
    await expect(accounts.disable('missing')).rejects.toThrow('Unknown account: missing')
    const { account } = await mint(accounts, 'One')
    await expect(accounts.reactivate(account.id)).rejects.toThrow('is not disabled')
    await accounts.archive(account.id)
    await expect(accounts.archive(account.id)).rejects.toThrow('is already archived')
    await expect(accounts.disable(account.id)).rejects.toThrow('is not active')
  })

  it('keeps archived records readable and lists accounts oldest first', async () => {
    const { accounts } = await fixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const first = await mint(accounts, 'Same')
    const second = await mint(accounts, 'Same')
    clock.mockRestore()
    expect(second.account.id).not.toBe(first.account.id)
    const archived = await accounts.archive(second.account.id)
    expect(archived.state).toBe('archived')
    const expected = [first.account.id, second.account.id].sort((left, right) => left.localeCompare(right))
      .map(id => id === second.account.id ? 'archived' : 'active')
    expect(accounts.list().map(account => account.state)).toEqual(expected)
    expect(accounts.isAdministrator(first.account.id)).toBe(false)
    const admin = await mint(accounts, 'Admin', 'administrator')
    expect(accounts.isAdministrator(admin.account.id)).toBe(true)
    await accounts.disable(admin.account.id)
    expect(accounts.isAdministrator(admin.account.id)).toBe(false)
  })

  it('scans every credential so a disabled token and an unknown one take the same path', async () => {
    const { accounts } = await fixture()
    const first = await mint(accounts, 'First')
    const second = await mint(accounts, 'Second')
    await accounts.disable(first.account.id)
    await accounts.disable(second.account.id)
    const table = ((accounts as unknown as {
      domain: { table(name: string): { entries(): Iterable<[string, unknown]> } }
    }).domain).table('credentials')
    const original = table.entries.bind(table)
    let visits = 0
    table.entries = function* (): IterableIterator<[string, unknown]> {
      for (const entry of original()) { visits++; yield entry }
    }
    expect(accounts.authenticate('unknown-token')).toBeUndefined()
    expect(visits).toBe(2)
    for (const token of [first.token, second.token]) {
      visits = 0
      expect(accounts.authenticate(token)).toBeUndefined()
      expect(visits).toBe(2)
    }
    table.entries = original
  })

  it('refuses a transition whose revision moved under it', async () => {
    const { accounts } = await fixture()
    const { account } = await mint(accounts, 'Racy')
    const domain = (accounts as unknown as {
      domain: { table(name: string): {
        get(key: string): unknown
        update(key: string, fn: (stored: unknown) => unknown): Promise<unknown>
      } }
    }).domain
    const table = domain.table('accounts')
    const original = table.get.bind(table)
    table.get = (key: string) => ({ ...(original(key) as object), revision: (original(key) as { revision: number }).revision + 1 })
    await expect(accounts.disable(account.id)).rejects.toThrow('revision conflict')
    table.get = original
  })
})

interface FakeConnection {
  sources: ((request: ConnectionTrustRequest) => Principal | undefined)[]
  revoked: Principal[]
  registerPrincipalSource(source: (request: ConnectionTrustRequest) => Principal | undefined): () => Promise<void>
  revokePrincipal(principal: Principal): Promise<void>
}

function fakeConnection(): FakeConnection {
  const connection: FakeConnection = {
    sources: [],
    revoked: [],
    registerPrincipalSource(source) {
      connection.sources.push(source)
      return async () => { connection.sources = connection.sources.filter(entry => entry !== source) }
    },
    async revokePrincipal(principal) { connection.revoked.push(principal) },
  }
  return connection
}

async function authFixture() {
  const ctx = new Context()
  const connection = fakeConnection()
  const active = new Map<string, { id: string }>()
  ctx.provide('accounts', {
    authenticate: (token: string) => active.get(token),
  } as never)
  ctx.provide('connection', connection as never)
  const fiber = await ctx.plugin(AccountAuth)
  onTestFinished(() => fiber.dispose())
  return { ctx, connection, active }
}

function request(headers: ConnectionTrustRequest['headers']): ConnectionTrustRequest {
  return { headers }
}

describe('account entry token admission', () => {
  it('maps a bearer token to the account principal and ignores everything else', async () => {
    const { connection, active } = await authFixture()
    const token = 'good-token'
    active.set(token, { id: 'a' })
    const source = connection.sources[0]!
    expect(source(request({ authorization: `Bearer ${token}` }))).toEqual({ kind: 'account', ownerId: 'a' })
    expect(source(request({ Authorization: `bearer ${token}` }))).toEqual({ kind: 'account', ownerId: 'a' })
    expect(source(request(new Headers({ authorization: `Bearer ${token}` })))).toEqual({ kind: 'account', ownerId: 'a' })
    expect(source(request(new Headers()))).toBeUndefined()
    expect(source(request({ authorization: [`Bearer ${token}`] }))).toEqual({ kind: 'account', ownerId: 'a' })
    expect(source(request({ authorization: 'Basic abc' }))).toBeUndefined()
    expect(source(request({ authorization: 'Bearer ' }))).toBeUndefined()
    expect(source(request({ authorization: ['Basic a', 'Basic b'] }))).toBeUndefined()
    expect(source(request({ authorization: undefined }))).toBeUndefined()
    expect(source(request({}))).toBeUndefined()
    expect(source(request({ authorization: 'Bearer wrong' }))).toBeUndefined()
  })

  it('ends the account Peers when the account is disabled or archived', async () => {
    const { ctx, connection } = await authFixture()
    ctx.emit('accounts/ended', 'a')
    await Promise.resolve()
    expect(connection.revoked).toEqual([{ kind: 'account', ownerId: 'a' }])
  })

  it('removes its source with the plugin', async () => {
    const { ctx, connection } = await authFixture()
    expect(connection.sources).toHaveLength(1)
    await ctx.fiber.dispose()
    await Promise.resolve()
    expect(connection.sources).toHaveLength(0)
  })
})
