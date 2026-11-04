/** One-shot Grok Build provider using native authentication and JSON output. */
import type { Context } from '@deepseek-ai/cordis'
import { configSchema, failure, isRecord, quotaExceeded, register, type Config as HeadlessConfig, type Product } from './headless.ts'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
export { configSchema, failure, isRecord, quotaExceeded, register } from './headless.ts'
export type { Config as HeadlessConfig, Product } from './headless.ts'

export const name = 'subagent-grok'
export const inject = ['subagents', 'subprocess']
export type Config = HeadlessConfig
export const Config = configSchema('grok')

/** Parse the documented whole-result JSON, without exposing thought/tool events. */
export function parse(stdout: string): SubagentResult {
  const data: unknown = JSON.parse(stdout)
  if (!isRecord(data)) return failure('invalid Grok result')
  const reason = data.stopReason
  if (typeof reason === 'string' && quotaExceeded(reason)) return failure('cota_esgotada')
  if (typeof data.error === 'string' && quotaExceeded(data.error)) return failure('cota_esgotada')
  if (reason === 'refusal') return { output: [], stopReason: 'refusal' }
  if (reason === 'max_tokens') return { output: [], stopReason: 'max-tokens' }
  if (reason !== 'end_turn' || typeof data.text !== 'string' || data.text.length === 0 || data.error) return failure('invalid Grok result')
  return { output: [{ type: 'text', text: data.text }], stopReason: 'completed' }
}

export const product: Product = {
  name: 'grok', parse,
  argv: (config, prompt) => [
    '-p', prompt, '--output-format', 'json', '--permission-mode', config.permission === 'allow' ? 'bypassPermissions' : 'dontAsk',
    '--disable-web-search', '--no-subagents',
    ...config.model === undefined ? [] : ['--model', config.model],
  ],
}

/** Register one independently configured native model instance. */
export function apply(ctx: Context, config: Config): void { register(ctx, config, product) }
