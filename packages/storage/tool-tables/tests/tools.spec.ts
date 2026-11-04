/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-member-access, typescript/no-unsafe-call -- JSON parsed from text. */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as StorageTables from '@deepseek-ai/dsh-storage-tables'
import * as ToolTables from '../src/index.ts'

const signal = new AbortController().signal
let dir: string
let ctx: Context
let counter = 0

async function boot(provide?: (ctx: Context) => void | Promise<void>): Promise<Context> {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(NativeToolExecutor)
  if (provide === undefined) await context.plugin(StorageTables, { path: join(dir, 'tables-shared.sqlite'), commandTimeoutMs: 20_000 })
  else await provide(context)
  await context.plugin(ToolTables)
  return context
}

interface Outcome {
  readonly isError: boolean
  readonly text: string
  readonly json: any
}

async function call(name: string, args: unknown, agentId: string | null = 'agente-t', over: Context = ctx): Promise<Outcome> {
  const result = await executeToolFixture(over, {
    signal,
    callId: ToolCallId(`call-${++counter}`),
    name,
    arguments: args,
    ...agentId === null ? {} : { agent: { id: agentId } as never },
  })
  const text = result.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { isError: result.isError ?? false, text, json }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tool-tables-'))
  ctx = await boot()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const NOTES = {
  nome: 'notas',
  colunas: [{ nome: 'titulo', tipo: 'texto', obrigatoria: true }, { nome: 'nota', tipo: 'inteiro', padrao: 0 }],
}

describe('tool registration', () => {
  it('registers the eight tools with Portuguese field names', () => {
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual([
      'data_batch', 'data_execute', 'data_query', 'table_alter', 'table_create', 'table_drop', 'table_list', 'table_schema',
    ])
    const query = ctx.tools.schemas().find(schema => schema.name === 'data_query')
    expect(Object.keys((query?.parameters as { properties: object }).properties)).toEqual(['sql', 'parametros', 'limite', 'escopo'])
  })
})

describe('table tools', () => {
  it('creates a table and reads the schema back with the automatic columns (criterion 1)', async () => {
    const created = await call('table_create', NOTES)
    expect(created.isError).toBe(false)
    expect(created.json.criador).toBe('agente-t')
    const schema = await call('table_schema', { tabela: 'notas' })
    expect(schema.json.colunas.map((column: { nome: string }) => column.nome)).toEqual([
      'id', 'titulo', 'nota', 'criado_em', 'atualizado_em', 'revisao', 'autor',
    ])
    expect(schema.json.colunas[2]).toMatchObject({ tipo: 'inteiro', padrao: 0, automatica: false })
    expect((await call('table_list', {})).json.tabelas).toMatchObject([{ nome: 'notas', criador: 'agente-t', linhas: 0 }])
  })

  it('supports a declared primary key, indexes, new columns and dropping with confirmation', async () => {
    const created = await call('table_create', {
      nome: 'chaves', chave_primaria: ['codigo'], colunas: [{ nome: 'codigo', tipo: 'texto' }, { nome: 'dado', tipo: 'json', obrigatoria: false }],
    })
    expect(created.json.chavePrimaria).toEqual(['codigo'])
    const withColumn = await call('table_alter', { tabela: 'chaves', adicionar_coluna: { nome: 'extra', tipo: 'texto', padrao: 'x', obrigatoria: true } })
    expect(withColumn.json.colunas.map((column: { nome: string }) => column.nome)).toContain('extra')
    const withIndex = await call('table_alter', { tabela: 'chaves', adicionar_indice: { nome: 'por_extra', colunas: ['extra'], unica: false } })
    expect(withIndex.json.indices).toEqual([{ nome: 'por_extra', colunas: ['extra'], unica: false }])
    expect((await call('table_drop', { tabela: 'chaves', confirmar: 'outra' })).isError).toBe(true)
    expect((await call('table_drop', { tabela: 'chaves', confirmar: 'chaves' })).json).toEqual({ tabela: 'chaves' })
  })

  it('reports failures as `code: message`', async () => {
    await call('table_create', NOTES)
    const duplicate = await call('table_create', NOTES)
    expect(duplicate.isError).toBe(true)
    expect(duplicate.text).toContain('ja_existe:')
    const missing = await call('table_schema', { tabela: 'nota' })
    expect(missing.text).toContain('nao_existe:')
    expect(missing.text).toContain('notas')
    expect((await call('table_drop', { tabela: 'notas', confirmar: 'x' })).text).toContain('confirmacao:')
  })
})

describe('data tools', () => {
  beforeEach(async () => {
    await call('table_create', NOTES)
  })

  it('stores hostile text literally (criterion 2) and refuses non-SELECT queries (criterion 3)', async () => {
    const hostile = "x'); DROP TABLE notas; --"
    const inserted = await call('data_execute', { sql: 'INSERT INTO notas (titulo) VALUES (?)', parametros: [hostile] })
    expect(inserted.json).toEqual({ linhasAfetadas: 1, ultimoId: 1 })
    expect((await call('data_query', { sql: 'SELECT titulo, autor FROM notas' })).json.linhas).toEqual([{ titulo: hostile, autor: 'agente-t' }])
    expect((await call('data_query', { sql: 'SELECT titulo FROM notas WHERE titulo = ?', parametros: [hostile], limite: 5 })).json.linhas).toHaveLength(1)
    for (const sql of ["INSERT INTO notas (titulo) VALUES ('z')", "ATTACH DATABASE ':memory:' AS o", 'PRAGMA user_version', 'SELECT 1; SELECT 2']) {
      const refused = await call('data_query', { sql })
      expect(refused.isError, sql).toBe(true)
      expect(refused.text, sql).toContain('sql_recusado:')
    }
    expect((await call('table_list', {})).json.tabelas[0].linhas).toBe(1)
  })

  it('cuts at 200 rows (ceiling 1000) and flags truncado, with no cursor (criterion 4)', async () => {
    const insert = { sql: 'INSERT INTO notas (titulo) WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < 500) SELECT x FROM s' }
    await call('data_execute', insert)
    const sql = 'SELECT id FROM notas ORDER BY id'
    const first = await call('data_query', { sql })
    expect([first.json.linhas.length, first.json.truncado, first.json.cursor]).toEqual([200, true, undefined])
    const wide = await call('data_query', { sql, limite: 1000 })
    expect([wide.json.linhas.length, wide.json.truncado]).toEqual([500, false])
    expect((await call('data_query', { sql, limite: 1001 })).isError).toBe(true)
  })

  it('supports UNIQUE groups and upsert with ON CONFLICT', async () => {
    await call('table_create', { nome: 'placar', colunas: [{ nome: 'jogador', tipo: 'texto' }, { nome: 'pontos', tipo: 'inteiro' }], unicas: [['jogador']] })
    const upsert = {
      sql: 'INSERT INTO placar (jogador, pontos) VALUES (?, ?) ON CONFLICT (jogador) DO UPDATE SET pontos = excluded.pontos',
    }
    await call('data_execute', { ...upsert, parametros: ['ana', 1] })
    const again = await call('data_execute', { ...upsert, parametros: ['ana', 5] })
    expect(again.isError).toBe(false)
    expect((await call('data_query', { sql: 'SELECT jogador, pontos, revisao FROM placar' })).json.linhas).toEqual([{ jogador: 'ana', pontos: 5, revisao: 2 }])
    const duplicate = await call('data_execute', { sql: "INSERT INTO placar (jogador, pontos) VALUES ('ana', 9)" })
    expect(duplicate.text).toContain('restricao:')
    expect((await call('table_schema', { tabela: 'placar' })).json.indices).toEqual([{ nome: 'unica_1', colunas: ['jogador'], unica: true }])
  })

  it('refuses UPDATE and DELETE without WHERE unless permitir_tudo (criterion 5)', async () => {
    await call('data_execute', { sql: "INSERT INTO notas (titulo) VALUES ('a')" })
    const refused = await call('data_execute', { sql: 'UPDATE notas SET nota = 1' })
    expect(refused.text).toContain('sem_where:')
    expect((await call('data_execute', { sql: 'UPDATE notas SET nota = 1', permitir_tudo: true })).json).toEqual({ linhasAfetadas: 1 })
    expect((await call('data_execute', { sql: 'DELETE FROM notas WHERE id = ?', parametros: [1] })).json.linhasAfetadas).toBe(1)
  })

  it('lets only the first of two queued revisao updates win (the real two-process race is in service.spec, criterion 7)', async () => {
    await call('data_execute', { sql: "INSERT INTO notas (titulo) VALUES ('a')" })
    const sql = 'UPDATE notas SET nota = nota + 1 WHERE id = 1 AND revisao = ?'
    const [first, second] = await Promise.all([
      call('data_execute', { sql, parametros: [1] }, 'a'),
      call('data_execute', { sql, parametros: [1] }, 'b'),
    ])
    expect([first.json.linhasAfetadas, second.json.linhasAfetadas].sort()).toEqual([0, 1])
  })

  it('runs a batch atomically (criterion 10)', async () => {
    const bad = await call('data_batch', {
      comandos: [
        { sql: "INSERT INTO notas (titulo) VALUES ('um')" },
        { sql: 'INSERT INTO notas (inexistente) VALUES (1)' },
        { sql: "INSERT INTO notas (titulo) VALUES ('tres')" },
      ],
    })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('comando 2 de 3')
    expect((await call('table_list', {})).json.tabelas[0].linhas).toBe(0)
    const good = await call('data_batch', {
      comandos: [
        { sql: 'INSERT INTO notas (titulo) VALUES (?)', parametros: ['a'] },
        { sql: "UPDATE notas SET nota = 9 WHERE titulo = 'a'" },
        { sql: 'DELETE FROM notas', permitir_tudo: true },
      ],
    })
    expect(good.json.resultados).toEqual([{ linhasAfetadas: 1, ultimoId: 1 }, { linhasAfetadas: 1 }, { linhasAfetadas: 1 }])
  })

  it('records the calling agent, falling back when the call has none', async () => {
    await call('data_execute', { sql: "INSERT INTO notas (titulo) VALUES ('a')" }, null)
    expect((await call('data_query', { sql: 'SELECT autor FROM notas' })).json.linhas).toEqual([{ autor: 'sem-agente' }])
  })
})

describe('non-typed failures', () => {
  it('passes an unexpected error through unchanged', async () => {
    const fake = new Proxy({}, { get: () => () => Promise.reject(new Error('banco quebrou')) })
    const other = await boot((context) => { context.provide('tables', fake as never) })
    const outcome = await call('table_list', {}, 'agente-t', other)
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('banco quebrou')
    await other.fiber.dispose()
  })
})

describe('per-account table files', () => {
  it('routes an account to its own file and never opens another account file', async () => {
    await ctx.fiber.dispose()
    ctx = await boot(async (context) => {
      context.provide('sessionOwners', { ownerOf: (id: string) => id.startsWith('conta-a') ? 'a' : 'b' } as never)
      await context.plugin(StorageTables, { path: join(dir, 'tables-shared.sqlite'), commandTimeoutMs: 20_000 })
    })
    expect((await call('table_create', NOTES, 'conta-a')).json.escopo).toBe('privada')
    expect((await call('table_list', {}, 'conta-b')).json.tabelas).toEqual([])
    expect((await call('table_schema', { tabela: 'notas' }, 'conta-b')).text).toContain('nao_existe:')
    expect((await call('table_schema', { tabela: 'notas' }, 'conta-a')).isError).toBe(false)
    expect((await call('table_create', { ...NOTES, nome: 'comum', escopo: 'compartilhada' }, 'conta-b')).json.escopo).toBe('compartilhada')
    expect((await call('table_list', {}, 'conta-a')).json.tabelas.map((table: { nome: string }) => table.nome)).toEqual(['comum', 'notas'])
    const files = readdirSync(dir)
    expect(files).toContain('tables-a.sqlite')
    expect(files).toContain('tables-shared.sqlite')
    expect(files).not.toContain('tables-b.sqlite')
  })
})
