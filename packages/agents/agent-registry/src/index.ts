/** Durable named agents, independent of their live session identities. @module */
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { ownerIdOf } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import sharp from 'sharp'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Stable identity of a persistent agent, distinct from SessionId. */
export type PersistentAgentId = Branded<'PersistentAgentId'>
/** Admit a durable agent id.
 * @param value - nonempty id.
 * @returns branded id.
 */
export function PersistentAgentId(value: string): PersistentAgentId {
  return brandString<PersistentAgentId>(z.string().min(1).parse(value))
}

const routeSchema = z.object({
  provider: z.string().min(1), model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}).strict()
const editableSchema = z.object({
  name: z.string().trim().min(1), title: z.string(), description: z.string(), instructions: z.string(), firstTask: z.string(),
  model: routeSchema, reserves: z.array(routeSchema), automaticFallback: z.boolean(), ownerId: z.string().optional(),
  sectionId: z.string().min(1).optional(),
}).strict()
const avatarInput = { avatarPath: z.string().optional(), avatarSeed: z.string().optional() }
const patchSchema = editableSchema.partial().extend({
  ...avatarInput, sectionId: z.string().min(1).nullable().optional(), model: routeSchema.partial().optional(),
}).refine(value => value.avatarPath === undefined || value.avatarSeed === undefined, 'Choose an image or generation, not both')
function profileFields(patch: z.infer<typeof patchSchema>) {
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => key !== 'avatarPath' && key !== 'avatarSeed' && value !== undefined))
}
const profileSchema = editableSchema.extend({
  id: z.string().transform(PersistentAgentId), revision: z.number().int().positive(), createdAt: z.number(), updatedAt: z.number(),
  avatar: z.object({ kind: z.enum(['generated', 'image']), value: z.string() }),
  permissions: z.object({ source: z.literal('deployment') }),
})
const bindingSchema = z.object({ agentId: z.string().transform(PersistentAgentId), ownerId: z.string().optional() })
const sectionSchema = z.object({
  id: z.string().min(1), name: z.string().trim().min(1).max(40), ownerId: z.string().optional(),
  revision: z.number().int().positive(), createdAt: z.number(), updatedAt: z.number(),
}).strict()
const sectionName = z.string().trim().min(1).max(40)
const agentsDomain = defineDomain({ name: 'agents', version: 1, layout: 'per-record', tables: {
  profiles: domainTable<PersistentAgentId, z.infer<typeof profileSchema>>(profileSchema),
  sessions: domainTable<string, z.infer<typeof bindingSchema>>(bindingSchema),
  sections: domainTable<string, z.infer<typeof sectionSchema>>(sectionSchema),
} })

/** Largest avatar document accepted from disk, before any decoding. */
const AVATAR_MAX_BYTES = 512 * 1024

/**
 * Durable document key for one session. The key is a path segment, and
 * Windows folds case, so the raw id would map `Ab` and `ab` to one file.
 * The encoding is injective: an id that is already a safe lowercase segment
 * keeps its readable form behind `r-`, and anything else (capitals, separators,
 * non-ASCII) is hex-encoded behind `h-`; the two prefixes keep the branches
 * disjoint.
 * @param id - live session id.
 * @returns path-safe, case-insensitive-safe key.
 */
function sessionKey(id: SessionId): string {
  const text = String(id)
  return /^[a-z0-9_-]+$/.test(text) ? `r-${text}` : `h-${Buffer.from(text, 'utf8').toString('hex')}`
}

/** Persisted agent configuration. Reservations never trigger a model switch. */
export type AgentProfile = z.infer<typeof profileSchema>
/** A flat sidebar group owned by one account; membership never grants access. */
export type AgentSection = z.infer<typeof sectionSchema>
/** Partial profile edit; omitted fields retain their current value. */
export type AgentPatch = z.input<typeof patchSchema>
/** Route inherited from the creator when creation fields are omitted. */
export type AgentRoute = z.infer<typeof routeSchema>

declare module '@deepseek-ai/cordis' { interface Context { persistentAgents: PersistentAgents } }
/** Cordis plugin name. */
export const name = 'agent-registry'
/** Services used for durable profiles and exact model validation. */
export const inject = ['storageDomain', 'llm', 'agents']

/** Registry owning profiles and durable session-to-agent metadata. */
export class PersistentAgents {
  /** Preserve the caller Context when this registry is accessed as a service. */
  readonly [symbols.tracker]: { property: string } = { property: 'ctx' }
  private bindingTail: Promise<void> = Promise.resolve()
  constructor(private readonly ctx: Context, private readonly domain: Domain<typeof agentsDomain>) {}

  /** Create without starting a turn.
   * @param input - profile fields.
   * @param inherited - creator's selection.
   * @returns durable profile.
   */
  async create(input: AgentPatch, inherited: AgentRoute): Promise<AgentProfile> {
    const patch = patchSchema.parse(input)
    const id = PersistentAgentId(randomUUID())
    const now = Date.now()
    const ownerId = this.ctx.invocation === undefined ? patch.ownerId ?? 'owner' : ownerIdOf(this.ctx.invocation)
    const profile = profileSchema.parse({
      title: '', description: '', instructions: '', firstTask: '', reserves: [], automaticFallback: false,
      ...profileFields(patch),
      ownerId,
      model: { ...inherited, ...patch.model }, id, revision: 1, createdAt: now, updatedAt: now,
      avatar: await this.avatar(patch, { kind: 'generated', value: id }),
      permissions: { source: 'deployment' },
    })
    await this.validateRoutes(profile)
    if (profile.sectionId !== undefined) this.requireSection(profile.sectionId, ownerId)
    await this.domain.table('profiles').put(id, profile)
    return structuredClone(profile)
  }

  /** Read a detached profile.
   * @param id - stable id.
   * @returns profile; throws when absent.
   */
  get(id: PersistentAgentId): AgentProfile {
    const profile = this.domain.table('profiles').get(id)
    if (!profile || !this.visible(profile)) throw new Error(`Unknown persistent agent: ${id}`)
    return structuredClone(profile)
  }

  /** List detached configurations, including stored fallback order.
   * @returns all profiles.
   */
  list(): AgentProfile[] {
    return [...this.domain.table('profiles').entries()]
      .map(([, profile]) => profile)
      .filter(profile => this.visible(profile)).map(profile => structuredClone(profile))
  }

  private visible(profile: AgentProfile): boolean {
    const principal = this.ctx.invocation?.peer.principal
    return principal?.kind !== 'account' || (profile.ownerId ?? 'owner') === principal.ownerId
  }

  /** Compare-and-set a partial edit.
   * @param id - stable id.
   * @param expectedRevision - last read revision.
   * @param input - changed fields.
   * @returns saved profile.
   */
  async update(id: PersistentAgentId, expectedRevision: number, input: AgentPatch): Promise<AgentProfile> {
    const patch = patchSchema.parse(input)
    const current = this.get(id)
    if (patch.ownerId !== undefined && patch.ownerId !== (current.ownerId ?? 'owner')) throw new Error('Agent owner cannot be changed')
    if (patch.sectionId !== undefined && patch.sectionId !== null) this.requireSection(patch.sectionId, current.ownerId ?? 'owner')
    if (current.revision !== expectedRevision) throw new Error('Agent revision conflict; read the profile again')
    const avatar = await this.avatar(patch, current.avatar)
    const fields: Record<string, unknown> = {
      ...current, ...profileFields(patch), model: { ...current.model, ...patch.model },
      avatar, revision: current.revision + 1, updatedAt: Date.now(),
    }
    if (patch.sectionId === null) delete fields.sectionId
    const next = profileSchema.parse(fields)
    await this.validateRoutes(next)
    const result = await this.domain.table('profiles').update(id, (stored) => {
      if (stored.revision !== expectedRevision) throw new Error('Agent revision conflict; read the profile again')
      return next
    })
    return structuredClone(result)
  }

  /** Edit each item independently.
   * @param edits - ids, revisions and partial edits.
   * @returns explicit per-item outcome.
   */
  async updateMany(
    edits: readonly { id: PersistentAgentId; revision: number; patch: AgentPatch }[],
  ): Promise<({ id: PersistentAgentId; profile: AgentProfile } | { id: PersistentAgentId; error: string })[]> {
    return Promise.all(edits.map(async (edit) => {
      try { return { id: edit.id, profile: await this.update(edit.id, edit.revision, edit.patch) } }
      catch (error) { return { id: edit.id, error: String(error) } }
    }))
  }

  /** Sidebar groups visible to the caller; membership never grants access.
   * @returns detached sections, oldest first.
   */
  listSections(): AgentSection[] {
    return [...this.domain.table('sections').entries()].map(([, section]) => section)
      .filter(section => this.visibleSection(section))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(section => structuredClone(section))
  }

  /** Create one sidebar group for the authenticated account.
   * @param name - display name, 1 to 40 characters.
   * @returns the stored section.
   */
  async createSection(name: string): Promise<AgentSection> {
    const section: AgentSection = {
      id: randomUUID(), name: sectionName.parse(name),
      ownerId: ownerIdOf(this.ctx.invocation), revision: 1, createdAt: Date.now(), updatedAt: Date.now(),
    }
    await this.domain.table('sections').put(section.id, section)
    return structuredClone(section)
  }

  /** Rename one visible section; agent membership and profile ids do not change.
   * @param id - section id.
   * @param name - new display name, 1 to 40 characters.
   * @returns the stored section.
   */
  async renameSection(id: string, name: string): Promise<AgentSection> {
    const parsed = sectionName.parse(name)
    const current = this.section(id)
    const next = sectionSchema.parse({ ...current, name: parsed, revision: current.revision + 1, updatedAt: Date.now() })
    const saved = await this.domain.table('sections').update(id, (stored) => {
      if (stored.revision !== current.revision) throw new Error('Section revision conflict; read the sections again')
      return next
    })
    return structuredClone(saved)
  }

  /** Delete one visible section; its agents survive and become ungrouped.
   * @param id - section id.
   * @returns the deleted id.
   */
  async deleteSection(id: string): Promise<{ id: string }> {
    this.section(id)
    // Ungroup members first: an interrupted delete then leaves no profile pointing at a missing section.
    for (const [, profile] of [...this.domain.table('profiles').entries()]) {
      if (profile.sectionId !== id) continue
      await this.domain.table('profiles').update(profile.id, (stored) => {
        // Merge over the record the write guard reads, so a concurrent edit is kept instead of overwritten.
        const fields: Record<string, unknown> = { ...stored, revision: stored.revision + 1, updatedAt: Date.now() }
        delete fields.sectionId
        return profileSchema.parse(fields)
      })
    }
    await this.domain.table('sections').delete(id)
    return { id }
  }

  /** Move one visible agent into a section, or remove its grouping with null.
   * @param agentId - profile id.
   * @param sectionId - visible section id, or null to ungroup.
   * @returns the saved profile.
   */
  async assignSection(agentId: PersistentAgentId, sectionId: string | null): Promise<AgentProfile> {
    const profile = this.get(agentId)
    if (sectionId !== null) this.requireSection(sectionId, profile.ownerId ?? 'owner')
    const fields: Record<string, unknown> = { ...profile, revision: profile.revision + 1, updatedAt: Date.now() }
    if (sectionId === null) delete fields.sectionId
    else fields.sectionId = sectionId
    const next = profileSchema.parse(fields)
    const saved = await this.domain.table('profiles').update(agentId, (stored) => {
      if (stored.revision !== profile.revision) throw new Error('Agent revision conflict; read the profile again')
      return next
    })
    return structuredClone(saved)
  }

  private section(id: string): AgentSection {
    const section = this.domain.table('sections').get(id)
    if (!section || !this.visibleSection(section)) throw new Error(`Unknown section: ${id}`)
    return section
  }

  private visibleSection(section: AgentSection): boolean {
    const principal = this.ctx.invocation?.peer.principal
    return principal?.kind !== 'account' || (section.ownerId ?? 'owner') === principal.ownerId
  }

  private requireSection(id: string, ownerId: string): void {
    const section = this.domain.table('sections').get(id)
    if (!section || (section.ownerId ?? 'owner') !== ownerId) throw new Error(`Unknown section: ${id}`)
  }

  /** Attach durable metadata without changing a Session header or its history.
   * @param sessionId - conversation id.
   * @param agentId - profile id.
   */
  async bind(sessionId: SessionId, agentId: PersistentAgentId): Promise<void> {
    const profile = this.get(agentId)
    const run = this.bindingTail.then(async () => {
      const previous = this.metadataOf(sessionId)
      if (previous && previous.agentId !== agentId) throw new Error('Session already belongs to a different persistent agent')
      await this.domain.table('sessions').put(sessionKey(sessionId), { agentId, ownerId: profile.ownerId ?? 'owner' })
      await this.ctx.get('sessionOwners')?.assign(sessionId, profile.ownerId ?? 'owner')
    })
    this.bindingTail = run.then(() => {}, () => {})
    await run
  }

  /** Read plugin-owned session metadata.
   * @param sessionId - conversation id.
   * @returns agentId and optional ownerId, or undefined.
   */
  metadataOf(sessionId: SessionId): { agentId: PersistentAgentId; ownerId?: string | undefined } | undefined {
    return structuredClone(this.domain.table('sessions').get(sessionKey(sessionId)))
  }

  /** Resolve the authenticated tool caller, never a model-supplied id.
   * @param agent - live caller.
   * @returns stable persistent id.
   */
  of(agent: Agent): PersistentAgentId {
    const binding = this.metadataOf(agent.id)
    if (!binding) throw new Error('This session has no persistent agent')
    return binding.agentId
  }

  /** Validate a selection again before session activation.
   * @param id - stable id.
   * @returns loop-compatible model selection.
   */
  async selection(id: PersistentAgentId): Promise<ModelSelection> {
    const profile = this.get(id)
    await this.validateRoutes(profile)
    const { provider, model, reasoningEffort } = profile.model
    return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }) }
  }

  private async validateRoutes(profile: AgentProfile): Promise<void> {
    if (profile.automaticFallback && profile.reserves.length === 0) {
      throw new Error('Automatic fallback consent requires at least one reserve')
    }
    for (const route of [profile.model, ...profile.reserves]) {
      const models = await this.ctx.llm.listModels(route.provider)
      if (!models.some(model => model.id === route.model)) throw new Error(`Unknown model: ${route.provider}/${route.model}`)
      const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model)
      if (route.reasoningEffort !== undefined && !info.reasoning?.efforts.some(effort => effort.id === route.reasoningEffort)) throw new Error(`Unsupported reasoning effort: ${route.reasoningEffort}`)
    }
  }

  private async avatar(input: z.infer<typeof patchSchema>, previous: AgentProfile['avatar']): Promise<AgentProfile['avatar']> {
    if (input.avatarSeed !== undefined) return { kind: 'generated', value: input.avatarSeed }
    if (input.avatarPath === undefined) return previous
    // One bounded read: the buffer caps what reaches memory, and a larger file
    // is detected by the extra byte rather than by reading all of it first.
    const file = await open(input.avatarPath, 'r')
    let bytes: Buffer
    try {
      const buffer = Buffer.alloc(AVATAR_MAX_BYTES + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > AVATAR_MAX_BYTES) throw new Error('Avatar exceeds 512 KB')
      bytes = buffer.subarray(0, bytesRead)
    } finally {
      await file.close()
    }
    const metadata = await sharp(bytes, { limitInputPixels: 16_777_216 }).metadata()
    if (!['png', 'jpeg', 'webp'].includes(metadata.format)) throw new Error('Avatar must be PNG, JPEG or WebP')
    await sharp(bytes, { limitInputPixels: 16_777_216 }).raw().toBuffer()
    return { kind: 'image', value: `data:image/${metadata.format};base64,${bytes.toString('base64')}` }
  }
}

/** Mount the registry and close its domain on unload.
 * @param ctx - injected services.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(agentsDomain)
  ctx.effect(() => () => domain.close())
  ctx.provide('persistentAgents', new PersistentAgents(ctx, domain))
}
