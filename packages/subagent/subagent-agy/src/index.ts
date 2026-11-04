/** One-shot Antigravity CLI provider using native authentication and NDJSON. */
import type { Context } from '@deepseek-ai/cordis'
import { configSchema, failure, isRecord, quotaExceeded, register, type HeadlessConfig, type Product } from '@deepseek-ai/dsh-subagent-grok'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'

export const name = 'subagent-agy'
export const inject = ['subagents', 'subprocess']
export type Config = HeadlessConfig
export const Config = configSchema('agy')

/** Require exactly one terminal result; intermediate tool output never reaches the parent. */
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
  if (terminal.status === 'REFUSED') return { output: [], stopReason: 'refusal' }
  if (terminal.status === 'MAX_TOKENS') return { output: [], stopReason: 'max-tokens' }
  if (terminal.status !== 'SUCCESS' || typeof terminal.response !== 'string' || terminal.response.length === 0) return failure('agy failed')
  return { output: [{ type: 'text', text: terminal.response }], stopReason: 'completed' }
}

export const product: Product = {
  name: 'agy', parse,
  argv: (config, prompt) => [
    '--print', prompt, '--output-format', 'stream-json', '--disable-slash-commands',
    ...config.permission === 'allow' ? ['--dangerously-skip-permissions'] : ['--mode', 'plan'],
    ...config.model === undefined ? [] : ['--model', config.model],
  ],
}

/** Register one independently configured native model instance. */
export function apply(ctx: Context, config: Config): void { register(ctx, config, product) }
