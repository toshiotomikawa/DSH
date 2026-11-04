/**
 * Synchronous engine over one `node:sqlite` connection: table catalog,
 * single-statement SQL admission (SQLite authorizer plus tail check), atomic
 * writes, paging and size ceilings. It runs inside the SQL child process (or directly
 * in tests); the asynchronous service lives in `runner.ts` and `index.ts`.
 * @module @deepseek-ai/dsh-storage-tables/engine
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, constants as nativeConstants } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { TablesError } from './errors.ts'

/** Logical column types exposed to agents. */
export const COLUMN_TYPES = ['texto', 'inteiro', 'real', 'booleano', 'json', 'data_hora'] as const
/** One of {@link COLUMN_TYPES}. */
export type ColumnType = typeof COLUMN_TYPES[number]

/** A value an agent may bind or store; objects and arrays are stored as JSON text. */
export type SqlValue = string | number | boolean | null | readonly SqlValue[] | { readonly [key: string]: SqlValue }
/** Positional (`?`) or named (`:nome`) parameters. */
export type SqlParams = readonly SqlValue[] | { readonly [key: string]: SqlValue }

/** One declared column. */
export interface ColumnSpec {
  readonly nome: string
  readonly tipo: ColumnType
  readonly obrigatoria?: boolean
  readonly padrao?: SqlValue
}

/** Table creation request. */
export interface CreateTableRequest {
  readonly nome: string
  readonly colunas: readonly ColumnSpec[]
  readonly chavePrimaria?: readonly string[]
  /** UNIQUE constraints: each entry lists the declared columns that must be unique together (usable as upsert targets). */
  readonly unicas?: readonly (readonly string[])[]
}

/** Column as reported by the schema (declared or automatic). */
export interface ColumnInfo {
  readonly nome: string
  readonly tipo: ColumnType
  readonly obrigatoria: boolean
  readonly padrao?: SqlValue
  readonly automatica: boolean
  readonly chavePrimaria: boolean
}

/** Index as reported by the schema. */
export interface IndexInfo {
  readonly nome: string
  readonly colunas: readonly string[]
  readonly unica: boolean
}

/** Full description of one table. */
export interface TableSchema {
  readonly nome: string
  readonly criador: string
  readonly escopo: 'compartilhada' | 'privada'
  readonly criadoEm: string
  readonly colunas: readonly ColumnInfo[]
  readonly chavePrimaria: readonly string[]
  readonly indices: readonly IndexInfo[]
}

/** Row of the table listing. */
export interface TableSummary {
  readonly nome: string
  readonly criador: string
  readonly escopo: 'compartilhada' | 'privada'
  readonly criadoEm: string
  readonly linhas: number
}

/** Request to add a column or an index. */
export interface AlterTableRequest {
  readonly tabela: string
  readonly adicionarColuna?: ColumnSpec
  readonly adicionarIndice?: { readonly nome: string; readonly colunas: readonly string[]; readonly unica?: boolean }
}

/** Request to drop a table. */
export interface DropTableRequest {
  readonly tabela: string
  /** Must equal `tabela`. */
  readonly confirmar: string
}

/** Single-SELECT request. */
export interface QueryRequest {
  readonly sql: string
  readonly parametros?: SqlParams
  readonly limite?: number
}

/** Rows of one page. */
export interface QueryResult {
  readonly colunas: readonly string[]
  readonly linhas: readonly Record<string, unknown>[]
  readonly truncado: boolean
}

/** Single write request. */
export interface ExecuteRequest {
  readonly sql: string
  readonly parametros?: SqlParams
  /** Allow `UPDATE`/`DELETE` without a top-level `WHERE`. */
  readonly permitirTudo?: boolean
}

/** Outcome of one write. */
export interface ExecuteResult {
  readonly linhasAfetadas: number
  /** Row id of an `INSERT`; null for other statements. */
  readonly ultimoId: number | null
}

/** Engine limits and location. */
export interface EngineOptions {
  /** Database file path, or `:memory:`. */
  readonly path: string
  /** Scope recorded on every table this file holds; the shared file is the default. */
  readonly scope?: 'privada' | 'compartilhada'
  /** Ceiling for the whole database file; writes beyond it are refused. */
  readonly maxDbBytes: number
  /** Ceiling for one bound text value, in UTF-8 bytes. */
  readonly maxValueBytes: number
  /** SQLite busy timeout, in milliseconds. */
  readonly busyTimeoutMs: number
}

/** Defaults for {@link EngineOptions}. */
export const DEFAULT_LIMITS = {
  maxDbBytes: 256 * 1024 * 1024,
  maxValueBytes: 1024 * 1024,
  busyTimeoutMs: 3000,
} as const

/** Default and maximum rows per query page. */
export const DEFAULT_PAGE = 200
/** Hard ceiling for one query page. */
export const MAX_PAGE = 1000
/** Maximum commands in one batch. */
export const MAX_BATCH = 100

/** Authorizer callback: action code plus up to four context strings (table, column, database, trigger). */
type Authorizer = (action: number, a1: string | null, a2: string | null, a3: string | null, a4: string | null) => number

/** The `node:sqlite` surface this engine relies on (Node 24+), narrower than the bundled typings. */
interface AuthorizingDatabase extends DatabaseSync {
  setAuthorizer(callback: Authorizer | null): void
}

const constants = nativeConstants as unknown as Record<
  'SQLITE_OK' | 'SQLITE_DENY' | 'SQLITE_SELECT' | 'SQLITE_READ' | 'SQLITE_FUNCTION' | 'SQLITE_RECURSIVE'
  | 'SQLITE_INSERT' | 'SQLITE_UPDATE' | 'SQLITE_DELETE', number
>

/** Flatten a binding into the argument list `node:sqlite` expects (named parameters go as one object). */
function bindArgs(binding: { positional: SQLInputValue[]; named: Record<string, SQLInputValue>[] }): SQLInputValue[] {
  return [...binding.positional, ...binding.named] as unknown as SQLInputValue[]
}

/** Array check that keeps a readonly array's element type (plain `Array.isArray` widens it to `any[]`). */
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

const NAME_RE = /^[a-z0-9_]{1,48}$/
const RESERVED_PREFIXES = ['sqlite_', '_dsh_'] as const
const AUTO_COLUMNS = ['criado_em', 'atualizado_em', 'revisao', 'autor'] as const
const SQL_TYPE: Record<ColumnType, string> = {
  texto: 'TEXT', inteiro: 'INTEGER', real: 'REAL', booleano: 'INTEGER', json: 'TEXT', data_hora: 'TEXT',
}
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

interface MetaRow {
  nome: string
  criador: string
  escopo: 'compartilhada' | 'privada'
  criado_em: string
  colunas: string
  chave_primaria: string
  indices: string
}

type Prepared = {
  readonly statement: ReturnType<DatabaseSync['prepare']>
  readonly writeAction: number | undefined
}

/** Quoted identifier; callers validate names first. */
function ident(name: string): string {
  return `"${name}"`
}

function fail(code: ConstructorParameters<typeof TablesError>[0], message: string, details?: Record<string, unknown>): never {
  throw new TablesError(code, message, details)
}

/** Edit distance between two short names. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[b.length] as number
}

/** Existing names close to `name`, best first. */
function similarNames(name: string, names: readonly string[]): string[] {
  return names
    .filter(candidate => candidate.includes(name) || name.includes(candidate) || distance(candidate, name) <= 3)
    .sort((a, b) => distance(a, name) - distance(b, name))
    .slice(0, 5)
}

/** Replace string literals, quoted identifiers and comments with spaces. */
function stripLiteralsAndComments(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
}

/**
 * Whether the statement has a `WHERE` outside every parenthesis.
 * @param sql - SQL text.
 * @returns whether a top-level WHERE exists.
 */
export function hasTopLevelWhere(sql: string): boolean {
  let depth = 0
  for (const token of stripLiteralsAndComments(sql).matchAll(/[()]|[A-Za-z_]+/g)) {
    const text = token[0]
    if (text === '(') depth++
    else if (text === ')') depth--
    else if (depth === 0 && text.toUpperCase() === 'WHERE') return true
  }
  return false
}

/** Whether `rest` (the text after the first statement) holds nothing but separators and comments. */
function onlyTrivia(rest: string): boolean {
  return stripLiteralsAndComments(rest).replaceAll(';', '').trim() === ''
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return value
}

function plainRow(row: Record<string, unknown>, maxValueBytes: number): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const size = typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 0
    if (size > maxValueBytes) fail('valor_grande', `a coluna '${key}' devolveria um valor maior que o teto de ${maxValueBytes} bytes`)
    return [key, toJsonSafe(value)]
  }))
}

/** Placeholders a statement expects: plain `?` count (or highest `?N`) and distinct named parameters. */
function placeholders(sql: string): { positional: number; named: Set<string> } {
  let positional = 0
  let highest = 0
  const named = new Set<string>()
  let i = 0
  while (i < sql.length) {
    const ch = sql.charAt(i)
    const next = sql.charAt(i + 1)
    if (ch === "'" || ch === '"' || ch === '`') {
      // A doubled quote closes and reopens the literal, which this loop handles as two literals.
      const end = sql.indexOf(ch, i + 1)
      i = end === -1 ? sql.length : end + 1
    } else if (ch === '[') {
      const end = sql.indexOf(']', i + 1)
      i = end === -1 ? sql.length : end + 1
    } else if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end + 1
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
    } else if (ch === '?') {
      const digits = /^\d+/.exec(sql.slice(i + 1))
      if (digits === null) positional++
      else highest = Math.max(highest, Number(digits[0]))
      i += 1 + (digits?.[0].length ?? 0)
    } else if (ch === ':' || ch === '@' || ch === '$') {
      const word = (/^[A-Za-z_]\w*|/.exec(sql.slice(i + 1)) as RegExpExecArray)[0]
      if (word !== '') named.add(word)
      i += 1 + word.length
    } else {
      i++
    }
  }
  return { positional: Math.max(positional, highest), named }
}

/** The relational engine. One instance owns one connection. */
export class TablesEngine {
  private readonly db: AuthorizingDatabase
  private readonly options: EngineOptions

  /**
   * Open (creating if needed) the database and ensure the internal tables.
   * @param options - location and ceilings.
   */
  constructor(options: EngineOptions) {
    this.options = options
    const path = options.path === ':memory:' ? options.path : resolve(options.path)
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      // Create the file owner-only when missing; appending nothing leaves an existing file untouched.
      appendFileSync(path, '', { mode: 0o600 })
    }
    this.db = new DatabaseSync(path, {
      timeout: options.busyTimeoutMs, allowExtension: false, defensive: true,
    } as ConstructorParameters<typeof DatabaseSync>[1]) as AuthorizingDatabase
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _dsh_meta (
        nome TEXT PRIMARY KEY, criador TEXT NOT NULL, escopo TEXT NOT NULL, owner_id TEXT,
        criado_em TEXT NOT NULL, colunas TEXT NOT NULL, chave_primaria TEXT NOT NULL, indices TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS _dsh_ctx (id INTEGER PRIMARY KEY CHECK (id = 1), agente TEXT) STRICT;
      INSERT OR IGNORE INTO _dsh_ctx (id, agente) VALUES (1, NULL);
    `)
  }

  /** Release the connection. */
  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------- catalog

  /**
   * Create a table with its automatic columns and triggers.
   * @param request - declared columns and optional primary key.
   * @param agent - id of the calling agent.
   * @returns the stored schema.
   */
  createTable(request: CreateTableRequest, agent: string): TableSchema {
    const name = this.guardName('tabela', request.nome)
    if (!isList(request.colunas) || request.colunas.length === 0) {
      fail('argumento_invalido', 'colunas deve ser uma lista com pelo menos uma coluna')
    }
    const primaryKey = request.chavePrimaria === undefined ? [] : [...request.chavePrimaria]
    const seen = new Set<string>()
    for (const column of request.colunas) {
      this.guardName('coluna', column.nome)
      if ((AUTO_COLUMNS as readonly string[]).includes(column.nome)) {
        fail('nome_invalido', `a coluna '${column.nome}' é automática e não pode ser declarada`)
      }
      if (column.nome === 'id' && primaryKey.length === 0) {
        fail('nome_invalido', "a coluna 'id' é automática quando não há chave_primaria; declare chave_primaria ou use outro nome")
      }
      if (seen.has(column.nome)) fail('nome_invalido', `coluna repetida: '${column.nome}'`)
      seen.add(column.nome)
    }
    if (request.chavePrimaria !== undefined && primaryKey.length === 0) {
      fail('argumento_invalido', 'chave_primaria, quando informada, precisa de ao menos uma coluna')
    }
    for (const key of primaryKey) {
      if (!seen.has(key)) fail('argumento_invalido', `a chave primária cita a coluna inexistente '${key}'`)
    }
    const declared = request.colunas.map(column => this.normalizeColumn(column))
    const uniques = request.unicas ?? []
    if (!isList(uniques)) fail('argumento_invalido', 'unicas deve ser uma lista de listas de colunas')
    const uniqueInfo: IndexInfo[] = uniques.map((group, position) => {
      if (!isList(group) || group.length === 0) fail('argumento_invalido', 'cada item de unicas precisa de ao menos uma coluna')
      for (const column of group) {
        if (!seen.has(column)) fail('argumento_invalido', `unicas cita a coluna inexistente '${column}'`)
      }
      return { nome: `unica_${position + 1}`, colunas: [...group], unica: true }
    })
    const parts: string[] = []
    if (primaryKey.length === 0) parts.push('"id" INTEGER PRIMARY KEY')
    for (const column of declared) {
      parts.push(this.columnSql(column, primaryKey.includes(column.nome)))
    }
    parts.push(
      `"criado_em" TEXT NOT NULL DEFAULT (${NOW_SQL})`,
      `"atualizado_em" TEXT NOT NULL DEFAULT (${NOW_SQL})`,
      '"revisao" INTEGER NOT NULL DEFAULT 1',
      '"autor" TEXT',
    )
    if (primaryKey.length > 0) parts.push(`PRIMARY KEY (${primaryKey.map(ident).join(', ')})`)
    for (const group of uniqueInfo) parts.push(`UNIQUE (${group.colunas.map(ident).join(', ')})`)
    this.checkSize()
    this.transaction(() => {
      if (this.findMeta(name) !== undefined) fail('ja_existe', `a tabela '${name}' já existe; escolha outro nome`)
      this.db.exec(`CREATE TABLE ${ident(name)} (${parts.join(', ')}) STRICT`)
      this.db.exec(this.triggersSql(name, declared.map(column => column.nome).concat(primaryKey.length === 0 ? ['id'] : [])))
      this.db.prepare(
        'INSERT INTO _dsh_meta (nome, criador, escopo, criado_em, colunas, chave_primaria, indices) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(name, agent, this.options.scope ?? 'compartilhada', new Date().toISOString(), JSON.stringify(declared), JSON.stringify(primaryKey), JSON.stringify(uniqueInfo))
    })
    return this.tableSchema(name)
  }

  /**
   * List every table with its creator and row count.
   * @returns the tables, ordered by name.
   */
  listTables(): TableSummary[] {
    const rows = this.db.prepare('SELECT nome, criador, escopo, criado_em FROM _dsh_meta ORDER BY nome').all() as unknown as MetaRow[]
    return rows.map(row => ({
      nome: row.nome,
      criador: row.criador,
      escopo: row.escopo,
      criadoEm: row.criado_em,
      linhas: Number((this.db.prepare(`SELECT count(*) AS n FROM ${ident(row.nome)}`).get() as { n: number | bigint }).n),
    }))
  }

  /**
   * Describe one table.
   * @param tabela - table name.
   * @returns columns, key and indexes.
   */
  tableSchema(tabela: string): TableSchema {
    const row = this.requireMeta(tabela)
    const declared = JSON.parse(row.colunas) as ColumnSpec[]
    const primaryKey = JSON.parse(row.chave_primaria) as string[]
    const autoId: ColumnInfo[] = primaryKey.length === 0
      ? [{ nome: 'id', tipo: 'inteiro', obrigatoria: true, automatica: true, chavePrimaria: true }]
      : []
    const columns: ColumnInfo[] = [
      ...autoId,
      ...declared.map(column => ({
        nome: column.nome,
        tipo: column.tipo,
        obrigatoria: column.obrigatoria === true || primaryKey.includes(column.nome),
        ...column.padrao === undefined ? {} : { padrao: column.padrao },
        automatica: false,
        chavePrimaria: primaryKey.includes(column.nome),
      })),
      { nome: 'criado_em', tipo: 'data_hora', obrigatoria: true, automatica: true, chavePrimaria: false },
      { nome: 'atualizado_em', tipo: 'data_hora', obrigatoria: true, automatica: true, chavePrimaria: false },
      { nome: 'revisao', tipo: 'inteiro', obrigatoria: true, automatica: true, chavePrimaria: false },
      { nome: 'autor', tipo: 'texto', obrigatoria: false, automatica: true, chavePrimaria: false },
    ]
    return {
      nome: row.nome,
      criador: row.criador,
      escopo: row.escopo,
      criadoEm: row.criado_em,
      colunas: columns,
      chavePrimaria: primaryKey.length === 0 ? ['id'] : primaryKey,
      indices: JSON.parse(row.indices) as IndexInfo[],
    }
  }

  /**
   * Add a column or an index. Renaming and dropping columns are not supported.
   * @param request - exactly one of `adicionarColuna` or `adicionarIndice`.
   * @param _agent - id of the calling agent.
   * @returns the updated schema.
   */
  alterTable(request: AlterTableRequest, _agent: string): TableSchema {
    if ((request.adicionarColuna === undefined) === (request.adicionarIndice === undefined)) {
      fail('argumento_invalido', 'informe exatamente um entre adicionar_coluna e adicionar_indice')
    }
    this.checkSize()
    this.transaction(() => {
      const row = this.requireMeta(request.tabela)
      const declared = JSON.parse(row.colunas) as ColumnSpec[]
      const primaryKey = JSON.parse(row.chave_primaria) as string[]
      if (request.adicionarColuna !== undefined) {
        const column = this.normalizeColumn(request.adicionarColuna)
        this.guardName('coluna', column.nome)
        const taken = ['id', ...AUTO_COLUMNS, ...declared.map(existing => existing.nome)]
        if (taken.includes(column.nome)) fail('nome_invalido', `a coluna '${column.nome}' já existe ou é reservada`)
        if (column.obrigatoria === true && column.padrao === undefined) {
          fail('argumento_invalido', `a coluna obrigatória '${column.nome}' exige um valor padrão ao ser adicionada`)
        }
        this.db.exec(`ALTER TABLE ${ident(row.nome)} ADD COLUMN ${this.columnSql(column, false)}`)
        declared.push(column)
        const names = declared.map(existing => existing.nome).concat(primaryKey.length === 0 ? ['id'] : [])
        for (const suffix of ['ai', 'au', 'bi', 'bu']) this.db.exec(`DROP TRIGGER ${ident(`${row.nome}__${suffix}`)}`)
        this.db.exec(this.triggersSql(row.nome, names))
        this.db.prepare('UPDATE _dsh_meta SET colunas = ? WHERE nome = ?').run(JSON.stringify(declared), row.nome)
        return
      }
      const index = request.adicionarIndice as NonNullable<AlterTableRequest['adicionarIndice']>
      this.guardName('índice', index.nome)
      const known = [
        ...declared.map(column => column.nome), ...AUTO_COLUMNS, ...primaryKey.length === 0 ? ['id'] : [],
      ]
      if (!isList(index.colunas) || index.colunas.length === 0) {
        fail('argumento_invalido', 'o índice precisa de ao menos uma coluna')
      }
      for (const column of index.colunas) {
        if (!known.includes(column)) fail('argumento_invalido', `o índice cita a coluna inexistente '${column}'`)
      }
      const indexes = JSON.parse(row.indices) as IndexInfo[]
      if (indexes.some(existing => existing.nome === index.nome)) {
        fail('ja_existe', `o índice '${index.nome}' já existe na tabela '${row.nome}'`)
      }
      const unique = index.unica === true
      try {
        this.db.exec(
          `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${ident(`ix_${row.nome}_${index.nome}`)} ON ${ident(row.nome)} (${index.colunas.map(ident).join(', ')})`,
        )
      } catch (error) {
        throw this.mapError(error)
      }
      indexes.push({ nome: index.nome, colunas: [...index.colunas], unica: unique })
      this.db.prepare('UPDATE _dsh_meta SET indices = ? WHERE nome = ?').run(JSON.stringify(indexes), row.nome)
    })
    return this.tableSchema(request.tabela)
  }

  /**
   * Drop a table after the caller repeats its name.
   * @param request - table and confirmation.
   * @param _agent - id of the calling agent.
   * @returns the dropped name.
   */
  dropTable(request: DropTableRequest, _agent: string): { readonly tabela: string } {
    if (request.confirmar !== request.tabela) {
      fail('confirmacao', `para apagar a tabela '${request.tabela}', passe confirmar igual ao nome da tabela`)
    }
    this.transaction(() => {
      const row = this.requireMeta(request.tabela)
      this.db.exec(`DROP TABLE ${ident(row.nome)}`)
      this.db.prepare('DELETE FROM _dsh_meta WHERE nome = ?').run(row.nome)
    })
    return { tabela: request.tabela }
  }

  // ------------------------------------------------------------------ data

  /**
   * Run one `SELECT` and return up to `limite` rows.
   * @param request - SQL, parameters and row limit.
   * @returns rows as objects; `truncado` is true when more rows matched than the limit.
   */
  query(request: QueryRequest): QueryResult {
    const limit = request.limite ?? DEFAULT_PAGE
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      fail('argumento_invalido', `limite deve ser um inteiro entre 1 e ${MAX_PAGE}`)
    }
    if (typeof request.sql !== 'string' || request.sql.trim() === '') fail('argumento_invalido', 'sql deve ser um texto não vazio')
    const binding = this.bind(request.parametros, request.sql)
    const { statement } = this.prepare(request.sql, 'query')
    const rows: Record<string, unknown>[] = []
    let truncated = false
    statement.setReadBigInts(true)
    this.db.exec('PRAGMA query_only = ON')
    try {
      for (const row of statement.iterate(...bindArgs(binding))) {
        if (rows.length === limit) {
          truncated = true
          break
        }
        rows.push(plainRow(row, this.options.maxValueBytes))
      }
    } catch (error) {
      throw this.mapError(error)
    } finally {
      this.db.exec('PRAGMA query_only = OFF')
    }
    const columns = statement.columns().map(column => column.name)
    return { colunas: columns, linhas: rows, truncado: truncated }
  }

  /**
   * Run one `INSERT`, `UPDATE` or `DELETE` atomically.
   * @param request - SQL, parameters and the no-`WHERE` override.
   * @param agent - id of the calling agent, stamped into `autor`.
   * @returns affected rows and the last inserted id.
   */
  execute(request: ExecuteRequest, agent: string): ExecuteResult {
    return this.batch([request], agent)[0] as ExecuteResult
  }

  /**
   * Run up to {@link MAX_BATCH} writes in one transaction; any failure undoes all.
   * @param requests - ordered writes.
   * @param agent - id of the calling agent.
   * @returns one result per write.
   */
  batch(requests: readonly ExecuteRequest[], agent: string): ExecuteResult[] {
    if (!isList(requests) || requests.length === 0 || requests.length > MAX_BATCH) {
      fail('argumento_invalido', `o lote precisa ter de 1 a ${MAX_BATCH} comandos`)
    }
    const prepared = requests.map((request, indice) => {
      try {
        const binding = this.bind(request.parametros, request.sql)
        const item = this.prepare(request.sql, 'execute')
        if (item.writeAction !== constants.SQLITE_INSERT && request.permitirTudo !== true && !hasTopLevelWhere(request.sql)) {
          fail('sem_where', 'UPDATE e DELETE sem WHERE são recusados; acrescente WHERE ou passe permitir_tudo: true')
        }
        return { ...item, binding, insert: item.writeAction === constants.SQLITE_INSERT }
      } catch (error) {
        throw this.withIndex(error, indice, requests.length)
      }
    })
    this.checkSize()
    const results: ExecuteResult[] = []
    let indice = 0
    try {
      this.transaction(() => {
        this.db.prepare('UPDATE _dsh_ctx SET agente = ? WHERE id = 1').run(agent)
        for (const item of prepared) {
          const outcome = item.statement.run(...bindArgs(item.binding))
          results.push({
            linhasAfetadas: Number(outcome.changes),
            ultimoId: item.insert ? Number(outcome.lastInsertRowid) : null,
          })
          indice++
        }
      })
    } catch (error) {
      throw this.withIndex(this.mapError(error), indice, requests.length)
    }
    return results
  }

  // --------------------------------------------------------------- helpers

  private guardName(kind: string, name: unknown): string {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      fail('nome_invalido', `nome de ${kind} inválido: use letras minúsculas, números e sublinhado, de 1 a 48 caracteres`)
    }
    if (RESERVED_PREFIXES.some(prefix => name.startsWith(prefix))) {
      fail('nome_invalido', `nome de ${kind} inválido: os prefixos 'sqlite_' e '_dsh_' são reservados`)
    }
    return name
  }

  private findMeta(name: string): MetaRow | undefined {
    return this.db.prepare('SELECT * FROM _dsh_meta WHERE nome = ?').get(name) as unknown as MetaRow | undefined
  }

  private requireMeta(name: string): MetaRow {
    const row = typeof name === 'string' ? this.findMeta(name) : undefined
    if (row !== undefined) return row
    // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- callers outside the type system may pass any value.
    throw this.notFound(String(name))
  }

  private normalizeColumn(column: ColumnSpec): ColumnSpec {
    if (!(COLUMN_TYPES as readonly string[]).includes(column.tipo)) {
      fail('argumento_invalido', `tipo inválido para a coluna '${column.nome}': use ${COLUMN_TYPES.join(', ')}`)
    }
    if (column.padrao !== undefined && column.padrao !== null) this.defaultLiteral(column)
    const { padrao, ...rest } = column
    return { ...rest, ...padrao === undefined || padrao === null ? {} : { padrao } }
  }

  private defaultLiteral(column: ColumnSpec): string {
    const value = column.padrao as SqlValue
    const bad = () => fail('argumento_invalido', `o valor padrão da coluna '${column.nome}' não é do tipo ${column.tipo}`)
    switch (column.tipo) {
      case 'inteiro':
        return Number.isInteger(value) ? String(Number(value)) : bad()
      case 'real':
        return typeof value === 'number' && Number.isFinite(value) ? String(value) : bad()
      case 'booleano':
        return typeof value === 'boolean' ? (value ? '1' : '0') : bad()
      case 'json':
        return `'${JSON.stringify(value).replaceAll("'", "''")}'`
      default:
        return typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : bad()
    }
  }

  private columnSql(column: ColumnSpec, primaryKey: boolean): string {
    const name = ident(column.nome)
    const required = column.obrigatoria === true || primaryKey
    const check: Partial<Record<ColumnType, string>> = {
      booleano: ` CHECK (${name} IN (0, 1))`,
      json: ` CHECK (${name} IS NULL OR json_valid(${name}))`,
      data_hora: ` CHECK (${name} IS NULL OR datetime(${name}) IS NOT NULL)`,
    }
    return `${name} ${SQL_TYPE[column.tipo]}${required ? ' NOT NULL' : ''}`
      + `${column.padrao === undefined ? '' : ` DEFAULT ${this.defaultLiteral(column)}`}${check[column.tipo] ?? ''}`
  }

  /**
   * Triggers that own the automatic columns and the value ceiling: insert stamps `autor`, `revisao`, `criado_em`,
   * `atualizado_em`; update bumps `revisao`, `atualizado_em`, `autor`; both abort on a value above the ceiling.
   */
  private triggersSql(table: string, userColumns: readonly string[]): string {
    const author = '(SELECT agente FROM _dsh_ctx WHERE id = 1)'
    const t = ident(table)
    const names = (suffix: string) => ident(`${table}__${suffix}`)
    const columns = userColumns.map(ident).join(', ')
    const tooBig = userColumns.map(column => `length(CAST(NEW.${ident(column)} AS BLOB)) > ${this.options.maxValueBytes}`).join(' OR ')
    const guard = `WHEN ${tooBig} BEGIN SELECT RAISE(ABORT, 'valor_grande'); END;`
    const insert = `CREATE TRIGGER ${names('ai')} AFTER INSERT ON ${t} BEGIN `
      + `UPDATE ${t} SET autor = ${author}, revisao = 1, criado_em = ${NOW_SQL}, atualizado_em = ${NOW_SQL} WHERE rowid = NEW.rowid; END;`
    // `UPDATE OF` lists only user columns, so the stamping UPDATEs below never re-fire the trigger.
    const update = `CREATE TRIGGER ${names('au')} AFTER UPDATE OF ${columns} ON ${t} BEGIN `
      + `UPDATE ${t} SET revisao = OLD.revisao + 1, atualizado_em = ${NOW_SQL}, autor = ${author} WHERE rowid = NEW.rowid; END;`
    return `${insert} ${update} CREATE TRIGGER ${names('bi')} BEFORE INSERT ON ${t} ${guard} `
      + `CREATE TRIGGER ${names('bu')} BEFORE UPDATE OF ${columns} ON ${t} ${guard}`
  }

  private transaction(body: () => void): void {
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch (error) {
      throw this.mapError(error)
    }
    try {
      const before = this.dbBytes()
      body()
      // A write that would grow the file past the ceiling is rolled back, not merely refused next time.
      if (this.dbBytes() > Math.max(before, this.options.maxDbBytes)) this.checkSize()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw this.mapError(error)
    }
  }

  private dbBytes(): number {
    const pages = (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
    const size = (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
    return pages * size
  }

  private checkSize(): void {
    if (this.dbBytes() > this.options.maxDbBytes) {
      fail('banco_cheio', `o banco passou do teto de ${this.options.maxDbBytes} bytes; consultas continuam permitidas, mas gravações estão recusadas`)
    }
  }

  private bind(params: SqlParams | undefined, sql: unknown): { positional: SQLInputValue[]; named: Record<string, SQLInputValue>[] } {
    const expected = typeof sql === 'string' ? placeholders(sql) : { positional: 0, named: new Set<string>() }
    const convert = (value: unknown): SQLInputValue => {
      if (value === undefined) return fail('argumento_invalido', 'parâmetro indefinido; use null para um valor vazio')
      if (value === null) return null
      if (typeof value === 'boolean') return value ? 1 : 0
      if (typeof value === 'number') return value
      if (typeof value === 'string') {
        if (Buffer.byteLength(value) > this.options.maxValueBytes) {
          fail('valor_grande', `um valor passou do teto de ${this.options.maxValueBytes} bytes`)
        }
        return value
      }
      if (typeof value === 'object') return convert(JSON.stringify(value))
      return fail('argumento_invalido', `tipo de parâmetro sem suporte: ${typeof value}`)
    }
    const count = (kind: string, want: number, got: number) => {
      if (want !== got) fail('argumento_invalido', `o SQL espera ${want} ${kind} e recebeu ${got}; nada foi gravado`)
    }
    if (params === undefined) {
      count('parâmetros posicionais', expected.positional, 0)
      count('parâmetros nomeados', expected.named.size, 0)
      return { positional: [], named: [] }
    }
    if (isList(params)) {
      count('parâmetros posicionais', expected.positional, params.length)
      count('parâmetros nomeados (lista dada)', expected.named.size, 0)
      return { positional: Array.from(params, convert), named: [] }
    }
    const entries = Object.entries(params).map(([key, value]) => [key.replace(/^[:@$]/, ''), convert(value)] as const)
    count('parâmetros posicionais (objeto dado)', expected.positional, 0)
    const given = new Set(entries.map(([key]) => key))
    for (const name of expected.named) {
      if (!given.has(name)) fail('argumento_invalido', `falta o parâmetro nomeado '${name}'; nada foi gravado`)
    }
    count('parâmetros nomeados', expected.named.size, given.size)
    return { positional: [], named: [Object.fromEntries(entries)] }
  }

  /** Prepare exactly one statement of the allowed family; the SQLite authorizer is the authority. */
  private prepare(sql: unknown, mode: 'query' | 'execute'): Prepared {
    if (typeof sql !== 'string' || sql.trim() === '') fail('argumento_invalido', 'sql deve ser um texto não vazio')
    const allowed = new Set<number>([
      constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE,
      ...mode === 'execute' ? [constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE] : [],
    ])
    const writes = new Set<number>([constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE])
    const known = new Set((this.db.prepare('SELECT nome FROM _dsh_meta').all() as unknown as { nome: string }[]).map(item => item.nome))
    // The automatic columns belong to the service; only its triggers may write them.
    const stamped = new Set<string>(AUTO_COLUMNS)
    let writeAction: number | undefined
    let selects = false as boolean
    this.db.setAuthorizer((action, table, column, _database, inner) => {
      const nested = typeof inner === 'string'
      const tableName = typeof table === 'string' ? table : ''
      // Writes reach only the user's tables. Reads also see CTE names, so the hidden catalog is a denylist:
      // internal tables, the file-revealing pragma_* table-valued functions and dbstat never pass.
      const lowered = tableName.toLowerCase()
      const hidden = RESERVED_PREFIXES.some(prefix => lowered.startsWith(prefix)) || lowered.startsWith('pragma_') || lowered === 'dbstat'
      if (!nested && action === constants.SQLITE_READ && hidden) return constants.SQLITE_DENY
      if (!nested && writes.has(action) && !known.has(tableName)) return constants.SQLITE_DENY
      if (!nested && action === constants.SQLITE_UPDATE && stamped.has(column as string)) return constants.SQLITE_DENY
      if (!allowed.has(action)) return constants.SQLITE_DENY
      if (!nested && writes.has(action)) writeAction ??= action
      if (!nested && action === constants.SQLITE_SELECT) selects = true
      return constants.SQLITE_OK
    })
    let statement: ReturnType<DatabaseSync['prepare']> | undefined
    let failure: unknown
    try {
      statement = this.db.prepare(sql)
    } catch (error) {
      failure = error
    } finally {
      this.db.setAuthorizer(null)
    }
    if (statement === undefined) throw this.mapError(failure, mode)
    if (!onlyTrivia(sql.slice(statement.sourceSQL.length))) {
      fail('sql_recusado', 'apenas um comando SQL por chamada; o texto tem mais de um')
    }
    // VACUUM and a few other statements never reach the authorizer; a query must announce itself as a SELECT.
    if (mode === 'query' && !selects) fail('sql_recusado', 'data_query aceita apenas um SELECT')
    if (mode === 'execute' && writeAction === undefined) {
      fail('sql_recusado', 'data_execute aceita apenas INSERT, UPDATE ou DELETE')
    }
    return { statement, writeAction }
  }

  private withIndex(error: unknown, indice: number, total: number): unknown {
    if (!(error instanceof TablesError) || total === 1) return error
    return new TablesError(error.code, `comando ${indice + 1} de ${total}: ${error.message}`, { ...error.details, indice })
  }

  private mapError(error: unknown, mode?: 'query' | 'execute'): TablesError {
    if (error instanceof TablesError) return error
    const message = (error as Error).message
    const primary = Number((error as { errcode?: number }).errcode) & 0xff
    if (primary === 23) {
      const accepted = mode === 'execute' ? 'INSERT, UPDATE ou DELETE' : 'um único SELECT'
      return new TablesError('sql_recusado', `comando não permitido nesta ferramenta: ela aceita apenas ${accepted} sobre as tabelas do usuário`)
    }
    if (primary === 5 || primary === 6) {
      return new TablesError('ocupado', 'o banco está ocupado por outro agente; tente de novo em instantes')
    }
    if (message.includes('valor_grande')) {
      return new TablesError('valor_grande', `um valor passou do teto de ${this.options.maxValueBytes} bytes; nada foi gravado`)
    }
    if (primary === 19) return new TablesError('restricao', `restrição violada, nada foi gravado: ${message}`)
    const missing = /^no such table: (?:main\.)?(\S+)/.exec(message)
    if (missing !== null) return this.notFound(missing[1] as string)
    return new TablesError('argumento_invalido', `SQL recusado pelo SQLite: ${message}`)
  }

  private notFound(name: string): TablesError {
    const names = (this.db.prepare('SELECT nome FROM _dsh_meta').all() as unknown as { nome: string }[]).map(item => item.nome)
    const similar = similarNames(name, names)
    return new TablesError(
      'nao_existe',
      `a tabela '${name}' não existe${similar.length > 0 ? `; tabelas parecidas: ${similar.join(', ')}` : ''}`,
      { parecidas: similar },
    )
  }
}
