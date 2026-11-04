/** One-shot Grok Build provider using native authentication and JSON output. */
import type { Context } from '@deepseek-ai/cordis'
import { failure, isRecord, quotaAnswer, quotaExceeded, register, sharedConfigSchema, type Product } from './headless.ts'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
export { failure, isRecord, quotaAnswer, quotaExceeded, register } from './headless.ts'
export type { Product } from './headless.ts'

export const name = 'subagent-grok'
export const inject = ['subagents', 'subprocess']

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

/** Loader schema for one Grok provider instance. */
export const Config = sharedConfigSchema

/**
 * Parse the documented whole-result JSON, without exposing thought/tool events.
 * @param stdout - complete process stdout.
 * @returns the final result or a fixed failure.
 */
export function parse(stdout: string): SubagentResult {
  const data: unknown = JSON.parse(stdout)
  if (!isRecord(data)) return failure('invalid Grok result')
  const reason = data.stopReason
  if (typeof reason === 'string' && quotaExceeded(reason)) return failure('cota_esgotada')
  if (typeof data.error === 'string' && quotaExceeded(data.error)) return failure('cota_esgotada')
  if (typeof data.text === 'string' && quotaAnswer(data.text)) return failure('cota_esgotada')
  if (reason === 'refusal') return { output: [], stopReason: 'refusal' }
  if (reason === 'max_tokens') return { output: [], stopReason: 'max-tokens' }
  if (reason !== 'end_turn' || typeof data.text !== 'string' || data.text.length === 0 || data.error) return failure('invalid Grok result')
  return { output: [{ type: 'text', text: data.text }], stopReason: 'completed' }
}

/** Grok protocol: whole-result JSON and a non-interactive permission mode. */
export const product: Product = {
  name: 'grok', parse,
  argv: (config, prompt) => [
    '-p', prompt, '--output-format', 'json', '--permission-mode', config.permission === 'allow' ? 'bypassPermissions' : 'dontAsk',
    '--disable-web-search', '--no-subagents',
    ...config.model === undefined ? [] : ['--model', config.model],
  ],
}

/**
 * Register one independently configured native model instance.
 * @param ctx - context carrying the subagent and subprocess services.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void { register(ctx, config, product) }
