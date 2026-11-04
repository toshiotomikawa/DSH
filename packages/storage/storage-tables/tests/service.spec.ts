import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as StorageTables from '../src/index.ts'
import { TablesError } from '../src/errors.ts'
import { SqlRunner } from '../src/runner.ts'
import { DEFAULT_LIMITS } from '../src/engine.ts'

const AGENT = { agent: 'agente-1' } as const
const NOTES = { nome: 'notas', colunas: [{ nome: 'v', tipo: 'inteiro' }, { nome: 'texto', tipo: 'texto' }] } as const
const INFINITE = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c'

let dir: string
let path: string
let services: StorageTables.TablesService[]

function open(overrides: StorageTables.Config = {}): StorageTables.TablesService {
  const service = new StorageTables.TablesService({ path, ...overrides })
  services.push(service)
  return service
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    return error instanceof TablesError ? error.code : `other:${(error as Error).message}`
  }
  return 'ok'
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tables-svc-'))
  path = join(dir, 'data', 'tables.sqlite')
  services = []
})

afterEach(async () => {
  await Promise.all(services.map(service => service.close()))
  rmSync(dir, { recursive: true, force: true })
})

describe('service round trip through the Worker', () => {
  it('creates, lists, describes, alters, queries, writes and drops', async () => {
    const tables = open()
    const schema = await tables.createTable(NOTES, AGENT)
    expect(schema.criador).toBe('agente-1')
    expect((await tables.listTables(AGENT)).map(table => table.nome)).toEqual(['notas'])
    expect((await tables.tableSchema('notas', AGENT)).colunas).toHaveLength(7)
    expect((await tables.alterTable({ tabela: 'notas', adicionarIndice: { nome: 'i', colunas: ['v'] } }, AGENT)).indices).toHaveLength(1)
    expect(await tables.execute({ sql: 'INSERT INTO notas (v, texto) VALUES (?, ?)', parametros: [1, 'a'] }, AGENT))
      .toEqual({ linhasAfetadas: 1, ultimoId: 1 })
    expect(await tables.batch([{ sql: 'INSERT INTO notas (v) VALUES (2)' }, { sql: 'INSERT INTO notas (v) VALUES (3)' }], AGENT)).toHaveLength(2)
    expect((await tables.query({ sql: 'SELECT v FROM notas ORDER BY id' }, AGENT)).linhas).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }])
    expect(await tables.dropTable({ tabela: 'notas', confirmar: 'notas' }, AGENT)).toEqual({ tabela: 'notas' })
  })

  it('carries typed errors across the Worker boundary', async () => {
    const tables = open()
    await tables.createTable(NOTES, AGENT)
    expect(await codeOf(tables.createTable(NOTES, AGENT))).toBe('ja_existe')
    expect(await codeOf(tables.query({ sql: 'DROP TABLE notas' }, AGENT))).toBe('sql_recusado')
    expect(await codeOf(tables.dropTable({ tabela: 'notas', confirmar: 'x' }, AGENT))).toBe('confirmacao')
    // A failure does not poison the Worker.
    expect((await tables.listTables(AGENT)).length).toBe(1)
  })

  it('persists across a restart of the service', async () => {
    const first = open()
    await first.createTable(NOTES, AGENT)
    await first.execute({ sql: 'INSERT INTO notas (v) VALUES (42)' }, AGENT)
    await first.close()
    const second = open()
    expect((await second.query({ sql: 'SELECT v, autor FROM notas' }, AGENT)).linhas).toEqual([{ v: 42, autor: 'agente-1' }])
  })
})

describe('criterion 6: ten agents insert 100 rows each in parallel', () => {
  it('ends with 1000 rows and no busy error', async () => {
    const setup = open()
    await setup.createTable({ nome: 'carga', colunas: [{ nome: 'agente', tipo: 'texto' }, { nome: 'n', tipo: 'inteiro' }] }, AGENT)
    const agents = Array.from({ length: 10 }, (_, index) => ({ id: `agente-${index}`, service: open({ busyTimeoutMs: 15_000 }) }))
    const outcomes = await Promise.allSettled(agents.map(async ({ id, service }) => {
      for (let n = 0; n < 100; n++) {
        await service.execute({ sql: 'INSERT INTO carga (agente, n) VALUES (?, ?)', parametros: [id, n] }, { agent: id })
      }
    }))
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toEqual([])
    const total = await setup.query({ sql: 'SELECT count(*) AS c, count(DISTINCT agente) AS a FROM carga' }, AGENT)
    expect(total.linhas).toEqual([{ c: 1000, a: 10 }])
    const authors = await setup.query({ sql: 'SELECT count(*) AS c FROM carga WHERE agente = autor' }, AGENT)
    expect(authors.linhas).toEqual([{ c: 1000 }])
  }, 60_000)
})

describe('criterion 7: concurrent compare-and-set', () => {
  it('lets one of two parallel UPDATEs win', async () => {
    const a = open()
    const b = open()
    await a.createTable(NOTES, AGENT)
    await a.execute({ sql: 'INSERT INTO notas (v) VALUES (0)' }, AGENT)
    const sql = 'UPDATE notas SET v = v + 1 WHERE id = 1 AND revisao = ?'
    const results = await Promise.all([
      a.execute({ sql, parametros: [1] }, { agent: 'a' }),
      b.execute({ sql, parametros: [1] }, { agent: 'b' }),
    ])
    expect(results.map(result => result.linhasAfetadas).sort()).toEqual([0, 1])
    expect((await a.query({ sql: 'SELECT v, revisao FROM notas' }, AGENT)).linhas).toEqual([{ v: 1, revisao: 2 }])
  })
})

describe('criterion 8: deadline and cancellation', () => {
  it('cancels a command that overruns and keeps the database usable', async () => {
    const tables = open({ commandTimeoutMs: 400 })
    await tables.createTable(NOTES, AGENT)
    await tables.execute({ sql: 'INSERT INTO notas (v) VALUES (7)' }, AGENT)
    const started = Date.now()
    expect(await codeOf(tables.query({ sql: INFINITE }, AGENT))).toBe('cancelado')
    expect(Date.now() - started).toBeLessThan(5000)
    expect((await tables.query({ sql: 'SELECT v FROM notas' }, AGENT)).linhas).toEqual([{ v: 7 }])
  }, 30_000)

  it('rolls back a write that was cancelled mid-transaction', async () => {
    const tables = open({ commandTimeoutMs: 400 })
    await tables.createTable(NOTES, AGENT)
    const slow = tables.execute({
      sql: 'INSERT INTO notas (v) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c',
    }, AGENT)
    expect(await codeOf(slow)).toBe('cancelado')
    expect((await tables.query({ sql: 'SELECT count(*) AS c FROM notas' }, AGENT)).linhas).toEqual([{ c: 0 }])
  }, 30_000)

  it('stops on the caller signal, before or during the command', async () => {
    const tables = open()
    await tables.createTable(NOTES, AGENT)
    const early = new AbortController()
    early.abort()
    expect(await codeOf(tables.listTables({ ...AGENT, signal: early.signal }))).toBe('cancelado')
    const late = new AbortController()
    const running = tables.query({ sql: INFINITE }, { ...AGENT, signal: late.signal })
    setTimeout(() => { late.abort() }, 200)
    expect(await codeOf(running)).toBe('cancelado')
    expect((await tables.listTables(AGENT)).length).toBe(1)
  }, 30_000)
})

describe('audit trail', () => {
  it('records agent, operation, SQL and duration without parameter values', async () => {
    const tables = open()
    const seen: StorageTables.AuditEvent[] = []
    const stop = tables.onAudit(event => seen.push(event))
    await tables.createTable(NOTES, AGENT)
    await tables.execute({ sql: 'INSERT INTO notas (texto) VALUES (?)', parametros: ['segredo-123'] }, AGENT)
    await codeOf(tables.query({ sql: 'DROP TABLE notas' }, AGENT))
    stop()
    await tables.listTables(AGENT)
    expect(seen.map(event => [event.operation, event.ok, event.code])).toEqual([
      ['createTable', true, undefined], ['execute', true, undefined], ['query', false, 'sql_recusado'],
    ])
    expect(seen[1]).toMatchObject({ agent: 'agente-1', sql: ['INSERT INTO notas (texto) VALUES (?)'] })
    expect(seen[1]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(tables.auditLog())).not.toContain('segredo-123')
    expect(tables.auditLog()).toHaveLength(4)
  })

  it('keeps a bounded ring of audit records', async () => {
    const tables = open()
    for (let index = 0; index < 205; index++) await tables.listTables(AGENT)
    expect(tables.auditLog()).toHaveLength(200)
    expect(await codeOf(tables.batch([{ sql: 'x' }], AGENT))).toBe('argumento_invalido')
  })
})

describe('Worker lifecycle', () => {
  it('rejects calls after close and tolerates closing twice or before use', async () => {
    const unused = open()
    await unused.close()
    const tables = open()
    await tables.listTables(AGENT)
    await tables.close()
    await tables.close()
    expect(await codeOf(tables.listTables(AGENT))).toBe('interno')
  })

  it('reports a Worker that cannot open its database and retries on the next call', async () => {
    const broken = open({ path: dir })
    expect(await codeOf(broken.listTables(AGENT))).toBe('interno')
    expect(await codeOf(broken.listTables(AGENT))).toBe('interno')
  })

  it('reports a Worker that dies or fails while a command runs', async () => {
    const options = { path, ...DEFAULT_LIMITS }
    const runner = new SqlRunner(options, 30_000)
    await runner.call('listTables', [])
    const internals = runner as unknown as { worker: Promise<import('node:child_process').ChildProcess> }
    const first = runner.call('query', [{ sql: INFINITE }])
    await new Promise(resolve => setTimeout(resolve, 150))
    ;(await internals.worker).emit('error', new Error('boom'))
    await expect(first).rejects.toMatchObject({ code: 'interno', message: expect.stringContaining('boom') })
    await runner.call('listTables', [])
    const second = runner.call('query', [{ sql: INFINITE }])
    await new Promise(resolve => setTimeout(resolve, 150))
    ;(await internals.worker).kill('SIGKILL')
    await expect(second).rejects.toMatchObject({ code: 'interno' })
    await runner.close()
  }, 30_000)

  it('serves a request that the engine does not know as a typed failure', async () => {
    const runner = new SqlRunner({ path, ...DEFAULT_LIMITS }, 30_000)
    await expect(runner.call('nao_existe' as never, [])).rejects.toMatchObject({ code: 'interno' })
    await runner.close()
  })
})

describe('configuration and plugin', () => {
  it('derives the database location from dshHome, DSH_HOME or the user home', async () => {
    const saved = process.env.DSH_HOME
    try {
      const withHome = new StorageTables.TablesService({ dshHome: dir })
      await withHome.createTable(NOTES, AGENT)
      await withHome.close()
      process.env.DSH_HOME = join(dir, 'env-home')
      const withEnv = new StorageTables.TablesService({})
      await withEnv.createTable(NOTES, AGENT)
      await withEnv.close()
      delete process.env.DSH_HOME
      await new StorageTables.TablesService({}).close()
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
    const check = new StorageTables.TablesService({ path: join(dir, 'data', 'tables.sqlite') })
    expect((await check.listTables(AGENT)).map(table => table.nome)).toEqual(['notas'])
    await check.close()
    const envCheck = new StorageTables.TablesService({ path: join(dir, 'env-home', 'data', 'tables.sqlite') })
    expect((await envCheck.listTables(AGENT)).map(table => table.nome)).toEqual(['notas'])
    await envCheck.close()
  })

  it('validates its configuration with the documented defaults', () => {
    const parsed = StorageTables.Config({ path: 'x.sqlite' }) as Required<StorageTables.Config>
    expect(parsed).toMatchObject({
      path: 'x.sqlite', maxDbBytes: 256 * 1024 * 1024, maxValueBytes: 1024 * 1024, commandTimeoutMs: 5000, busyTimeoutMs: 3000,
    })
  })

  it('provides ctx.tables and stops the Worker when the plugin is disposed', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(StorageTables, { path })
    await fiber
    const service = ctx.tables
    await service.createTable(NOTES, AGENT)
    expect((await service.listTables(AGENT)).length).toBe(1)
    await ctx.fiber.dispose()
    expect(await codeOf(service.listTables(AGENT))).toBe('interno')
  })
})
