/** Durable accounts and one server-issued entry credential per account. @module */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

/** Who may administer accounts. */
export type AccountRole = 'administrator' | 'member'
/** Whether an account may authenticate; archived accounts stay readable and never authenticate. */
export type AccountState = 'active' | 'disabled' | 'archived'

const nameSchema = z.string().trim().min(1).max(80)
const accountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  role: z.enum(['administrator', 'member']),
  state: z.enum(['active', 'disabled', 'archived']),
  revision: z.number().int().positive(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict()
const credentialSchema = z.object({
  accountId: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number(),
}).strict()
const accountsDomain = defineDomain({ name: 'accounts', version: 1, layout: 'per-record', tables: {
  accounts: domainTable<string, z.infer<typeof accountSchema>>(accountSchema),
  credentials: domainTable<string, z.infer<typeof credentialSchema>>(credentialSchema),
} })

/** One durable account; two accounts may share a display name and the id decides. */
export type Account = z.infer<typeof accountSchema>

/** The single credential minted with an account; only its hash is stored. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable accounts and their entry credentials. */
    accounts: Accounts
  }
  interface Events {
    /**
     * One account may no longer authenticate or act, so its connections must end.
     * @param accountId - stable id of the disabled or archived account.
     * @mode emit
     */
    'accounts/ended'(accountId: string): void
  }
}

/** Cordis plugin name. */
export const name = 'accounts'
/** Durable storage is the only requirement. */
export const inject = ['storageDomain']

/** Account records and the hash-only entry credential of each account. */
export class Accounts extends Service {
  /** @param ctx - plugin context.
   * @param domain - exclusively opened account domain.
   */
  constructor(ctx: Context, private readonly domain: Domain<typeof accountsDomain>) { super(ctx, 'accounts') }

  /**
   * Create one active account and issue its entry token, which is returned once
   * and stored only as its SHA-256 hash.
   * @param displayName - name shown to people; another account may share it.
   * @param role - administrator or member.
   * @returns the stored account and the plaintext token, never readable again.
   */
  async create(displayName: string, role: AccountRole = 'member'): Promise<{ account: Account; token: string }> {
    const now = Date.now()
    const token = randomBytes(32).toString('base64url')
    const account = accountSchema.parse({
      id: randomUUID(), name: nameSchema.parse(displayName), role, state: 'active',
      revision: 1, createdAt: now, updatedAt: now,
    })
    // The credential lands first: a crash then leaves an account that cannot sign in
    // instead of an account whose token is unknown.
    await this.domain.table('credentials').put(account.id, { accountId: account.id, hash: hashToken(token), createdAt: now })
    await this.domain.table('accounts').put(account.id, account)
    return { account: structuredClone(account), token }
  }

  /**
   * Read every account, oldest first.
   * @returns detached account records without any credential.
   */
  list(): Account[] {
    return [...this.domain.table('accounts').entries()].map(([, account]) => account)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(account => structuredClone(account))
  }

  /**
   * Read one account.
   * @param id - stable account id.
   * @returns detached account record.
   * @throws Error when no such account exists.
   */
  get(id: string): Account {
    const account = this.domain.table('accounts').get(id)
    if (account === undefined) throw new Error(`Unknown account: ${id}`)
    return structuredClone(account)
  }

  /**
   * Stop an active account from authenticating or acting.
   * @param id - stable account id.
   * @returns the disabled account.
   */
  async disable(id: string): Promise<Account> {
    const account = this.get(id)
    if (account.state !== 'active') throw new Error(`Account ${id} is not active`)
    const saved = await this.transition(account, 'disabled')
    this.ctx.emit('accounts/ended', id)
    return saved
  }

  /**
   * Admit a disabled account again; its data and its token survive.
   * @param id - stable account id.
   * @returns the active account.
   */
  async reactivate(id: string): Promise<Account> {
    const account = this.get(id)
    if (account.state !== 'disabled') throw new Error(`Account ${id} is not disabled`)
    return this.transition(account, 'active')
  }

  /**
   * Archive an account instead of deleting it: the record and its data stay,
   * and the entry token is destroyed.
   * @param id - stable account id.
   * @returns the archived account.
   */
  async archive(id: string): Promise<Account> {
    const account = this.get(id)
    if (account.state === 'archived') throw new Error(`Account ${id} is already archived`)
    const saved = await this.transition(account, 'archived')
    await this.domain.table('credentials').delete(id)
    this.ctx.emit('accounts/ended', id)
    return saved
  }

  /**
   * Resolve one presented entry token. Archived and disabled accounts prove nothing.
   * @param token - plaintext token from the connection.
   * @returns the active account, or undefined for an unknown, ended, or empty token.
   */
  authenticate(token: string): Account | undefined {
    if (token === '') return undefined
    const digest = createHash('sha256').update(token, 'utf8').digest()
    for (const [, credential] of this.domain.table('credentials').entries()) {
      if (!timingSafeEqual(digest, Buffer.from(credential.hash, 'hex'))) continue
      const account = this.domain.table('accounts').get(credential.accountId)
      return account?.state === 'active' ? structuredClone(account) : undefined
    }
    return undefined
  }

  /**
   * Whether one active account may administer accounts.
   * @param id - stable account id.
   * @returns true only for an active administrator.
   */
  isAdministrator(id: string): boolean {
    const account = this.domain.table('accounts').get(id)
    return account?.role === 'administrator' && account.state === 'active'
  }

  /** Drain the domain before releasing storage.
   * @returns after storage is closed.
   */
  async close(): Promise<void> { await this.domain.close() }

  private async transition(account: Account, state: AccountState): Promise<Account> {
    const next = accountSchema.parse({ ...account, state, revision: account.revision + 1, updatedAt: Date.now() })
    const saved = await this.domain.table('accounts').update(account.id, (stored) => {
      if (stored.revision !== account.revision) throw new Error('Account revision conflict; read the account again')
      return next
    })
    return structuredClone(saved)
  }
}

/**
 * Mount the account domain.
 * @param ctx - injected storage service.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(accountsDomain)
  const accounts = new Accounts(ctx, domain)
  ctx.effect(() => () => accounts.close())
}
