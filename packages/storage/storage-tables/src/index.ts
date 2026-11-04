/**
 * Shared relational tables for agents (`ctx.tables`): one dedicated SQLite
 * database, single-statement SQL admission by the SQLite authorizer, atomic
 * writes, per-command deadlines and an audit trail without parameter values.
 * @module @deepseek-ai/dsh-storage-tables
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_LIMITS } from './engine.ts'
import type {
  AlterTableRequest, CreateTableRequest, DropTableRequest, EngineOptions, ExecuteRequest, ExecuteResult,
  QueryRequest, QueryResult, TableSchema, TableSummary,
} from './engine.ts'
import type { TablesError } from './errors.ts'
export { TablesError, type TablesErrorCode } from './errors.ts'
import { SqlRunner } from './runner.ts'
import type { Method } from './types.ts'

export * from './engine.ts'

/** Cordis plugin name. */
export const name = 'storage-tables'
/** The service needs no other service. */
export const inject: string[] = []

declare module '@deepseek-ai/cordis' {
  interface Context {
    tables: TablesService
  }
}

/** Plugin configuration. */
export interface Config {
  /** Database file; omitted means `<dshHome>/data/tables.sqlite`. */
  path?: string
  /** Harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Ceiling for the database file in bytes (default 256 MiB). */
  maxDbBytes?: number
  /** Ceiling for one bound text value in bytes (default 1 MiB). */
  maxValueBytes?: number
  /** Deadline for one command in milliseconds (default 5000). */
  commandTimeoutMs?: number
  /** SQLite busy timeout in milliseconds (default 3000). */
  busyTimeoutMs?: number
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  path: z.string(),
  dshHome: z.string(),
  maxDbBytes: z.number().default(DEFAULT_LIMITS.maxDbBytes),
  maxValueBytes: z.number().default(DEFAULT_LIMITS.maxValueBytes),
  commandTimeoutMs: z.number().default(5000),
  busyTimeoutMs: z.number().default(DEFAULT_LIMITS.busyTimeoutMs),
})

/** Who is calling and how to cancel. */
export interface CallContext {
  /** Id of the calling agent, stamped into `autor` and the audit trail. */
  readonly agent: string
  readonly signal?: AbortSignal
}

/** One audit record. It never holds parameter values. */
export interface AuditEvent {
  readonly agent: string
  readonly operation: Method
  /** SQL text of the command(s), when the operation carries any. */
  readonly sql?: readonly string[]
  readonly durationMs: number
  readonly ok: boolean
  readonly code?: string
}

const AUDIT_RING = 200

/** The `ctx.tables` service. */
export class TablesService {
  private readonly runner: SqlRunner
  private readonly ring: AuditEvent[] = []
  private readonly listeners = new Set<(event: AuditEvent) => void>()

  /**
   * @param config - validated plugin configuration.
   */
  constructor(config: Config) {
    const home = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const options: EngineOptions = {
      path: config.path ?? join(home, 'data', 'tables.sqlite'),
      maxDbBytes: config.maxDbBytes ?? DEFAULT_LIMITS.maxDbBytes,
      maxValueBytes: config.maxValueBytes ?? DEFAULT_LIMITS.maxValueBytes,
      busyTimeoutMs: config.busyTimeoutMs ?? DEFAULT_LIMITS.busyTimeoutMs,
    }
    this.runner = new SqlRunner(options, config.commandTimeoutMs ?? 5000)
  }

  /** Create a table. */
  createTable(request: CreateTableRequest, call: CallContext): Promise<TableSchema> {
    return this.invoke('createTable', [request, call.agent], call) as Promise<TableSchema>
  }

  /** List tables with creator and row count. */
  listTables(call: CallContext): Promise<TableSummary[]> {
    return this.invoke('listTables', [], call) as Promise<TableSummary[]>
  }

  /** Describe one table. */
  tableSchema(tabela: string, call: CallContext): Promise<TableSchema> {
    return this.invoke('tableSchema', [tabela], call) as Promise<TableSchema>
  }

  /** Add a column or an index. */
  alterTable(request: AlterTableRequest, call: CallContext): Promise<TableSchema> {
    return this.invoke('alterTable', [request, call.agent], call) as Promise<TableSchema>
  }

  /** Drop a table (needs `confirmar` equal to its name). */
  dropTable(request: DropTableRequest, call: CallContext): Promise<{ readonly tabela: string }> {
    return this.invoke('dropTable', [request, call.agent], call) as Promise<{ readonly tabela: string }>
  }

  /** Run one SELECT. */
  query(request: QueryRequest, call: CallContext): Promise<QueryResult> {
    return this.invoke('query', [request], call, [request.sql]) as Promise<QueryResult>
  }

  /** Run one INSERT, UPDATE or DELETE. */
  execute(request: ExecuteRequest, call: CallContext): Promise<ExecuteResult> {
    return this.invoke('execute', [request, call.agent], call, [request.sql]) as Promise<ExecuteResult>
  }

  /** Run several writes atomically. */
  batch(requests: readonly ExecuteRequest[], call: CallContext): Promise<ExecuteResult[]> {
    const sql = requests.map(request => request.sql)
    return this.invoke('batch', [requests, call.agent], call, sql) as Promise<ExecuteResult[]>
  }

  /** The most recent audit records, oldest first. */
  auditLog(): readonly AuditEvent[] {
    return [...this.ring]
  }

  /**
   * Observe audit records as they are produced.
   * @param listener - called for every finished command.
   * @returns a disposer.
   */
  onAudit(listener: (event: AuditEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Stop the SQL child process. */
  close(): Promise<void> {
    return this.runner.close()
  }

  private async invoke(method: Method, args: readonly unknown[], call: CallContext, sql?: readonly string[]): Promise<unknown> {
    const started = performance.now()
    const record = (ok: boolean, code?: string) => {
      const event: AuditEvent = {
        agent: call.agent,
        operation: method,
        ...sql === undefined ? {} : { sql },
        durationMs: Math.round(performance.now() - started),
        ok,
        ...code === undefined ? {} : { code },
      }
      this.ring.push(event)
      if (this.ring.length > AUDIT_RING) this.ring.shift()
      for (const listener of this.listeners) listener(event)
    }
    try {
      const value = await this.runner.call(method, args, call.signal)
      record(true)
      return value
    } catch (error) {
      record(false, (error as TablesError).code)
      throw error
    }
  }
}

/**
 * Provide `ctx.tables`; the disposer stops the SQL child process.
 * @param ctx - plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const service = new TablesService(config)
  ctx.provide('tables', service)
  ctx.effect(() => () => service.close(), 'storage-tables.close')
}
