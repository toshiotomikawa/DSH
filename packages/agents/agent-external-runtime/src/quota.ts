/** Durable refusal after an external quota failure; never retries a failed input. @module */
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const state = z.object({
  cause: z.enum(['quota_exhausted', 'teardown_failed', 'aborted']),
  resetAt: z.number().finite().positive().optional(),
  afterEffects: z.boolean(),
})

/** Separate per-record domain; keys encode both account and persistent identity. */
export const quotaDomain = defineDomain({ name: 'agent_external_quota', version: 1, layout: 'per-record', tables: {
  refusals: domainTable<string, z.infer<typeof state>>(state),
} })

/** Sanitized actionable failure, without provider payloads, paths or credentials. */
export class ExternalQuotaError extends Error {
  /** Stable failure identity for turn settlement; never interpreted as a native automatic retry. */
  get code(): string { return this.teardownFailed ? 'EXTERNAL_TEARDOWN_FAILED' : 'EXTERNAL_QUOTA_EXHAUSTED' }
  /**
   * @param resetAt - provider-reported Unix milliseconds; absent means manual resolution.
   * @param afterEffects - partial output or a tool prevents a reserve.
   * @param teardownFailed - quiescence was not confirmed.
   */
  constructor(readonly resetAt?: number, readonly afterEffects = false, readonly teardownFailed = false) {
    super(teardownFailed ? 'External teardown failed; activation remains refused'
      : 'External quota exhausted; this turn failed and was not retried')
    this.name = 'ExternalQuotaError'
  }
}

/** Owns durable refusals and live identity leases across external and reserve drivers. */
export class ExternalQuotaState {
  private readonly live = new Set<string>()
  /** @param domain - plugin-owned storage; closing the plugin does not erase refusals. */
  constructor(private readonly domain: Domain<typeof quotaDomain>) {}

  /** Encode an owner and persistent identity without delimiter collisions.
   * @param ownerId - authenticated owner.
   * @param agentId - persistent identity.
   * @returns collision-free storage key.
   */
  key(ownerId: string, agentId: string): string { return Buffer.from(JSON.stringify([ownerId, agentId])).toString('hex') }

  /** Exclude concurrent activations of one identity.
   * @param key - owned identity.
   * @returns release capability; retain it when teardown fails.
   */
  acquire(key: string): () => void {
    if (this.live.has(key)) throw new Error('External agent identity is still live')
    this.live.add(key)
    return () => { this.live.delete(key) }
  }

  /** Read the refusal without expiring an abort or failed teardown.
   * @param key - owned identity.
   * @returns active refusal, clearing only a clean quota timeout.
   */
  async get(key: string): Promise<z.infer<typeof state> | undefined> {
    const value = this.domain.table('refusals').get(key)
    if (value?.cause === 'quota_exhausted' && value.resetAt !== undefined && value.resetAt <= Date.now()) {
      await this.domain.table('refusals').delete(key)
      return undefined
    }
    return value
  }

  /** Persist failure before its turn settlement is published.
   * @param key - owned identity.
   * @param value - failure data, never an SDK payload.
   */
  async refuse(key: string, value: z.infer<typeof state>): Promise<void> {
    await this.domain.table('refusals').put(key, value)
  }

  /** Host-only explicit user recovery; a live handle can never be cleared.
   * @param key - authorized identity.
   */
  async clear(key: string): Promise<void> {
    if (this.live.has(key)) throw new Error('External agent identity is still live')
    await this.domain.table('refusals').delete(key)
  }
}
