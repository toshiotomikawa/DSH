import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_BODY_BYTES, TRIGGER_PATH, createTriggerHandler, loadToken } from '../src/trigger.ts'
import { RoutineError } from '../src/errors.ts'
import { setup } from './harness.ts'
import type { Rig } from './harness.ts'

const TOKEN = 'segredo-de-teste-0123456789'
const open: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of open.splice(0)) await new Promise(done => server.close(done))
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function serve(rig: Rig, warnings: string[] = []): Promise<{ url: string; routineId: string }> {
  const routine = await rig.engine.createRoutine({ agentId: 'a1', name: 'Worker', instruction: 'Verifique o build.' })
  const handler = createTriggerHandler(rig.engine, TOKEN, (message) => { warnings.push(message) })
  const server = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  open.push(server)
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}${TRIGGER_PATH}`, routineId: routine.id }
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('criterion 7: script entry', () => {
  it('accepts an authenticated call, even for a paused routine, and starts one execution', async () => {
    const rig = setup()
    const { url, routineId } = await serve(rig)
    await rig.engine.editRoutine(routineId, { active: false })
    const response = await post(url, { routineId, payload: { fim: 'build', log: 'C:/logs/b.txt' }, idempotencyKey: 'k1' })
    expect(response.status).toBe(202)
    const body = await response.json() as { runId: string; state: string; duplicate: boolean }
    expect(body).toMatchObject({ state: 'execucao', duplicate: false })
    expect(rig.engine.run(body.runId)).toMatchObject({ source: 'script', manual: false })
    expect(rig.engine.view(routineId).routine.active).toBe(false)
    expect(rig.starts[0]?.prompt).toContain('"log":"C:/logs/b.txt"')
    const again = await (await post(url, { routineId, idempotencyKey: 'k1' })).json() as { runId: string; duplicate: boolean }
    expect(again).toEqual({ runId: body.runId, state: 'execucao', duplicate: true })
    expect(rig.starts).toHaveLength(1)
  })

  it('refuses a call without or with a wrong credential before reading the routine', async () => {
    const rig = setup()
    const { url, routineId } = await serve(rig)
    expect((await post(url, { routineId }, { authorization: '' })).status).toBe(401)
    expect((await post(url, { routineId }, { authorization: 'Bearer outro' })).status).toBe(401)
    expect((await post(url, { routineId }, { authorization: `Basic ${TOKEN}` })).status).toBe(401)
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401)
    expect(rig.starts).toEqual([])
    expect([...rig.store.runs.entries()]).toEqual([])
  })

  it('maps the other refusals to stable statuses', async () => {
    const rig = setup()
    const { url, routineId } = await serve(rig)
    expect((await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405)
    expect((await post(url, { routineId }, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(415)
    expect((await post(url, '{nope')).status).toBe(400)
    expect((await post(url, '[1]')).status).toBe(400)
    expect((await post(url, 'null')).status).toBe(400)
    expect((await post(url, {})).status).toBe(400)
    expect((await post(url, { routineId, idempotencyKey: 7 })).status).toBe(400)
    expect((await post(url, { routineId: 'nada' })).status).toBe(404)
    expect((await post(url, { routineId, payload: 'x'.repeat(17_000) })).status).toBe(413)
    expect((await post(url, { routineId, idempotencyKey: '' })).status).toBe(400)
    expect((await post(url, `{"routineId":"${routineId}","payload":"${'a'.repeat(MAX_BODY_BYTES)}"}`)).status).toBe(413)
    await rig.engine.editRoutine(routineId, { scriptEnabled: false })
    expect((await post(url, { routineId })).status).toBe(403)
    expect(rig.starts).toEqual([])
  })

  it('rejects a body that carries the credential, so it never lands in a prompt or a record', async () => {
    const rig = setup()
    const { url, routineId } = await serve(rig)
    const response = await post(url, { routineId, payload: { token: TOKEN } })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).not.toContain(TOKEN)
    expect(rig.starts).toEqual([])
  })

  it('never leaks the credential into runs, prompts, answers or logs', async () => {
    const rig = setup()
    const warnings: string[] = []
    const { url, routineId } = await serve(rig, warnings)
    const answers = [await (await post(url, { routineId, payload: { a: 1 } })).text()]
    answers.push(await (await post(url, { routineId: 'nada' })).text())
    const everything = JSON.stringify([answers, [...rig.store.runs.entries()], rig.starts, warnings, rig.warnings])
    expect(everything).not.toContain(TOKEN)
  })

  it('answers 503 without request data when the engine breaks', async () => {
    const warnings: string[] = []
    const handler = createTriggerHandler({ trigger: () => Promise.reject(new Error('boom com dados')) }, TOKEN, (message) => { warnings.push(message) })
    const server = createServer((request, response) => { void handler(request, response) })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    open.push(server)
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const response = await post(url, { routineId: 'r' })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('boom')
    expect(warnings).toEqual(['agent-routine: trigger failed'])
    const refused = createTriggerHandler({ trigger: () => Promise.reject(new RoutineError('desconhecido', 'x')) }, TOKEN, () => undefined)
    const second = createServer((request, response) => { void refused(request, response) })
    await new Promise<void>(done => second.listen(0, '127.0.0.1', done))
    open.push(second)
    const status = (await post(`http://127.0.0.1:${(second.address() as { port: number }).port}`, { routineId: 'r' })).status
    expect(status).toBe(400)
  })
})

describe('token file', () => {
  it('creates a random token once and reads it back', async () => {    const dir = await mkdtemp(join(tmpdir(), 'routine-token-'))
    dirs.push(dir)
    const path = join(dir, 'sub', 'agent-routines.token')
    const created = await loadToken(path)
    expect(created).toMatch(/^[0-9a-f]{64}$/)
    expect(await loadToken(path)).toBe(created)
    expect((await readFile(path, 'utf8')).trim()).toBe(created)
  })

  it('replaces an empty file and keeps an existing token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routine-token-'))
    dirs.push(dir)
    const path = join(dir, 'token')
    await writeFile(path, '  \n')
    const fresh = await loadToken(path)
    expect(fresh).toHaveLength(64)
    await writeFile(path, ' meu-token \n')
    expect(await loadToken(path)).toBe('meu-token')
  })

  it('fails loudly on a read error that is not a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routine-token-'))
    dirs.push(dir)
    await expect(loadToken(dir)).rejects.toThrow()
  })
})

describe('audit findings 7 and 9: token rotation and loopback', () => {
  it('reloads a rotated token and keeps the current one when the file is unreadable (audit 7)', async () => {
    const rig = setup()
    const routine = await rig.engine.createRoutine({ agentId: 'a1', name: 'Worker', instruction: 'x' })
    const dir = await mkdtemp(join(tmpdir(), 'routine-rotate-'))
    dirs.push(dir)
    const file = join(dir, 'token')
    await writeFile(file, `${TOKEN}\n`)
    const warnings: string[] = []
    const handler = createTriggerHandler(rig.engine, TOKEN, (message) => { warnings.push(message) }, file)
    const server = createServer((request, response) => { void handler(request, response) })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    open.push(server)
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    expect((await post(url, { routineId: routine.id })).status).toBe(202)
    await writeFile(file, 'novo-token\n')
    expect((await post(url, { routineId: routine.id })).status).toBe(401)
    expect((await post(url, { routineId: routine.id }, { authorization: 'Bearer novo-token' })).status).toBe(202)
    await rm(file)
    await mkdir(file)
    expect((await post(url, { routineId: routine.id }, { authorization: 'Bearer novo-token' })).status).toBe(202)
    expect(warnings.some(message => message.includes('keeping the current token'))).toBe(true)
  })

  it('refuses a non-loopback peer before checking the credential (audit 9)', async () => {
    let status = 0
    let body = ''
    const response = {
      setHeader: () => undefined,
      writeHead: (code: number) => { status = code },
      end: (value: string) => { body = value },
    } as unknown as ServerResponse
    const request = {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      socket: { remoteAddress: '10.0.0.7' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ routineId: 'r' })) },
    } as unknown as IncomingMessage
    const handler = createTriggerHandler({ trigger: () => Promise.reject(new Error('unreachable')) }, TOKEN, () => undefined)
    await handler(request, response)
    expect(status).toBe(403)
    expect(body).toContain('nao_local')
    const missingPeer = { method: 'POST', headers: request.headers, socket: {} } as unknown as IncomingMessage
    status = 0
    await handler(missingPeer, response)
    expect(status).toBe(403)
  })
})
