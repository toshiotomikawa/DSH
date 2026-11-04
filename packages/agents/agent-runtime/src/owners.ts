/** Optional account ownership policy and durable Session sidecars. @module */
import { Service, type Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessBinding, RemoteAccessRole } from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-session-controller'

const metadata = z.object({
  sessionId: z.string().min(1),
  ownerId: z.string().min(1).optional(),
  denied: z.literal(true).optional(),
}).strict()
const ownership = defineDomain({ name: 'session_owners', version: 1, layout: 'per-record', invalidRecords: 'quarantine', tables: {
  sessions: domainTable<string, z.infer<typeof metadata>>(metadata),
} })
const share = z.object({
  ownerId: z.string().min(1), granteeId: z.string().min(1), createdAt: z.number(),
}).strict()
const shares = defineDomain({ name: 'account_grants', version: 1, layout: 'per-record', tables: {
  grants: domainTable<string, z.infer<typeof share>>(share),
} })

/** Loader plugin name. */
export const name = 'agent-owner-policy'
/** Services needed to filter direct Session calls and retain cold Session ownership. */
export const inject = ['remoteAccess', 'storageDomain', 'sessionQuery', 'sessionController', 'sessions']

/** Sidecar metadata service. Only trusted Host creation/binding code may assign ownership. */
export class SessionOwners extends Service {
  private tail: Promise<void> = Promise.resolve()

  /** @param ctx - plugin context.
   * @param domain - exclusively opened metadata domain.
   */
  constructor(ctx: Context, private readonly domain: Domain<typeof ownership>) { super(ctx, 'sessionOwners') }

  /** Persist the owner of a newly created or explicitly bound Session.
   * A failed write leaves the Session denied to every account instead of
   * keeping the owner the creation event adopted first.
   * @param sessionId - Session identity from trusted Host code.
   * @param ownerId - account id from the connection or persistent agent.
   * @returns after serialized durable publication.
   */
  assign(sessionId: SessionId, ownerId: string): Promise<void> {
    const record = metadata.parse({ sessionId, ownerId })
    return this.enqueue(async () => {
      try {
        await this.domain.table('sessions').put(this.key(sessionId), record)
      } catch (error) {
        await this.domain.table('sessions').put(this.key(sessionId), { sessionId, denied: true }).catch(() => {})
        this.ctx.remoteAccess.invalidate()
        throw error
      }
      this.ctx.remoteAccess.invalidate()
    })
  }

  /** Record legacy or local Sessions under the single-account owner without replacing an existing binding.
   * @param sessionId - discovered live or stored Session.
   * @returns after any missing sidecar is saved.
   */
  ensure(sessionId: SessionId): Promise<void> {
    return this.enqueue(async () => {
      if (this.domain.table('sessions').get(this.key(sessionId)) === undefined) {
        await this.domain.table('sessions').put(this.key(sessionId), { sessionId, ownerId: 'owner' })
        this.ctx.remoteAccess.invalidate()
      }
    })
  }

  /** Enumerate Session ids for one authenticated account.
   * @param ownerId - connection account id.
   * @returns detached owned Session identities, including cold Sessions.
   */
  sessionsOf(ownerId: string): SessionId[] {
    return [...this.domain.table('sessions').entries()].flatMap(([, record]) =>
      record.denied === true || (record.ownerId ?? 'owner') !== ownerId ? [] : [SessionId(record.sessionId)])
  }

  /** Read the owner fixed for a stored Session.
   * @param sessionId - Session identity.
   * @returns its account id, or undefined while no ownership record exists.
   */
  ownerOf(sessionId: SessionId): string | undefined {
    const record = this.domain.table('sessions').get(this.key(sessionId))
    return record === undefined ? undefined : record.ownerId ?? 'owner'
  }

  /** Drain writes before releasing storage.
   * @returns after storage is closed.
   */
  async close(): Promise<void> { await this.tail; await this.domain.close() }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const pending = this.tail.then(work)
    this.tail = pending.catch(() => {})
    return pending
  }

  private key(id: string): string { return `s-${Buffer.from(id, 'utf8').toString('hex')}` }
}

/** Explicit, directional permission to reach another account's agents. */
export class AccountGrants extends Service {
  /** @param ctx - plugin context.
   * @param domain - exclusively opened grant domain.
   */
  constructor(ctx: Context, private readonly domain: Domain<typeof shares>) { super(ctx, 'accountGrants') }

  /** Let one account address the granting account's agents.
   * @param ownerId - account that owns the shared agents.
   * @param granteeId - account admitted to reach them.
   * @returns after durable publication.
   */
  async grant(ownerId: string, granteeId: string): Promise<void> {
    await this.domain.table('grants').put(this.key(ownerId, granteeId), { ownerId, granteeId, createdAt: Date.now() })
  }

  /** Withdraw one grant; absent grants are a no-op.
   * @param ownerId - account that owns the shared agents.
   * @param granteeId - account losing access.
   * @returns after durable removal.
   */
  async revoke(ownerId: string, granteeId: string): Promise<void> {
    await this.domain.table('grants').delete(this.key(ownerId, granteeId))
  }

  /** Whether one account may reach another account's agents.
   * @param ownerId - account that owns the agents.
   * @param granteeId - candidate caller.
   * @returns true only for an explicit stored grant.
   */
  allows(ownerId: string, granteeId: string): boolean {
    return this.domain.table('grants').get(this.key(ownerId, granteeId)) !== undefined
  }

  /** Drain writes before releasing storage.
   * @returns after storage is closed.
   */
  async close(): Promise<void> { await this.domain.close() }

  private key(ownerId: string, granteeId: string): string {
    return `g-${Buffer.from(`${ownerId}\u0000${granteeId}`, 'utf8').toString('hex')}`
  }
}

/** Mount opt-in ownership without changing the published Session log format.
 * @param ctx - services for metadata, Session discovery and Remote policy registration.
 * @returns after existing Session ownership is ready for account callers.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(ownership)
  const owners = new SessionOwners(ctx, domain)
  ctx.effect(() => () => owners.close())
  const grantDomain = await ctx.storageDomain.open(shares)
  const grants = new AccountGrants(ctx, grantDomain)
  ctx.effect(() => () => grants.close())
  if (domain.quarantined('sessions').length > 0) throw new Error('Session ownership metadata is damaged; restore it before enabling account access')
  const ensure = (id: SessionId): void => {
    void owners.ensure(id).catch((error: unknown) => { ctx.logger.error(error) })
  }
  ctx.on('session/created', (session) => { ensure(session.id) })
  for (const record of await ctx.sessionQuery.listSessions()) await owners.ensure(record.header.id)
  const global: RemoteAccessRole<'global'> = {
    name: 'account:session-index', resource: 'global',
    actions: ['session/list', 'session/search', 'session/create', 'session/control'],
  }
  const session: RemoteAccessRole<'session'> = {
    name: 'account:own-session', resource: 'session',
    actions: remoteMethods(ctx.sessionController).map(method => `session/${method.method}` as const),
  }
  ctx.remoteAccess.registerPolicy('account', {
    bindings: principal => [
      { role: global, resource: { kind: 'global' } },
      ...owners.sessionsOf(principal.ownerId).map((id): RemoteAccessBinding => ({ role: session, resource: { kind: 'session', id } })),
    ],
  })
}
