/**
 * Typed failures of the shared-tables engine. The `code` is stable and
 * model-visible; `details` carries machine-readable context (similar table
 * names, failing command index, retry advice).
 * @module @deepseek-ai/dsh-storage-tables/errors
 */

/** Stable failure codes. */
export type TablesErrorCode =
  | 'nome_invalido'
  | 'ja_existe'
  | 'nao_existe'
  | 'argumento_invalido'
  | 'sql_recusado'
  | 'sem_where'
  | 'confirmacao'
  | 'restricao'
  | 'valor_grande'
  | 'banco_cheio'
  | 'ocupado'
  | 'cancelado'
  | 'interno'

/** A failure the caller can act on. */
export class TablesError extends Error {
  readonly code: TablesErrorCode
  readonly details: Readonly<Record<string, unknown>>

  /**
   * @param code - stable failure code.
   * @param message - explanation shown to the model.
   * @param details - optional machine-readable context.
   */
  constructor(code: TablesErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'TablesError'
    this.code = code
    this.details = details
  }
}

/** Plain-data form of a {@link TablesError}, safe to cross a process boundary. */
export interface SerializedTablesError {
  readonly code: TablesErrorCode
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/**
 * Flatten any thrown value into its transferable form.
 * @param error - a thrown value.
 * @returns the plain error; non-{@link TablesError} values become `interno`.
 */
export function serializeError(error: unknown): SerializedTablesError {
  if (error instanceof TablesError) return { code: error.code, message: error.message, details: error.details }
  return { code: 'interno', message: error instanceof Error ? error.message : String(error), details: {} }
}

/**
 * Rebuild a {@link TablesError} from its transferable form.
 * @param value - serialized error.
 * @returns the error instance.
 */
export function deserializeError(value: SerializedTablesError): TablesError {
  return new TablesError(value.code, value.message, value.details)
}
