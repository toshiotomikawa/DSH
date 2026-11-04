/** Managed one-shot CLI lifecycle shared by the Grok and agy plugins. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assertUsableCwd, NO_START_CAPABILITIES, type ResolvedSubagentStartRequest, type SubagentResult, type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Deployment settings, never supplied by the model's tool arguments. */
export interface Config {
  /** Unique provider registry name. */
  providerName?: string
  /** Native executable; Windows deployments should use an exe, not a cmd shim. */
  command?: string
  /** Deployment-owned arguments inserted before the adapter arguments. */
  args?: string[]
  /** Native model fixed for this provider instance. */
  model?: string
  /** Non-interactive native permission policy. */
  permission?: 'allow' | 'reject'
  /** Explicit opt-ins layered over the credential-scrubbed parent environment. */
  env?: Record<string, string>
  /** Whole-run deadline in milliseconds. */
  timeoutMs?: number
  /** Managed process termination grace in milliseconds. */
  disposeGraceMs?: number
  /** Per-stream retained output and audit cap in bytes. */
  maxOutputBytes?: number
  /** Private absolute directory for per-run audit artifacts. */
  logDirectory: string
  /** Optional JSON status file containing remainingPercent. */
  quotaFile?: string
  /** Refuse before spawn when known remaining quota is below this floor. */
  minimumRemainingPercent?: number
}

/** Settings after deployment defaults have been applied. */
export type ResolvedConfig = Required<Omit<Config, 'model' | 'quotaFile'>> & Pick<Config, 'model' | 'quotaFile'>

/**
 * Resolve deployment defaults before lifecycle or argument construction.
 * @param config - deployment overrides.
 * @param providerName - native adapter's default registry and executable name.
 * @returns complete lifecycle settings.
 */
export function resolveConfig(config: Config, providerName: string): ResolvedConfig {
  return {
    providerName, command: providerName, args: [], permission: 'reject', env: {},
    timeoutMs: 120_000, disposeGraceMs: 3_000, maxOutputBytes: 4 * 1024 * 1024,
    minimumRemainingPercent: 10, ...config,
  }
}

/**
 * Build a schema for one native adapter.
 * @param providerName - default registry and executable name.
 * @returns the plugin configuration schema.
 */
export function configSchema(providerName: string): z<Config> {
  const defaults = resolveConfig({ logDirectory: '' }, providerName)
  return z.object({
    providerName: z.string().min(1).default(providerName),
    command: z.string().min(1).default(providerName),
    args: z.array(z.string()).default([]),
    model: z.string().min(1),
    permission: z.union(['reject', 'allow'] as const).default('reject'),
    env: z.dict(z.string()).default({}),
    timeoutMs: z.number().default(defaults.timeoutMs),
    disposeGraceMs: z.number().default(defaults.disposeGraceMs),
    maxOutputBytes: z.number().default(defaults.maxOutputBytes),
    logDirectory: z.string().required(),
    quotaFile: z.string(),
    minimumRemainingPercent: z.number().default(defaults.minimumRemainingPercent),
  })
}

/** Wire adapters return only the final assistant message and safe stop facts. */
export interface Product {
  name: string
  argv(config: ResolvedConfig, prompt: string): string[]
  parse(stdout: string): SubagentResult
}

/** File format: { remainingPercent: number }; unknown is allowed, corrupt is not. */
export async function quotaStatus(config: Config): Promise<number | undefined> {
  if (config.quotaFile === undefined) return undefined
  const data: unknown = JSON.parse(await readFile(config.quotaFile, 'utf8'))
  if (!isRecord(data) || typeof data.remainingPercent !== 'number'
    || !Number.isFinite(data.remainingPercent) || data.remainingPercent < 0 || data.remainingPercent > 100) {
    throw new Error('Invalid quota status')
  }
  return data.remainingPercent
}

/** Narrow untrusted CLI JSON before reading protocol fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Fixed diagnostics deliberately exclude native stderr and environment values. */
export function failure(reason: string): SubagentResult {
  return { output: [], stopReason: 'error', diagnostic: `Headless subagent: ${reason}` }
}

/** Recognize provider-authored limit states; never retry a billable operation. */
export function quotaExceeded(text: string): boolean {
  return /quota[_ -]?(exceeded|exhausted)|rate[_ -]?limit|usage[_ -]?limit|insufficient[_ -]?(credits|quota)/i.test(text)
}

/** Register a native adapter without changing the subagent or subprocess core. */
export function register(ctx: Context, input: Config, product: Product): void {
  const config = resolveConfig(input, product.name)
  for (const field of ['timeoutMs', 'disposeGraceMs', 'maxOutputBytes'] as const) {
    if (!Number.isSafeInteger(config[field]) || config[field] <= 0 || config[field] > MAX_TIMER_DELAY_MS) {
      throw new Error(`${product.name}: invalid ${field}`)
    }
  }
  if (!isAbsolute(config.logDirectory)) throw new Error(`${product.name}: logDirectory must be absolute`)
  if (!Number.isFinite(config.minimumRemainingPercent) || config.minimumRemainingPercent < 0 || config.minimumRemainingPercent > 100) {
    throw new Error(`${product.name}: invalid minimumRemainingPercent`)
  }
  const provider: SubagentProvider = {
    name: config.providerName,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    start: request => start(request, config, product, spec => ctx.subprocess.spawn(spec), (message) =>{  ctx.logger.warn(message) }),
  }
  ctx.subagents.registerProvider(provider)
}

/** Start one managed process. Its streams remain private audit artifacts. */
export async function start(
  request: ResolvedSubagentStartRequest,
  config: ResolvedConfig,
  product: Product,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  warn: (message: string) => void,
) {
  if (isAborted(request.signal)) throw new Error('Headless subagent: cancelled before startup')
  const cwd = assertUsableCwd(product.name, 'cwd', request.cwd)
  const parts: string[] = []
  for (const block of request.prompt) {
    if (block.type !== 'text') throw new Error('Headless subagent: text prompt required')
    parts.push(block.text)
  }
  const prompt = parts.join('\n')
  const id = SessionId(randomUUID())
  let remaining: number | undefined
  try { remaining = await quotaStatus(config) }
  catch { throw new Error('Headless subagent: quota status unavailable or invalid') }
  if (remaining !== undefined && remaining < config.minimumRemainingPercent) {
    return { id, result: Promise.resolve(failure('cota_baixa')), dispose: async () => {} }
  }
  if (remaining === undefined) warn(`${product.name}: quota unknown (no checker configured)`)
  await mkdir(config.logDirectory, { recursive: true, mode: 0o700 })
  // Reserve the log before starting a potentially billable child.
  const logPath = join(config.logDirectory, `${id}.json`)
  await writeFile(logPath, JSON.stringify({ product: product.name, state: 'starting' }), { flag: 'wx', mode: 0o600 })
  if (isAborted(request.signal)) throw new Error('Headless subagent: cancelled before startup')
  const signal = new AbortController()
  const flags = { timedOut: false, cancelled: false, closed: false }
  const onAbort = () => { flags.cancelled = true; signal.abort() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  let child: SubprocessHandle
  try {
    child = spawn({
      argv: [config.command, ...config.args, ...product.argv(config, prompt)],
      cwd, env: config.env, signal: signal.signal, graceMs: config.disposeGraceMs,
      stdio: { stdin: 'ignore', stdout: { maxBytes: config.maxOutputBytes }, stderr: { maxBytes: config.maxOutputBytes } },
    })
  } catch {
    request.signal.removeEventListener('abort', onAbort)
    throw new Error('Headless subagent: process startup failed')
  }
  const timer = setTimeout(() => { flags.timedOut = true; signal.abort() }, config.timeoutMs)
  const result = (async (): Promise<SubagentResult> => {
    try {
      const outcome = await child.done
      // A CLI may exit while a tool it spawned remains alive: reap the whole range.
      child.terminate()
      await child.waitForExit()
      // Both streams were requested in collect mode above.
      const stdout = (child.collected.stdout as SubprocessOutputReader).readFrom(0)
      const stderr = (child.collected.stderr as SubprocessOutputReader).readFrom(0)
      await writeFile(logPath, JSON.stringify({
        product: product.name, outcome, stdout: stdout.text, stderr: stderr.text, truncated: stdout.lossy || stderr.lossy,
      }), { mode: 0o600 })
      if (flags.timedOut) return failure('tempo_esgotado')
      if (flags.cancelled) return { output: [], stopReason: 'aborted' }
      if (stdout.lossy) return failure('output limit exceeded')
      if (quotaExceeded(stderr.text)) return failure('cota_esgotada')
      const parsed = product.parse(stdout.text)
      if (outcome.exitCode !== 0) return { output: [], stopReason: 'error', diagnostic: parsed.diagnostic ?? 'Headless subagent: process failed' }
      return parsed
    } catch {
      child.terminate()
      try { await child.waitForExit() }
      catch { warn(`${product.name}: process cleanup failed; managed range status unknown`) }
      if (flags.timedOut) return failure('tempo_esgotado')
      return flags.cancelled ? { output: [], stopReason: 'aborted' } : failure('process, protocol or audit failure')
    } finally {
      flags.closed = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
    }
  })()
  let disposal: Promise<void> | undefined
  return {
    id, result,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      if (!flags.closed) onAbort()
      child.terminate()
      disposal = (async () => { await result; await child.waitForExit() })()
      return disposal
    },
  }
}

/** Read cancellation again after asynchronous preparation. */
function isAborted(signal: AbortSignal): boolean { return signal.aborted }
