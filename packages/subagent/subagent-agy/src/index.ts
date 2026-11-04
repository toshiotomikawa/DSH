/** One-shot Antigravity CLI provider using native authentication and NDJSON. */
import type { Context } from '@deepseek-ai/cordis'
import { Config as SharedConfig, failure, isRecord, quotaAnswer, quotaExceeded, register, type Product } from '@deepseek-ai/dsh-subagent-grok'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'

export const name = 'subagent-agy'
export const inject = ['subagents', 'subprocess']
/** Loader configuration for one Antigravity provider instance, sharing the native adapter fields. */
export type Config = SharedConfig
/** Loader schema shared with the other native adapter. */
export const Config = SharedConfig

/**
 * Require exactly one terminal result; intermediate tool output never reaches the parent.
 * @param stdout - complete process stdout in NDJSON.
 * @returns the final result or a fixed failure.
 */
export function parse(stdout: string): SubagentResult {
  let terminal: Record<string, unknown> | undefined
  for (const line of stdout.split(/\r?\n/).filter(line => line.trim())) {
    const data: unknown = JSON.parse(line)
    if (!isRecord(data) || typeof data.event !== 'string') return failure('invalid agy event')
    if (data.event === 'result') {
      if (terminal !== undefined || !isRecord(data.result)) return failure('invalid agy result')
      terminal = data.result
    }
  }
  if (terminal === undefined) return failure('missing agy result')
  if (typeof terminal.status === 'string' && quotaExceeded(terminal.status)) return failure('cota_esgotada')
  if (typeof terminal.error === 'string' && quotaExceeded(terminal.error)) return failure('cota_esgotada')
  if (typeof terminal.response === 'string' && quotaAnswer(terminal.response)) return failure('cota_esgotada')
  if (terminal.status === 'REFUSED') return { output: [], stopReason: 'refusal' }
  if (terminal.status === 'MAX_TOKENS') return { output: [], stopReason: 'max-tokens' }
  if (terminal.status !== 'SUCCESS' || typeof terminal.response !== 'string' || terminal.response.length === 0) return failure('agy failed')
  return { output: [{ type: 'text', text: terminal.response }], stopReason: 'completed' }
}

/** Antigravity protocol: NDJSON stream and an optional bypass flag only when explicitly allowed. */
export const product: Product = {
  name: 'agy', parse,
  argv: (config, prompt) => [
    '--print', prompt, '--output-format', 'stream-json', '--disable-slash-commands',
    ...config.permission === 'allow' ? ['--dangerously-skip-permissions'] : [],
    ...config.model === undefined ? [] : ['--model', config.model],
  ],
}

/**
 * Register one independently configured native model instance.
 * @param ctx - context carrying the subagent and subprocess services.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void { register(ctx, config, product) }
