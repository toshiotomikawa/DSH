import { describe, expect, it } from 'vitest'
import { TablesError, deserializeError, serializeError } from '../src/errors.ts'

describe('error serialization', () => {
  it('round-trips a typed error with its details', () => {
    const original = new TablesError('nao_existe', 'sumiu', { parecidas: ['a'] })
    const copy = deserializeError(JSON.parse(JSON.stringify(serializeError(original))))
    expect(copy).toBeInstanceOf(TablesError)
    expect(copy).toMatchObject({ code: 'nao_existe', message: 'sumiu', details: { parecidas: ['a'] } })
    expect(new TablesError('interno', 'x').details).toEqual({})
  })

  it('turns any other thrown value into interno', () => {
    expect(serializeError(new Error('falhou'))).toEqual({ code: 'interno', message: 'falhou', details: {} })
    expect(serializeError('texto solto')).toEqual({ code: 'interno', message: 'texto solto', details: {} })
  })
})
