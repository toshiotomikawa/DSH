/** Authenticated local HTTP entry that lets a script ask for one execution of a routine. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RoutineError } from './errors.ts'
import type { Run } from './types.ts'

/** Largest request body accepted, in bytes; the payload ceiling is smaller. */
export const MAX_BODY_BYTES = 64 * 1024

/** Path of the entry on the local web server. */
export const TRIGGER_PATH = '/agent-routines/trigger'

/** Engine surface the entry uses. */
export interface TriggerTarget {
  trigger: (routineId: string, request: { source: 'script'; payload?: unknown; idempotencyKey?: string }) => Promise<{ run: Run; duplicate: boolean }>
}

/**
 * Read the script token from its file, creating a random one the first time.
 * @param path - token file inside the harness home.
 * @returns the token.
 */
export async function loadToken(path: string): Promise<string> {
  try {
    const text = (await readFile(path, 'utf8')).trim()
    if (text !== '') return text
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const token = randomBytes(32).toString('hex')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  return token
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function reply(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const chunk = raw as Buffer
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      request.resume()
      throw new HttpFailure(413, 'corpo_grande', 'o corpo passa do limite')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const STATUS_BY_CODE: Record<string, number> = {
  rotina_inexistente: 404,
  script_nao_autorizado: 403,
  payload_grande: 413,
  payload_invalido: 400,
  chave_invalida: 400,
}

/**
 * Build the route handler. The token never reaches the engine, the run record or any response.
 * @param target - engine that accepts the run.
 * @param token - secret that callers send as a Bearer credential.
 * @param warn - sink for internal diagnostics, which never contain request data.
 * @returns the HTTP handler.
 */
export function createTriggerHandler(
  target: TriggerTarget,
  token: string,
  warn: (message: string) => void,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const expected = digest(token)
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new HttpFailure(405, 'metodo', 'use POST')
      }
      const header = request.headers.authorization ?? ''
      const given = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!timingSafeEqual(digest(given), expected)) throw new HttpFailure(401, 'nao_autorizado', 'credencial ausente ou inválida')
      if (!/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')) {
        throw new HttpFailure(415, 'tipo', 'envie application/json')
      }
      const text = await readBody(request)
      if (text.includes(token)) throw new HttpFailure(400, 'segredo_no_corpo', 'o corpo não pode conter a credencial')
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        throw new HttpFailure(400, 'json_invalido', 'o corpo não é JSON')
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpFailure(400, 'corpo_invalido', 'o corpo deve ser um objeto')
      }
      const { routineId, payload, idempotencyKey } = body as Record<string, unknown>
      if (typeof routineId !== 'string' || routineId === '') throw new HttpFailure(400, 'corpo_invalido', 'routineId é obrigatório')
      if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
        throw new HttpFailure(400, 'corpo_invalido', 'idempotencyKey deve ser texto')
      }
      const { run, duplicate } = await target.trigger(routineId, {
        source: 'script',
        ...payload === undefined ? {} : { payload },
        ...idempotencyKey === undefined ? {} : { idempotencyKey },
      })
      reply(response, 202, { runId: run.id, state: run.state, duplicate })
    } catch (error) {
      if (error instanceof HttpFailure) {
        reply(response, error.status, { error: error.code, message: error.message })
      } else if (error instanceof RoutineError) {
        reply(response, STATUS_BY_CODE[error.code] ?? 400, { error: error.code, message: error.message })
      } else {
        warn('agent-routine: trigger failed')
        reply(response, 503, { error: 'indisponivel', message: 'o serviço de rotinas não respondeu' })
      }
    }
  }
}
