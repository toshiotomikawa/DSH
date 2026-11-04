import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, TablesEngine, hasTopLevelWhere } from '../src/engine.ts'
import type { EngineOptions } from '../src/engine.ts'
import { TablesError } from '../src/errors.ts'

let dir: string
let engine: TablesEngine

function open(overrides: Partial<EngineOptions> = {}): TablesEngine {
  return new TablesEngine({ path: join(dir, 'tables.sqlite'), ...DEFAULT_LIMITS, ...overrides })
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof TablesError) return error.code
    throw error
  }
  return 'ok'
}

function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

const NOTES = {
  nome: 'notas',
  colunas: [
    { nome: 'titulo', tipo: 'texto', obrigatoria: true },
    { nome: 'corpo', tipo: 'texto' },
    { nome: 'nota', tipo: 'inteiro', padrao: 0 },
  ],
} as const

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tables-'))
  engine = open()
})

afterEach(() => {
  engine.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('criterion 1: create and read back the schema', () => {
  it('returns exactly the declared columns plus the automatic ones', () => {
    const schema = engine.createTable(NOTES, 'agente-a')
    expect(schema.nome).toBe('notas')
    expect(schema.criador).toBe('agente-a')
    expect(schema.escopo).toBe('compartilhada')
    expect(schema.chavePrimaria).toEqual(['id'])
    expect(schema.colunas.map(column => [column.nome, column.tipo, column.obrigatoria, column.automatica])).toEqual([
      ['id', 'inteiro', true, true],
      ['titulo', 'texto', true, false],
      ['corpo', 'texto', false, false],
      ['nota', 'inteiro', false, false],
      ['criado_em', 'data_hora', true, true],
      ['atualizado_em', 'data_hora', true, true],
      ['revisao', 'inteiro', true, true],
      ['autor', 'texto', false, true],
    ])
    expect(schema.colunas.find(column => column.nome === 'nota')?.padrao).toBe(0)
    expect(engine.tableSchema('notas')).toEqual(schema)
    expect(engine.listTables()).toEqual([
      { nome: 'notas', criador: 'agente-a', escopo: 'compartilhada', criadoEm: schema.criadoEm, linhas: 0 },
    ])
  })

  it('supports a declared primary key, every column type and defaults', () => {
    const schema = engine.createTable({
      nome: 'eventos',
      chavePrimaria: ['codigo', 'dia'],
      colunas: [
        { nome: 'codigo', tipo: 'texto' },
        { nome: 'dia', tipo: 'data_hora' },
        { nome: 'valor', tipo: 'real', padrao: 1.5 },
        { nome: 'ativo', tipo: 'booleano', padrao: true },
        { nome: 'inativo', tipo: 'booleano', padrao: false },
        { nome: 'extra', tipo: 'json', padrao: { a: "o'k" } },
        { nome: 'rotulo', tipo: 'texto', padrao: "d'água", obrigatoria: true },
      ],
    }, 'x')
    expect(schema.chavePrimaria).toEqual(['codigo', 'dia'])
    expect(schema.colunas.filter(column => column.chavePrimaria).map(column => column.nome)).toEqual(['codigo', 'dia'])
    engine.execute({ sql: "INSERT INTO eventos (codigo, dia) VALUES ('a', '2026-01-02T03:04:05Z')" }, 'x')
    const row = engine.query({ sql: 'SELECT * FROM eventos' }).linhas[0]
    expect(row).toMatchObject({ codigo: 'a', valor: 1.5, ativo: 1, inativo: 0, extra: '{"a":"o\'k"}', rotulo: "d'água", revisao: 1, autor: 'x' })
  })

  it('refuses invalid creation requests', () => {
    expect(codeOf(() => engine.createTable({ ...NOTES, nome: 'Maiusculo' }, 'a'))).toBe('nome_invalido')
    expect(codeOf(() => engine.createTable({ ...NOTES, nome: 'x'.repeat(49) }, 'a'))).toBe('nome_invalido')
    expect(codeOf(() => engine.createTable({ ...NOTES, nome: 'sqlite_x' }, 'a'))).toBe('nome_invalido')
    expect(codeOf(() => engine.createTable({ ...NOTES, nome: '_dsh_x' }, 'a'))).toBe('nome_invalido')
    expect(codeOf(() => engine.createTable({ ...NOTES, nome: 5 as unknown as string }, 'a'))).toBe('nome_invalido')
    expect(codeOf(() => engine.createTable({ nome: 'v', colunas: [] }, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.createTable({ nome: 'v', colunas: 'x' as never }, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.createTable({ nome: 'v', colunas: [{ nome: 'revisao', tipo: 'texto' }] }, 'a'))).toBe('nome_invalido')
    expect(codeOf(() => engine.createTable({ nome: 'v', colunas: [{ nome: 'id', tipo: 'texto' }] }, 'a'))).toBe('nome_invalido')
    expect(codeOf(() => engine.createTable({ nome: 'v', colunas: [{ nome: 'a', tipo: 'texto' }, { nome: 'a', tipo: 'texto' }] }, 'a'))).toBe('nome_invalido')
    expect(codeOf(() => engine.createTable({ nome: 'v', colunas: [{ nome: 'a', tipo: 'xml' as never }] }, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.createTable({ nome: 'v', colunas: [{ nome: 'a', tipo: 'texto' }], chavePrimaria: [] }, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.createTable({ nome: 'v', colunas: [{ nome: 'a', tipo: 'texto' }], chavePrimaria: ['b'] }, 'a'))).toBe('argumento_invalido')
    for (const [tipo, padrao] of [['inteiro', 1.5], ['real', 'x'], ['booleano', 1], ['texto', 3]] as const) {
      expect(codeOf(() => engine.createTable({ nome: 'v', colunas: [{ nome: 'a', tipo, padrao }] }, 'a'))).toBe('argumento_invalido')
    }
    expect(engine.listTables()).toEqual([])
  })

  it('refuses a name that already exists without overwriting', () => {
    engine.createTable(NOTES, 'a')
    engine.execute({ sql: "INSERT INTO notas (titulo) VALUES ('t')" }, 'a')
    expect(codeOf(() => engine.createTable({ nome: 'notas', colunas: [{ nome: 'z', tipo: 'texto' }] }, 'b'))).toBe('ja_existe')
    expect(engine.listTables()[0]?.linhas).toBe(1)
    expect(engine.tableSchema('notas').criador).toBe('a')
  })

  it('reports an unknown table with similar names', () => {
    engine.createTable(NOTES, 'a')
    engine.createTable({ nome: 'notinhas', colunas: [{ nome: 'v', tipo: 'texto' }] }, 'a')
    expect(messageOf(() => engine.tableSchema('notin'))).toMatch(/notas, notinhas|notinhas, notas/)
    const message = messageOf(() => engine.tableSchema('nota'))
    expect(message).toContain('não existe')
    expect(message).toContain('notas')
    expect(messageOf(() => engine.tableSchema('zzzzzzzzzz'))).not.toContain('parecidas')
    expect(codeOf(() => engine.tableSchema(7 as unknown as string))).toBe('nao_existe')
    const missing = messageOf(() => engine.query({ sql: 'SELECT * FROM notass' }))
    expect(missing).toContain('notas')
    expect(codeOf(() => engine.query({ sql: 'SELECT * FROM notass' }))).toBe('nao_existe')
  })
})

describe('criterion 2: parameters are never interpolated', () => {
  it('stores quotes and a DROP TABLE text literally', () => {
    engine.createTable(NOTES, 'a')
    const hostile = "x'); DROP TABLE notas; --"
    engine.execute({ sql: 'INSERT INTO notas (titulo, corpo) VALUES (?, ?)', parametros: [hostile, '"; DROP TABLE notas;'] }, 'a')
    const rows = engine.query({ sql: 'SELECT titulo, corpo FROM notas' }).linhas
    expect(rows).toEqual([{ titulo: hostile, corpo: '"; DROP TABLE notas;' }])
    expect(engine.listTables().map(table => table.nome)).toEqual(['notas'])
  })

  it('binds named parameters, booleans, nulls, objects and returns plain values', () => {
    engine.createTable(NOTES, 'a')
    engine.execute({ sql: 'INSERT INTO notas (titulo, corpo, nota) VALUES (:t, :c, :n)', parametros: { t: 'a', c: null, n: true } }, 'a')
    engine.execute({ sql: 'INSERT INTO notas (titulo, corpo) VALUES (?, ?)', parametros: ['b', { k: [1, 2] }] }, 'a')
    const result = engine.query({
      sql: 'SELECT titulo, corpo, nota, x\'41\' AS bruto, 9007199254740993 AS grande FROM notas ORDER BY id',
    })
    expect(result.colunas).toEqual(['titulo', 'corpo', 'nota', 'bruto', 'grande'])
    expect(result.linhas[0]).toMatchObject({ titulo: 'a', corpo: null, nota: 1, bruto: 'QQ==' })
    expect(result.linhas[1]).toMatchObject({ corpo: '{"k":[1,2]}' })
    expect(engine.query({ sql: 'SELECT :a AS a, :b AS b', parametros: { a: null, b: 2 } }).linhas).toEqual([{ a: null, b: 2 }])
    expect(engine.query({ sql: 'SELECT ? AS a', parametros: [undefined as never] }).linhas).toEqual([{ a: null }])
    expect(codeOf(() => engine.query({ sql: 'SELECT 1 AS a', parametros: [1] }))).toBe('argumento_invalido')
  })

  it('refuses unsupported parameter types and oversized values', () => {
    engine.createTable(NOTES, 'a')
    expect(codeOf(() => engine.query({ sql: 'SELECT ?', parametros: [(() => 1) as never] }))).toBe('argumento_invalido')
    const small = open({ path: join(dir, 'small.sqlite'), maxValueBytes: 4 })
    small.createTable(NOTES, 'a')
    expect(codeOf(() => small.execute({ sql: 'INSERT INTO notas (titulo) VALUES (?)', parametros: ['12345'] }, 'a'))).toBe('valor_grande')
    small.execute({ sql: 'INSERT INTO notas (titulo) VALUES (?)', parametros: ['1234'] }, 'a')
    small.close()
  })
})

describe('criterion 3: only the expected statement is admitted', () => {
  beforeEach(() => {
    engine.createTable(NOTES, 'a')
  })

  it('refuses writes, ATTACH, PRAGMA and multiple statements in a query', () => {
    const before = statSync(join(dir, 'tables.sqlite')).mtimeMs
    for (const sql of [
      "INSERT INTO notas (titulo) VALUES ('x')",
      "ATTACH DATABASE ':memory:' AS outro",
      'PRAGMA user_version',
      'SELECT 1; SELECT 2',
      'SELECT 1; DROP TABLE notas',
      'DROP TABLE notas',
      'CREATE TABLE zz (a)',
      'VACUUM',
      'BEGIN',
      'WITH x AS (SELECT 1) DELETE FROM notas',
      "UPDATE notas SET titulo = 'x'",
    ]) {
      expect(codeOf(() => engine.query({ sql })), sql).toBe('sql_recusado')
    }
    expect(engine.listTables()[0]?.linhas).toBe(0)
    expect(statSync(join(dir, 'tables.sqlite')).mtimeMs).toBe(before)
  })

  it('accepts one statement with separators, comments and a CTE', () => {
    expect(engine.query({ sql: '/* a */ SELECT 1 AS x; -- fim\n ; ' }).linhas).toEqual([{ x: 1 }])
    expect(engine.query({ sql: 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT sum(n) AS s FROM c' }).linhas)
      .toEqual([{ s: 6 }])
    expect(engine.query({ sql: "SELECT ';' AS texto" }).linhas).toEqual([{ texto: ';' }])
  })

  it('does not treat a semicolon inside a parameter as a second statement', () => {
    engine.execute({ sql: 'INSERT INTO notas (titulo) VALUES (?)', parametros: ['a; DROP TABLE notas'] }, 'a')
    expect(engine.query({ sql: 'SELECT titulo FROM notas WHERE titulo = ?', parametros: ['a; DROP TABLE notas'] }).linhas).toHaveLength(1)
  })

  it('hides the internal tables and sqlite_master from free SQL', () => {
    for (const sql of ['SELECT * FROM sqlite_master', 'SELECT * FROM _dsh_meta', 'SELECT * FROM _dsh_ctx']) {
      expect(codeOf(() => engine.query({ sql }) ), sql).toBe('sql_recusado')
    }
    for (const sql of ["DELETE FROM _dsh_meta WHERE nome = 'notas'", "UPDATE _dsh_ctx SET agente = 'x' WHERE id = 1"]) {
      expect(codeOf(() => engine.execute({ sql }, 'a')), sql).toBe('sql_recusado')
    }
    expect(engine.tableSchema('notas').nome).toBe('notas')
  })

  it('execute accepts only INSERT, UPDATE and DELETE', () => {
    for (const sql of ['SELECT 1', 'DROP TABLE notas', 'ALTER TABLE notas ADD COLUMN z TEXT', 'PRAGMA user_version = 9', 'ATTACH DATABASE \':memory:\' AS o']) {
      expect(codeOf(() => engine.execute({ sql }, 'a')), sql).toBe('sql_recusado')
    }
    expect(codeOf(() => engine.execute({ sql: "INSERT INTO notas (titulo) VALUES ('a'); INSERT INTO notas (titulo) VALUES ('b')" }, 'a'))).toBe('sql_recusado')
    expect(codeOf(() => engine.execute({ sql: '' }, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.query({ sql: 3 as never }))).toBe('argumento_invalido')
    expect(engine.listTables()[0]?.linhas).toBe(0)
  })

  it('reports SQL syntax errors without writing', () => {
    expect(codeOf(() => engine.query({ sql: 'SELEC 1' }))).toBe('argumento_invalido')
    expect(codeOf(() => engine.execute({ sql: 'INSERT INTO notas (nada) VALUES (1)' }, 'a'))).toBe('argumento_invalido')
  })
})

describe('criterion 4: paging with a continuation cursor', () => {
  it('returns 200 rows, truncado and a cursor that delivers the rest in two calls', () => {
    engine.createTable({ nome: 'n', colunas: [{ nome: 'v', tipo: 'inteiro' }] }, 'a')
    engine.batch(Array.from({ length: 100 }, () => ({ sql: 'INSERT INTO n (v) WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < 5) SELECT x FROM s' })), 'a')
    expect(engine.query({ sql: 'SELECT count(*) AS c FROM n' }).linhas).toEqual([{ c: 500 }])
    const sql = 'SELECT id FROM n ORDER BY id'
    const first = engine.query({ sql })
    expect(first.linhas).toHaveLength(200)
    expect(first.truncado).toBe(true)
    expect(first.cursor).toBeTypeOf('string')
    const second = engine.query({ sql, cursor: first.cursor })
    expect(second.linhas).toHaveLength(200)
    expect(second.linhas[0]).toEqual({ id: 201 })
    expect(second.truncado).toBe(true)
    const third = engine.query({ sql, cursor: second.cursor })
    expect(third.linhas).toHaveLength(100)
    expect(third.truncado).toBe(false)
    expect(third.cursor).toBeUndefined()
  })

  it('honors the page limit and refuses bad limits and foreign cursors', () => {
    engine.createTable({ nome: 'n', colunas: [{ nome: 'v', tipo: 'inteiro' }] }, 'a')
    engine.batch([{ sql: 'INSERT INTO n (v) WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < 30) SELECT x FROM s' }], 'a')
    const page = engine.query({ sql: 'SELECT id FROM n ORDER BY id', limite: 10 })
    expect(page.linhas).toHaveLength(10)
    expect(engine.query({ sql: 'SELECT id FROM n', limite: 30 }).truncado).toBe(false)
    for (const limite of [0, 1001, 1.5]) {
      expect(codeOf(() => engine.query({ sql: 'SELECT 1', limite }))).toBe('argumento_invalido')
    }
    expect(engine.query({ sql: 'SELECT id FROM n', limite: 1000 }).linhas).toHaveLength(30)
    expect(codeOf(() => engine.query({ sql: 'SELECT id FROM n ORDER BY id DESC', limite: 10, cursor: page.cursor }))).toBe('cursor_invalido')
    expect(codeOf(() => engine.query({ sql: 'SELECT 1', cursor: 'lixo' }))).toBe('cursor_invalido')
    const forged = Buffer.from(JSON.stringify({ o: -1, h: 'x' })).toString('base64url')
    expect(codeOf(() => engine.query({ sql: 'SELECT 1', cursor: forged }))).toBe('cursor_invalido')
  })
})

describe('criterion 5: UPDATE and DELETE need a WHERE', () => {
  beforeEach(() => {
    engine.createTable(NOTES, 'a')
    engine.batch([
      { sql: "INSERT INTO notas (titulo) VALUES ('um')" },
      { sql: "INSERT INTO notas (titulo) VALUES ('dois')" },
    ], 'a')
  })

  it('refuses without WHERE and accepts with permitir_tudo', () => {
    expect(codeOf(() => engine.execute({ sql: "UPDATE notas SET corpo = 'x'" }, 'a'))).toBe('sem_where')
    expect(codeOf(() => engine.execute({ sql: 'DELETE FROM notas' }, 'a'))).toBe('sem_where')
    expect(codeOf(() => engine.execute({ sql: "UPDATE notas SET corpo = (SELECT 'a' WHERE 1)" }, 'a'))).toBe('sem_where')
    expect(codeOf(() => engine.execute({ sql: "UPDATE notas SET corpo = 'WHERE'" }, 'a'))).toBe('sem_where')
    expect(engine.listTables()[0]?.linhas).toBe(2)
    expect(engine.execute({ sql: "UPDATE notas SET corpo = 'x'", permitirTudo: true }, 'a')).toEqual({ linhasAfetadas: 2, ultimoId: null })
    expect(engine.execute({ sql: "UPDATE notas SET corpo = 'y' WHERE titulo = ?", parametros: ['um'] }, 'a').linhasAfetadas).toBe(1)
    expect(engine.execute({ sql: 'DELETE FROM notas', permitirTudo: true }, 'a').linhasAfetadas).toBe(2)
  })

  it('detects a top-level WHERE only', () => {
    expect(hasTopLevelWhere("DELETE FROM t WHERE a = 'x'")).toBe(true)
    expect(hasTopLevelWhere('WITH c AS (SELECT 1 WHERE 1) DELETE FROM t')).toBe(false)
    expect(hasTopLevelWhere('DELETE FROM t /* WHERE */ -- WHERE')).toBe(false)
    expect(hasTopLevelWhere('delete from t where 1')).toBe(true)
  })
})

describe('criterion 7: compare-and-set on revisao', () => {
  it('lets one concurrent UPDATE win and gives the other zero affected rows', () => {
    engine.createTable(NOTES, 'a')
    engine.execute({ sql: "INSERT INTO notas (titulo) VALUES ('t')" }, 'a')
    const sql = 'UPDATE notas SET corpo = ? WHERE id = 1 AND revisao = ?'
    expect(engine.execute({ sql, parametros: ['de a', 1] }, 'a').linhasAfetadas).toBe(1)
    expect(engine.execute({ sql, parametros: ['de b', 1] }, 'b').linhasAfetadas).toBe(0)
    expect(engine.query({ sql: 'SELECT corpo, revisao, autor FROM notas' }).linhas).toEqual([{ corpo: 'de a', revisao: 2, autor: 'a' }])
    engine.execute({ sql: "UPDATE notas SET corpo = 'c' WHERE id = 1" }, 'c')
    expect(engine.query({ sql: 'SELECT revisao, autor FROM notas' }).linhas).toEqual([{ revisao: 3, autor: 'c' }])
  })

  it('stamps the author on insert and keeps an explicit one', () => {
    engine.createTable(NOTES, 'a')
    engine.execute({ sql: "INSERT INTO notas (titulo) VALUES ('t')" }, 'maria')
    engine.execute({ sql: "INSERT INTO notas (titulo, autor) VALUES ('u', 'outro')" }, 'maria')
    expect(engine.query({ sql: 'SELECT autor, revisao FROM notas ORDER BY id' }).linhas).toEqual([
      { autor: 'maria', revisao: 1 }, { autor: 'outro', revisao: 1 },
    ])
  })
})

describe('criterion 9: drop needs the confirmation', () => {
  it('fails without the matching confirmar and drops with it', () => {
    engine.createTable(NOTES, 'a')
    expect(codeOf(() => engine.dropTable({ tabela: 'notas', confirmar: 'outra' }, 'a'))).toBe('confirmacao')
    expect(codeOf(() => engine.dropTable({ tabela: 'notas', confirmar: undefined as never }, 'a'))).toBe('confirmacao')
    expect(engine.listTables()).toHaveLength(1)
    expect(engine.dropTable({ tabela: 'notas', confirmar: 'notas' }, 'a')).toEqual({ tabela: 'notas' })
    expect(engine.listTables()).toEqual([])
    expect(codeOf(() => engine.dropTable({ tabela: 'notas', confirmar: 'notas' }, 'a'))).toBe('nao_existe')
  })
})

describe('criterion 10: a batch is atomic', () => {
  beforeEach(() => {
    engine.createTable(NOTES, 'a')
  })

  it('leaves no effect of the first command when the second is invalid', () => {
    const run = () => engine.batch([
      { sql: "INSERT INTO notas (titulo) VALUES ('um')" },
      { sql: 'INSERT INTO notas (naoexiste) VALUES (1)' },
      { sql: "INSERT INTO notas (titulo) VALUES ('tres')" },
    ], 'a')
    try {
      run()
      expect.unreachable()
    } catch (error) {
      expect((error as TablesError).message).toContain('comando 2 de 3')
      expect((error as TablesError).details).toMatchObject({ indice: 1 })
    }
    expect(engine.listTables()[0]?.linhas).toBe(0)
  })

  it('rolls back on a constraint violation found while running', () => {
    const run = () => engine.batch([
      { sql: "INSERT INTO notas (titulo) VALUES ('um')" },
      { sql: 'INSERT INTO notas (titulo) VALUES (NULL)' },
    ], 'a')
    expect(codeOf(run)).toBe('restricao')
    expect(engine.listTables()[0]?.linhas).toBe(0)
  })

  it('commits a valid batch and bounds its size', () => {
    const results = engine.batch([
      { sql: 'INSERT INTO notas (titulo) VALUES (?)', parametros: ['a'] },
      { sql: 'INSERT INTO notas (titulo) VALUES (?)', parametros: ['b'] },
      { sql: "UPDATE notas SET corpo = 'x' WHERE titulo = 'a'" },
    ], 'a')
    expect(results).toEqual([
      { linhasAfetadas: 1, ultimoId: 1 }, { linhasAfetadas: 1, ultimoId: 2 }, { linhasAfetadas: 1, ultimoId: null },
    ])
    expect(codeOf(() => engine.batch([], 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.batch(undefined as never, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.batch(Array.from({ length: 101 }, () => ({ sql: 'DELETE FROM notas WHERE 0' })), 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.batch([{ sql: "UPDATE notas SET corpo = 'x'" }], 'a'))).toBe('sem_where')
    expect(messageOf(() => engine.batch([{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }], 'a'))).toContain('comando 1 de 2')
  })
})

describe('typed columns refuse wrong values without writing', () => {
  beforeEach(() => {
    engine.createTable({
      nome: 'tipos',
      colunas: [
        { nome: 'n', tipo: 'inteiro' },
        { nome: 'b', tipo: 'booleano' },
        { nome: 'j', tipo: 'json' },
        { nome: 'd', tipo: 'data_hora' },
      ],
    }, 'a')
  })

  it('rejects each wrong type and invalid json', () => {
    for (const [column, value] of [['n', 'texto'], ['b', 7], ['j', 'não é json'], ['d', 'ontem']] as const) {
      expect(codeOf(() => engine.execute({ sql: `INSERT INTO tipos (${column}) VALUES (?)`, parametros: [value] }, 'a')), column).toBe('restricao')
    }
    expect(engine.listTables()[0]?.linhas).toBe(0)
    engine.execute({ sql: 'INSERT INTO tipos (n, b, j, d) VALUES (?, ?, ?, ?)', parametros: [1, false, [1], '2026-01-01'] }, 'a')
    expect(engine.query({ sql: 'SELECT n, b, j, d FROM tipos' }).linhas).toEqual([{ n: 1, b: 0, j: '[1]', d: '2026-01-01' }])
  })
})

describe('alter table', () => {
  beforeEach(() => {
    engine.createTable(NOTES, 'a')
    engine.execute({ sql: "INSERT INTO notas (titulo) VALUES ('t')" }, 'a')
  })

  it('adds an optional column and keeps stamping revisao', () => {
    const schema = engine.alterTable({ tabela: 'notas', adicionarColuna: { nome: 'tag', tipo: 'texto' } }, 'a')
    expect(schema.colunas.map(column => column.nome)).toContain('tag')
    engine.execute({ sql: "UPDATE notas SET tag = 'x' WHERE id = 1" }, 'b')
    expect(engine.query({ sql: 'SELECT tag, revisao, autor FROM notas' }).linhas).toEqual([{ tag: 'x', revisao: 2, autor: 'b' }])
  })

  it('requires a default for a required column on a table with data', () => {
    expect(codeOf(() => engine.alterTable({ tabela: 'notas', adicionarColuna: { nome: 'obrig', tipo: 'texto', obrigatoria: true } }, 'a'))).toBe('argumento_invalido')
    const schema = engine.alterTable({ tabela: 'notas', adicionarColuna: { nome: 'obrig', tipo: 'texto', obrigatoria: true, padrao: 'z' } }, 'a')
    expect(schema.colunas.find(column => column.nome === 'obrig')).toMatchObject({ obrigatoria: true, padrao: 'z' })
    expect(engine.query({ sql: 'SELECT obrig FROM notas' }).linhas).toEqual([{ obrig: 'z' }])
  })

  it('refuses reserved, repeated and malformed column additions', () => {
    for (const nome of ['revisao', 'id', 'titulo', 'Ruim']) {
      expect(codeOf(() => engine.alterTable({ tabela: 'notas', adicionarColuna: { nome, tipo: 'texto' } }, 'a')), nome).toBe('nome_invalido')
    }
    expect(codeOf(() => engine.alterTable({ tabela: 'notas' }, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.alterTable({
      tabela: 'notas', adicionarColuna: { nome: 'a', tipo: 'texto' }, adicionarIndice: { nome: 'i', colunas: ['titulo'] },
    }, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.alterTable({ tabela: 'nada', adicionarColuna: { nome: 'a', tipo: 'texto' } }, 'a'))).toBe('nao_existe')
  })

  it('adds indexes, including a unique one that then enforces uniqueness', () => {
    const schema = engine.alterTable({ tabela: 'notas', adicionarIndice: { nome: 'por_titulo', colunas: ['titulo'], unica: true } }, 'a')
    expect(schema.indices).toEqual([{ nome: 'por_titulo', colunas: ['titulo'], unica: true }])
    expect(codeOf(() => engine.execute({ sql: "INSERT INTO notas (titulo) VALUES ('t')" }, 'a'))).toBe('restricao')
    const plain = engine.alterTable({ tabela: 'notas', adicionarIndice: { nome: 'por_nota', colunas: ['nota', 'id'] } }, 'a')
    expect(plain.indices[1]).toEqual({ nome: 'por_nota', colunas: ['nota', 'id'], unica: false })
    expect(codeOf(() => engine.alterTable({ tabela: 'notas', adicionarIndice: { nome: 'por_nota', colunas: ['nota'] } }, 'a'))).toBe('ja_existe')
    expect(codeOf(() => engine.alterTable({ tabela: 'notas', adicionarIndice: { nome: 'x', colunas: ['fantasma'] } }, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.alterTable({ tabela: 'notas', adicionarIndice: { nome: 'x', colunas: [] } }, 'a'))).toBe('argumento_invalido')
    expect(codeOf(() => engine.alterTable({ tabela: 'notas', adicionarIndice: { nome: 'X', colunas: ['id'] } }, 'a'))).toBe('nome_invalido')
  })

  it('fails to build a unique index over duplicate data and leaves no index behind', () => {
    engine.execute({ sql: "INSERT INTO notas (titulo) VALUES ('t')" }, 'a')
    expect(codeOf(() => engine.alterTable({ tabela: 'notas', adicionarIndice: { nome: 'u', colunas: ['titulo'], unica: true } }, 'a'))).toBe('restricao')
    expect(engine.tableSchema('notas').indices).toEqual([])
  })

  it('indexes the automatic id of a table without a declared key', () => {
    const schema = engine.alterTable({ tabela: 'notas', adicionarIndice: { nome: 'por_id', colunas: ['id'] } }, 'a')
    expect(schema.indices).toHaveLength(1)
  })

  it('indexes a declared key table by its declared columns', () => {
    engine.createTable({ nome: 'k', chavePrimaria: ['a'], colunas: [{ nome: 'a', tipo: 'texto' }] }, 'a')
    expect(engine.alterTable({ tabela: 'k', adicionarColuna: { nome: 'b', tipo: 'texto' } }, 'a').colunas.map(column => column.nome)).toContain('b')
    expect(engine.alterTable({ tabela: 'k', adicionarIndice: { nome: 'i', colunas: ['a'] } }, 'a').indices).toHaveLength(1)
    expect(codeOf(() => engine.alterTable({ tabela: 'k', adicionarIndice: { nome: 'j', colunas: ['id'] } }, 'a'))).toBe('argumento_invalido')
  })
})

describe('criterion 11: size ceiling', () => {
  it('refuses writes above the ceiling but keeps answering queries', () => {
    const small = open({ path: join(dir, 'cheio.sqlite'), maxDbBytes: 40_000 })
    small.createTable({ nome: 'n', colunas: [{ nome: 'v', tipo: 'texto' }] }, 'a')
    small.execute({ sql: 'INSERT INTO n (v) VALUES (hex(zeroblob(60000)))' }, 'a')
    expect(codeOf(() => small.execute({ sql: "INSERT INTO n (v) VALUES ('x')" }, 'a'))).toBe('banco_cheio')
    expect(codeOf(() => small.batch([{ sql: "INSERT INTO n (v) VALUES ('x')" }], 'a'))).toBe('banco_cheio')
    expect(codeOf(() => small.createTable({ nome: 'm', colunas: [{ nome: 'v', tipo: 'texto' }] }, 'a'))).toBe('banco_cheio')
    expect(codeOf(() => small.alterTable({ tabela: 'n', adicionarColuna: { nome: 'z', tipo: 'texto' } }, 'a'))).toBe('banco_cheio')
    expect(small.query({ sql: 'SELECT count(*) AS c FROM n' }).linhas).toEqual([{ c: 1 }])
    expect(small.listTables()).toHaveLength(1)
    small.close()
  })
})

describe('persistence and the database file', () => {
  it('survives a reopen and shares the catalog between connections', () => {
    engine.createTable(NOTES, 'a')
    engine.execute({ sql: "INSERT INTO notas (titulo) VALUES ('persistente')" }, 'a')
    const other = open()
    expect(other.listTables().map(table => [table.nome, table.linhas])).toEqual([['notas', 1]])
    expect(other.query({ sql: 'SELECT titulo FROM notas' }).linhas).toEqual([{ titulo: 'persistente' }])
    other.close()
  })

  it('opens an in-memory database and rethrows file-creation errors', () => {
    const memory = new TablesEngine({ path: ':memory:', ...DEFAULT_LIMITS })
    memory.createTable(NOTES, 'a')
    expect(memory.listTables()).toHaveLength(1)
    memory.close()
    expect(() => new TablesEngine({ path: dir, ...DEFAULT_LIMITS })).toThrow()
    expect(() => new TablesEngine({ path: join(dir, 'tables.sqlite', 'sub', 'x.sqlite'), ...DEFAULT_LIMITS })).toThrow()
  })

  it('maps other SQLite failures to typed errors', () => {
    engine.createTable(NOTES, 'a')
    expect(codeOf(() => engine.execute({ sql: "INSERT INTO notas (titulo, nota) VALUES ('a', 'x')" }, 'a'))).toBe('restricao')
    expect(codeOf(() => engine.query({ sql: 'SELECT json(?)', parametros: ['{'] }))).toBe('argumento_invalido')
    expect(codeOf(() => engine.query({ sql: 'SELECT abs(-9223372036854775808)' }))).toBe('argumento_invalido')
  })
})

describe('busy database', () => {
  it('reports ocupado with advice when another connection holds the write lock', () => {
    const impatient = open({ busyTimeoutMs: 20 })
    const blocker = new DatabaseSync(join(dir, 'tables.sqlite'))
    blocker.exec('BEGIN IMMEDIATE')
    try {
      const error = (() => {
        try {
          impatient.createTable(NOTES, 'a')
        } catch (caught) {
          return caught as TablesError
        }
        return undefined
      })()
      expect(error?.code).toBe('ocupado')
      expect(error?.message).toContain('tente de novo')
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
      impatient.close()
    }
  })
})
