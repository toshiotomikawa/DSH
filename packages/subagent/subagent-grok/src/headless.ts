/** Managed one-shot CLI lifecycle shared by the Grok and agy plugins. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assertUsableCwd, NO_START_CAPABILITIES, type ResolvedSubagentStartRequest, type SubagentResult, type SubagentProvider, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Config } from './index.ts'

/** Ceiling for the per-stream retained output, independent of the timer limit. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Ambient variables a native CLI needs to find itself and its own sign-in; everything else is removed. */
const ALLOWED_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'USERNAME', 'USER',
  'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
])

/**
 * Child environment as a closed list: every ambient entry outside the allowlist is tombstoned (an `undefined`
 * value removes it from the inherited base), then the deployment's explicit entries are layered on top.
 * @param config - resolved deployment settings.
 * @returns entries for the spawn spec's `env`.
 */
export function childEnvironment(config: ResolvedConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(process.env)) {
    if (!ALLOWED_ENV.has(key.toUpperCase())) env[key] = undefined
  }
  return { ...env, ...config.env }
}

/**
 * Keep the task text from ever being read as a command-line flag: a leading dash gets a leading space.
 * @param prompt - task text.
 * @returns the text to place in argv.
 */
export function safePrompt(prompt: string): string {
  return prompt.startsWith('-') ? ` ${prompt}` : prompt
}

/**
 * Resolve the executable. Windows runs only real `.exe`/`.com` files: a `.cmd` or `.bat` shim cannot be spawned
 * without a shell and a shell would reopen argument injection, so shims are refused and bare names are searched
 * for an executable on PATH.
 * @param command - configured command.
 * @param platform - host platform.
 * @param path - PATH value used for the lookup.
 * @returns the command to spawn.
 * @throws when no real executable can be found on Windows.
 */
export function resolveCommand(command: string, platform: NodeJS.Platform = process.platform, path = String(process.env.PATH)): string {
  if (platform !== 'win32') return command
  const extension = extname(command).toLowerCase()
  if (extension === '.exe' || extension === '.com') return command
  const names = ['.exe', '.com'].map(suffix => `${command}${suffix}`)
  const hasDirectory = /[\\/]/.test(command)
  const directories = hasDirectory ? [''] : path.split(delimiter).filter(entry => entry !== '')
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory === '' ? name : join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('Headless subagent: executable not found (Windows needs a .exe, not a .cmd shim)')
}

/** Test seam for the platform-dependent executable lookup. */
export interface Dependencies {
  resolve?: (command: string) => string
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
    args: [], permission: 'reject', env: {},
    timeoutMs: 120_000, disposeGraceMs: 3_000, maxOutputBytes: 4 * 1024 * 1024,
    minimumRemainingPercent: 10,
    // oxlint-disable-next-line typescript/no-misused-spread -- Config is a plain deployment object, not a class instance
    ...config,
    providerName: config.providerName ?? providerName,
    command: config.command ?? providerName,
  }
}

/**
 * Loader schema shared by the native adapters. Provider-specific defaults are
 * applied by {@link resolveConfig}, so the schema stays statically walkable.
 */
export const sharedConfigSchema: z<Config> = z.object({
  providerName: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  model: z.string().min(1),
  permission: z.union(['reject', 'allow'] as const).default('reject'),
  env: z.dict(z.string()).default({}),
  timeoutMs: z.number().default(120_000),
  disposeGraceMs: z.number().default(3_000),
  maxOutputBytes: z.number().default(4 * 1024 * 1024),
  logDirectory: z.string().required(),
  quotaFile: z.string(),
  minimumRemainingPercent: z.number().default(10),
})

/** Wire adapters return only the final assistant message and safe stop facts. */
export interface Product {
  name: string
  argv(config: ResolvedConfig, prompt: string): string[]
  parse(stdout: string): SubagentResult
}

/**
 * Read the optional quota status file; the format is `{ remainingPercent }`, where an absent file is unknown and a corrupt one is an error.
 * @param config - deployment settings naming the file.
 * @returns remaining percent, or undefined when no file is configured.
 * @throws when the file is unreadable or outside 0-100.
 */
export async function quotaStatus(config: Config): Promise<number | undefined> {
  if (config.quotaFile === undefined) return undefined
  const data: unknown = JSON.parse(await readFile(config.quotaFile, 'utf8'))
  if (!isRecord(data) || typeof data.remainingPercent !== 'number'
    || !Number.isFinite(data.remainingPercent) || data.remainingPercent < 0 || data.remainingPercent > 100) {
    throw new Error('Invalid quota status')
  }
  return data.remainingPercent
}

/**
 * Narrow untrusted CLI JSON before reading protocol fields.
 * @param value - parsed JSON value.
 * @returns whether the value is a plain object record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build a fixed diagnostic without native stderr or environment values.
 * @param reason - stable diagnostic identifier.
 * @returns an error result carrying the diagnostic.
 */
export function failure(reason: string): SubagentResult {
  return { output: [], stopReason: 'error', diagnostic: `Headless subagent: ${reason}` }
}

/**
 * Recognize provider-authored limit states; never retry a billable operation.
 * @param text - provider-authored text.
 * @returns whether the text names a quota or limit state.
 */
export function quotaExceeded(text: string): boolean {
  return /quota[_ -]?(exceeded|exhausted)|rate[_ -]?limit|usage[_ -]?limit|insufficient[_ -]?(credits|quota)/i.test(text)
}

/**
 * A limit notice delivered as the answer itself: short text that reads like a quota message.
 * Long answers that merely discuss limits are real answers.
 * @param text - final assistant text.
 * @returns whether the text is a limit notice.
 */
export function quotaAnswer(text: string): boolean {
  return text.length <= 200 && quotaExceeded(text)
}

/**
 * Register a native adapter without changing the subagent or subprocess core.
 * @param ctx - context carrying the subagent and subprocess services.
 * @param input - deployment configuration.
 * @param product - provider-specific protocol and argv.
 * @throws when a configured limit or path is invalid.
 */
export function register(ctx: Context, input: Config, product: Product): void {
  const config = resolveConfig(input, product.name)
  for (const field of ['timeoutMs', 'disposeGraceMs'] as const) {
    if (!Number.isSafeInteger(config[field]) || config[field] <= 0 || config[field] > MAX_TIMER_DELAY_MS) {
      throw new Error(`${product.name}: invalid ${field}`)
    }
  }
  if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes <= 0 || config.maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`${product.name}: invalid maxOutputBytes`)
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(config.command)) {
    throw new Error(`${product.name}: command must be a real executable, not a .cmd or .bat shim`)
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

/**
 * Start one managed process; its streams remain private audit artifacts.
 * @param request - resolved subagent start request.
 * @param config - complete lifecycle settings.
 * @param product - provider-specific protocol and argv.
 * @param spawn - subprocess factory.
 * @param warn - deployment warning sink.
 * @param dependencies - test seams for platform-dependent lookups.
 * @returns the managed run handle.
 */
export async function start(
  request: ResolvedSubagentStartRequest,
  config: ResolvedConfig,
  product: Product,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  warn: (message: string) => void,
  dependencies: Dependencies = {},
): Promise<SubagentRun> {
  const resolve = dependencies.resolve ?? ((command: string) => resolveCommand(command))
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
      argv: [resolve(config.command), ...config.args, ...product.argv(config, safePrompt(prompt))],
      cwd, env: childEnvironment(config), signal: signal.signal, graceMs: config.disposeGraceMs,
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
      if (stdout.lossy) return flags.cancelled ? { output: [], stopReason: 'aborted' } : failure('output limit exceeded')
      let parsed: SubagentResult | undefined
      try { parsed = product.parse(stdout.text) } catch { parsed = undefined }
      // A complete final answer from a clean exit stands, whatever stderr mentions and even if cancel raced it.
      if (parsed?.stopReason === 'completed' && outcome.exitCode === 0) return parsed
      if (flags.cancelled) return { output: [], stopReason: 'aborted' }
      if (quotaExceeded(stderr.text)) return failure('cota_esgotada')
      if (parsed === undefined) throw new Error('unparseable result')
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
