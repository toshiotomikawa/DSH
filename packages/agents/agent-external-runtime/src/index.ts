/** Host-owned harness directories for persistent external agents. @module */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { HarnessBindingError } from './errors.ts'
import { ExternalAgentActivationService } from './driver.ts'

export { HarnessAdapterError, HarnessBindingError } from './errors.ts'
export { createClaudeSdk } from './claude.ts'
export type { ClaudeQueryFactory, ClaudeQueryOptions, ClaudeSpawnOptions } from './claude.ts'
export type { ExternalSdk, ExternalTurnInput } from './driver.ts'
import type {} from '@deepseek-ai/dsh-agent-registry'
import type {} from '@deepseek-ai/dsh-agent-runtime'
import type {} from '@deepseek-ai/dsh-agent-runtime/accounts'
import type {} from '@deepseek-ai/dsh-agent-runtime/owners'

/** Private Host association; never serialize it to prompts, tool results or Session events. */
export interface AccountHarnessBinding {
  /** Account whose official harness login owns this directory. */
  accountId: string
  /** Official harness selected for this binding. */
  runtime: 'claude-sdk' | 'codex-sdk'
  /** Canonical local directory outside every agent workspace. */
  configDirectory: string
  /** Increment when rebinding or changing the harness login. */
  revision: number
}
/** Explicit Host configuration; directories are never discovered from the environment. */
export interface Config {
  /** One directory per account and external runtime, outside every agent workspace. */
  bindings: AccountHarnessBinding[]
}
/** Validated deployment bindings; no model-facing configuration operation exists. */
export const Config: s<Config> = s.object({ bindings: s.array(s.object({
  accountId: s.string().required(), runtime: s.union(['claude-sdk', 'codex-sdk']).required(),
  configDirectory: s.string().required(), revision: s.number().min(1).step(1).required(),
})).default([]) })
const bindingSchema = z.object({
  accountId: z.string().min(1), runtime: z.enum(['claude-sdk', 'codex-sdk']),
  configDirectory: z.string().min(1), revision: z.number().int().positive(),
}).strict()

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}
async function directory(path: string): Promise<string> {
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.startsWith('//')) throw new HarnessBindingError('binding_invalid')
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(path)) throw new HarnessBindingError('binding_invalid')
  try {
    const resolved = await realpath(path)
    if (resolved.startsWith('\\\\') || resolved.startsWith('//') || !(await stat(resolved)).isDirectory()) throw new Error('Not a local directory')
    return resolved
  } catch (_error) {
    // Do not expose a harness path or filesystem cause to model-facing callers.
    throw new HarnessBindingError('binding_invalid')
  }
}

declare module '@deepseek-ai/cordis' { interface Context { harnessBindings: HarnessBindings } }

/** Immutable deployment bindings, resolved again against current identity on every activation. */
export class HarnessBindings {
  constructor(private readonly ctx: Context, private readonly bindings: readonly AccountHarnessBinding[]) {}

  /** Resolve only the owner recorded by the registry and Session sidecar.
   * @param sessionId - durably bound DSH conversation.
   * @param workspace - actual workspace of the agent; overlapping harness folders are refused.
   * @returns detached private Host binding; never put it in a tool result or prompt.
   */
  async resolve(sessionId: SessionId, workspace: string): Promise<AccountHarnessBinding> {
    const metadata = this.ctx.persistentAgents.metadataOf(sessionId)
    if (!metadata) throw new HarnessBindingError('owner_mismatch')
    const profile = this.ctx.persistentAgents.get(metadata.agentId)
    const owner = profile.ownerId ?? 'owner'
    if ((metadata.ownerId ?? 'owner') !== owner || this.ctx.sessionOwners.ownerOf(sessionId) !== owner) throw new HarnessBindingError('owner_mismatch')
    if (owner !== 'owner' && !this.ctx.accounts.list().some(account => account.id === owner && account.state === 'active')) throw new HarnessBindingError('account_inactive')
    if (profile.runtime === 'native') throw new HarnessBindingError('runtime_native')
    const binding = this.bindings.find(entry => entry.accountId === owner && entry.runtime === profile.runtime)
    if (!binding) throw new HarnessBindingError('binding_missing')
    const canonical = await directory(binding.configDirectory)
    if (canonical !== binding.configDirectory) throw new HarnessBindingError('binding_stale')
    const root = await directory(workspace)
    if (this.bindings.some(entry => contains(root, entry.configDirectory) || contains(entry.configDirectory, root))) throw new HarnessBindingError('binding_conflict')
    return { ...binding }
  }
}

/** Cordis plugin name. */
export const name = 'agent-external-runtime'
/** Identity is checked using the authoritative services, never caller-supplied owner ids. */
export const inject = ['persistentAgents', 'sessionOwners', 'accounts']
/** Validate all directories before publishing; no SDK import, credential read or process starts here.
 * @param ctx - trusted Host context.
 * @param config - explicit deployment bindings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const bindings: Config['bindings'] = []
  for (const input of z.array(bindingSchema).parse(config.bindings)) {
    const entry = { ...input, configDirectory: await directory(input.configDirectory) }
    for (const previous of bindings) {
      if ((previous.accountId === entry.accountId && previous.runtime === entry.runtime)
        || (previous.accountId !== entry.accountId && (contains(previous.configDirectory, entry.configDirectory) || contains(entry.configDirectory, previous.configDirectory)))) throw new HarnessBindingError('binding_conflict')
    }
    bindings.push(entry)
  }
  const resolved = new HarnessBindings(ctx, bindings)
  if (ctx.get('harnessBindings') === undefined) {
    ctx.provide('harnessBindings', resolved)
    ctx.provide('externalAgentActivation', new ExternalAgentActivationService())
    return
  }
  // A later apply on the same fiber replaces the deployment copy. The first
  // provide owns the service slot, so a second provide is rejected.
  ctx.harnessBindings = resolved
}
