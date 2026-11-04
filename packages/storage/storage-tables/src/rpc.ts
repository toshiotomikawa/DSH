/**
 * Message contract between the service and its SQL Worker.
 * @module @deepseek-ai/dsh-storage-tables/rpc
 */

import type { EngineOptions } from './engine.ts'
import type { SerializedTablesError } from './errors.ts'

/** Engine methods reachable through the Worker. */
export const METHODS = ['createTable', 'listTables', 'tableSchema', 'alterTable', 'dropTable', 'query', 'execute', 'batch'] as const
/** One of {@link METHODS}. */
export type Method = typeof METHODS[number]

/** Worker start-up data. */
export type WorkerStart = EngineOptions

/** Request posted to the Worker. */
export interface WorkerRequest {
  readonly method: Method
  readonly args: readonly unknown[]
}

/** Reply posted by the Worker. */
export type WorkerReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: SerializedTablesError }
