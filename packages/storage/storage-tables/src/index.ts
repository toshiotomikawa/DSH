/**
 * Shared relational tables for agents (`ctx.tables`): one dedicated SQLite
 * database, single-statement SQL admission by the SQLite authorizer, atomic
 * writes, per-command deadlines and an audit trail without parameter values.
 * @module @deepseek-ai/dsh-storage-tables
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_LIMITS } from './engine.ts'
import type {
  AlterTableRequest, CreateTableRequest, DropTableRequest, EngineOptions, ExecuteRequest, ExecuteResult,
  QueryRequest, QueryResult, TableSchema, TableSummary,
} from './engine.ts'
import { TablesError } from './errors.ts'
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
  /** Database file; omitted means `<dshHome>/data/tables-shared.sqlite`. */
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
  /** Authenticated account owning the call; omitted means the single host account. */
  readonly ownerId?: string
  /** Database scope this call addresses when it names one; omitted derives from the owner. */
  readonly scope?: TableScope
  readonly signal?: AbortSignal
}

/** One database file: the shared file or one account's private file. */
export type TableScope = 'privada' | 'compartilhada'

/** Path segment for one owner: readable when already safe, otherwise injective hex behind `~`. */
function ownerSegment(ownerId: string): string {
  return /^[a-z0-9_-]{1,64}$/.test(ownerId) ? ownerId : `~${Buffer.from(ownerId, 'utf8').toString('hex')}`
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
  private readonly runners = new Map<string, SqlRunner>()
  private readonly sharedPath: string
  private readonly directory: string
  private readonly options: Omit<EngineOptions, 'path' | 'scope'>
  private readonly commandTimeoutMs: number
  private readonly ring: AuditEvent[] = []
  private readonly listeners = new Set<(event: AuditEvent) => void>()

  /**
   * @param config - validated plugin configuration.
   */
  constructor(config: Config) {
    const home = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    this.sharedPath = config.path ?? join(home, 'data', 'tables-shared.sqlite')
    this.directory = this.sharedPath === ':memory:' ? ':memory:' : dirname(resolve(this.sharedPath))
    this.options = {
      maxDbBytes: config.maxDbBytes ?? DEFAULT_LIMITS.maxDbBytes,
      maxValueBytes: config.maxValueBytes ?? DEFAULT_LIMITS.maxValueBytes,
      busyTimeoutMs: config.busyTimeoutMs ?? DEFAULT_LIMITS.busyTimeoutMs,
    }
    this.commandTimeoutMs = config.commandTimeoutMs ?? 5000
  }

  /**
   * Create a table.
   * @param request - table definition.
   * @param call - caller identity and cancellation.
   * @returns the stored schema.
   */
  createTable(request: CreateTableRequest, call: CallContext): Promise<TableSchema> {
    return this.invoke(this.scopeOf(call), 'createTable', [request, call.agent], call) as Promise<TableSchema>
  }

  /**
   * List every table visible to the caller: the shared file plus the caller's own private file.
   * @param call - caller identity and cancellation.
   * @returns one summary per table, ordered by name.
   */
  async listTables(call: CallContext): Promise<TableSummary[]> {
    const tables: TableSummary[] = []
    for (const scope of this.visibleScopes(call)) {
      tables.push(...await this.invoke(scope, 'listTables', [], call) as TableSummary[])
    }
    return tables.sort((left, right) => left.nome.localeCompare(right.nome))
  }

  /**
   * Describe one table, preferring the caller's scope and then the other visible file.
   * @param tabela - table name.
   * @param call - caller identity and cancellation.
   * @returns the table schema.
   */
  tableSchema(tabela: string, call: CallContext): Promise<TableSchema> {
    return this.locate(call, 'tableSchema', [tabela], undefined) as Promise<TableSchema>
  }

  /**
   * Add a column or an index.
   * @param request - alteration request.
   * @param call - caller identity and cancellation.
   * @returns the updated schema.
   */
  alterTable(request: AlterTableRequest, call: CallContext): Promise<TableSchema> {
    return this.locate(call, 'alterTable', [request, call.agent], undefined) as Promise<TableSchema>
  }

  /**
   * Drop a table; the request needs `confirmar` equal to its name.
   * @param request - drop request.
   * @param call - caller identity and cancellation.
   * @returns the dropped table name.
   */
  dropTable(request: DropTableRequest, call: CallContext): Promise<{ readonly tabela: string }> {
    return this.locate(call, 'dropTable', [request, call.agent], undefined) as Promise<{ readonly tabela: string }>
  }

  /**
   * Run one SELECT against one visible scope.
   * @param request - query request.
   * @param call - caller identity and cancellation.
   * @returns the query result.
   */
  query(request: QueryRequest, call: CallContext): Promise<QueryResult> {
    return this.invoke(this.scopeOf(call), 'query', [request], call, [request.sql]) as Promise<QueryResult>
  }

  /**
   * Run one INSERT, UPDATE or DELETE against one visible scope.
   * @param request - execution request.
   * @param call - caller identity and cancellation.
   * @returns the execution summary.
   */
  execute(request: ExecuteRequest, call: CallContext): Promise<ExecuteResult> {
    return this.invoke(this.scopeOf(call), 'execute', [request, call.agent], call, [request.sql]) as Promise<ExecuteResult>
  }

  /**
   * Run several writes atomically against one visible scope.
   * @param requests - execution requests.
   * @param call - caller identity and cancellation.
   * @returns one summary per request.
   */
  batch(requests: readonly ExecuteRequest[], call: CallContext): Promise<ExecuteResult[]> {
    const sql = requests.map(request => request.sql)
    return this.invoke(this.scopeOf(call), 'batch', [requests, call.agent], call, sql) as Promise<ExecuteResult[]>
  }

  /**
   * The most recent audit records, oldest first.
   * @returns a snapshot of the audit ring.
   */
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

  /** Stop every SQL child process. */
  async close(): Promise<void> {
    await Promise.all([...this.runners.values()].map(runner => runner.close()))
  }

  /** The scope a call addresses, defaulting to the caller's own file for an account and the shared file otherwise. */
  private scopeOf(call: CallContext): TableScope {
    return call.scope ?? ((call.ownerId ?? 'owner') === 'owner' ? 'compartilhada' : 'privada')
  }

  /** Files the caller may open: the shared file and, when present, its own private file. */
  private visibleScopes(call: CallContext): TableScope[] {
    return this.privateVisible(call) ? ['privada', 'compartilhada'] : ['compartilhada']
  }

  private privateVisible(call: CallContext): boolean {
    const key = this.runnerKey('privada', call.ownerId ?? 'owner')
    return this.runners.has(key) || this.directory === ':memory:' || existsSync(this.privatePath(call.ownerId ?? 'owner'))
  }

  private privatePath(ownerId: string): string {
    return this.directory === ':memory:' ? ':memory:' : join(this.directory, `tables-${ownerSegment(ownerId)}.sqlite`)
  }

  private runnerKey(scope: TableScope, ownerId: string): string {
    return scope === 'compartilhada' ? 'compartilhada' : `privada:${ownerId}`
  }

  private runnerFor(scope: TableScope, ownerId: string): SqlRunner {
    const key = this.runnerKey(scope, ownerId)
    let runner = this.runners.get(key)
    if (runner === undefined) {
      runner = new SqlRunner({
        path: scope === 'compartilhada' ? this.sharedPath : this.privatePath(ownerId),
        scope,
        ...this.options,
      }, this.commandTimeoutMs)
      this.runners.set(key, runner)
    }
    return runner
  }

  /** Try the caller's preferred scope, then the other visible file, on an unknown table only. */
  private async locate(call: CallContext, method: Method, args: readonly unknown[], sql: readonly string[] | undefined): Promise<unknown> {
    // A missing private file is absent, not empty: never create it just to answer a lookup.
    const scopes = this.visibleScopes(call)
    const preferred = this.scopeOf(call)
    const order = scopes.includes(preferred) ? [preferred, ...scopes.filter(scope => scope !== preferred)] : scopes
    let failure: unknown
    for (const scope of order) {
      try {
        return await this.invoke(scope, method, args, call, sql)
      } catch (error) {
        if (!(error instanceof TablesError) || error.code !== 'nao_existe') throw error
        failure = error
      }
    }
    throw failure
  }

  private async invoke(
    scope: TableScope, method: Method, args: readonly unknown[], call: CallContext, sql?: readonly string[],
  ): Promise<unknown> {
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
      const value = await this.runnerFor(scope, call.ownerId ?? 'owner').call(method, args, call.signal)
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
