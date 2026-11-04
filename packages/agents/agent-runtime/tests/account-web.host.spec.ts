/** Account entry through a real Loader, HTTP carrier, domains and frontend index. */
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import Workspace from '@deepseek-ai/dsh-workspace'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Frontend from '@deepseek-ai/dsh-host-frontend-static'
import { it, expect, onTestFinished, vi } from 'vitest'
import { harness, inherited } from '../../agent-registry/tests/harness.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { materializeTlsFixture } from '../../../host/webserver/tests/tls-fixture.ts'
import * as Owners from '../src/owners.ts'
import * as Accounts from '../src/accounts.ts'
import * as AccountAuth from '../src/account-auth.ts'
import * as Web from '../src/account-web.ts'
import { copyFor, escapeHtml } from '../src/account-web-page.ts'

async function fixture(maxSessions = 1000, tls = false) {
  await mkdir('.dsh-test', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.dsh-test/account-web-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const { ctx } = await harness(root)
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Workspace)
  await ctx.plugin(Typert)
  await ctx.plugin(Query, { path: ':memory:' })
  await ctx.plugin(Gateway)
  await createSessionTestController(ctx, { defaultModelSelection: () => inherited, cwd: root })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, http: HttpServer, credentials: LocalCredentials,
    connection: Connection, accounts: Accounts, auth: AccountAuth, owners: Owners, web: Web, frontend: Frontend })
  const distIndex = join(root, 'index.html')
  await writeFile(distIndex, '<head></head><body>account shell</body>')
  const certificate = tls ? await materializeTlsFixture(join(root, 'tls')) : undefined
  const config = join(root, 'cordis.yml')
  await writeFile(config, `
- name: cordis:http
  config: {host: '127.0.0.1', port: 0${certificate === undefined ? '' : `, tls: {certFile: '${certificate.certFile}', keyFile: '${certificate.keyFile}'}`}}
- name: cordis:credentials
  config: {path: '${join(root, 'credentials.yml')}', watch: false}
- name: cordis:connection
- name: cordis:owners
- name: cordis:accounts
  config: {tokenDirectory: '${join(root, 'tokens')}'}
- name: cordis:auth
- id: account-web
  name: cordis:web
  config: {sessionMinutes: 1, maxSessions: ${maxSessions}}
- name: cordis:frontend
  config: {distIndex: '${distIndex}', loginPath: '/account/login'}
`)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const origin = ctx.webServer.getOrigin()
  const call = (path: string, init?: RequestInit) => fetch(origin + path, { ...init, redirect: 'manual' })
  const post = (path: string, fields: Record<string, string>, cookie = '', extras: Record<string, string> = {}) => call(path, {
    method: 'POST', headers: { origin, cookie, ...extras }, body: new URLSearchParams(fields),
  })
  const mint = async (name: string) => {
    const result = await ctx.accounts.create(name)
    return { ...result, token: (await readFile(result.tokenFile, 'utf8')).trim() }
  }
  const login = async (token: string, prior = '') => {
    const response = await post('/account/login', { token }, prior)
    expect(response.status).toBe(303)
    const cookies = response.headers.getSetCookie()
    const cookie = cookies.find(value => value.startsWith('dsh-account-session='))!.split(';')[0]!
    return { response, cookie }
  }
  return { ctx, root, origin, call, post, mint, login, certificate }
}

it('exchanges the token without echo, renders and calls as the account, and removes owner authority', async () => {
  const f = await fixture()
  const a = await f.mint('A <script>'), b = await f.mint('B')
  const anonymous = await f.call('/')
  expect(anonymous.status).toBe(303)
  expect(anonymous.headers.get('location')).toBe('/account/login')
  const page = await f.call('/account/login', { headers: { 'accept-language': 'pt-BR' } })
  const html = await page.text()
  expect(html).toMatchSnapshot()
  expect(html).toContain('Entrar na conta')
  expect(html).toContain('type="password"')
  expect(html).toContain('autocomplete="off"')
  expect(html).not.toMatch(/<script|localStorage|sessionStorage/)
  expect(page.headers.get('cache-control')).toBe('no-store')
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  const launch = await fetch(f.ctx.connection.authenticatedUrl(f.origin), { redirect: 'manual' })
  const owner = launch.headers.getSetCookie()[0]!.split(';')[0]!
  const aLogin = await f.login(a.token, owner), bLogin = await f.login(b.token)
  expect(aLogin.response.headers.getSetCookie()[0]).toContain('Max-Age=0')
  const clean = await f.call('/?token=discard-me', { headers: { cookie: aLogin.cookie } })
  expect(clean.status).toBe(303)
  expect(clean.headers.get('location')).toBe('./')
  expect(await clean.text()).not.toContain('discard-me')
  expect((await f.call('/', { headers: { cookie: 'dsh-account-session=invalid; ' + owner } })).status).toBe(303)
  const sessionCookie = aLogin.response.headers.getSetCookie().find(value => value.startsWith('dsh-account-session='))!
  expect(sessionCookie).toContain('HttpOnly; SameSite=Strict')
  expect(sessionCookie).not.toMatch(/Max-Age|Expires/)
  expect(sessionCookie).not.toContain(a.token)
  const rendered: Connection.PeerScope[] = []
  f.ctx.on('webserver/index-inject', (_rows, peer) => { rendered.push(peer) })
  for (const cookie of [aLogin.cookie, bLogin.cookie]) {
    const response = await f.call('/', { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('account shell')
  }
  expect(rendered.map(peer => peer.principal)).toEqual([
    { kind: 'account', ownerId: a.account.id }, { kind: 'account', ownerId: b.account.id },
  ])
  const peer = rendered[0]!
  const created = await f.ctx.typertGateway.invoke({ peer, namespace: 'session', method: 'create', args: { request: {} } })
  if (typeof created !== 'object' || created === null || !('sessionId' in created) || typeof created.sessionId !== 'string') throw new Error('Session creation returned no id')
  expect(f.ctx.sessionOwners.ownerOf(SessionId(created.sessionId))).toBe(a.account.id)
  const other = await f.ctx.typertGateway.invoke({ peer: rendered[1]!, namespace: 'session', method: 'list', args: { _request: {} } })
  expect(JSON.stringify(other)).not.toContain(created.sessionId)
  const invalid = await f.call('/account/login', { method: 'POST', headers: { origin: f.origin }, body: new URLSearchParams({ token: '<script>secret</script>' }) })
  expect(invalid.status).toBe(401)
  expect(await invalid.text()).not.toContain('<script>secret')
  expect(await aLogin.response.text()).not.toContain(a.token)
  const access = await f.call('/account/access', { headers: { cookie: aLogin.cookie } })
  expect(await access.text()).toContain('A &lt;script&gt;')
  expect((await f.call('/api/absent', { headers: { cookie: 'dsh-account-session=invalid; ' + owner } })).status).toBe(401)
  const logout = await f.post('/account/logout', {}, aLogin.cookie)
  expect(logout.status).toBe(303)
  expect(peer.signal.aborted).toBe(true)
  expect((await f.call('/api/absent', { headers: { cookie: aLogin.cookie } })).status).toBe(401)
  // Only token-delivery files may contain the account token.
  for (const entry of await readdir(join(f.root, 'data/accounts/credentials'))) {
    expect(await readFile(join(f.root, 'data/accounts/credentials', entry), 'utf8')).not.toContain(a.token)
  }
})

it('grants only from the signed-in account, confirms revocation and preserves other accounts', async () => {
  const f = await fixture()
  const a = await f.mint('A'), b = await f.mint('B'), c = await f.mint('C')
  const { cookie } = await f.login(a.token)
  await f.ctx.accountGrants.grant(b.account.id, c.account.id)
  const request = { action: 'grant', account_id: b.account.id }
  expect((await f.post('/account/access', request, cookie)).status).toBe(303)
  expect(f.ctx.accountGrants.allows(a.account.id, b.account.id)).toBe(true)
  expect(f.ctx.accountGrants.allows(b.account.id, a.account.id)).toBe(false)
  let page = await (await f.call('/account/access', { headers: { cookie } })).text()
  expect(page).toContain(b.account.id)
  expect(page).not.toContain(c.account.id)
  const confirmation = await f.call('/account/access?revoke=' + b.account.id, { headers: { cookie } })
  expect(await confirmation.text()).toContain('Confirm revocation')
  expect(f.ctx.accountGrants.allows(a.account.id, b.account.id)).toBe(true)
  expect((await f.post('/account/access', { action: 'revoke', account_id: b.account.id }, cookie)).status).toBe(303)
  expect(f.ctx.accountGrants.list(a.account.id)).toEqual([])
  expect(f.ctx.accountGrants.list(b.account.id)).toEqual([c.account.id])
  expect((await f.post('/account/access', { action: 'revoke', account_id: b.account.id }, cookie)).status).toBe(404)
  for (const fields of [{ action: 'grant', account_id: '' }, { action: 'grant', account_id: a.account.id },
    { action: 'grant', account_id: b.account.id, ownerId: b.account.id }, { action: 'unknown', account_id: b.account.id }]) {
    expect((await f.post('/account/access', fields, cookie)).status).toBe(400)
  }
  expect((await f.call('/account/access?revoke=' + c.account.id, { headers: { cookie } })).status).toBe(404)
  const failure = vi.spyOn(f.ctx.accountGrants, 'grant').mockRejectedValueOnce(new Error('sensitive-body'))
  const failed = await f.post('/account/access', { action: 'grant', account_id: b.account.id }, cookie)
  expect(failed.status).toBe(500)
  expect(await failed.text()).not.toContain('sensitive-body')
  expect(f.ctx.accountGrants.list(a.account.id)).toEqual([])
  failure.mockRestore()
  const htmlId = '<img src=x onerror=alert(1)>'
  await f.post('/account/access', { action: 'grant', account_id: htmlId }, cookie)
  page = await (await f.call('/account/access', { headers: { cookie } })).text()
  expect(page).toContain('&lt;img')
  expect(page).not.toContain('<img')
})

it('refuses cross-origin, rebound, oversized, duplicated and non-form submissions', async () => {
  const f = await fixture()
  const a = await f.mint('A')
  for (const extras of [{ origin: 'https://evil.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    expect((await f.post('/account/login', { token: a.token }, '', extras)).status, JSON.stringify(extras)).toBe(403)
  }
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(f.origin + '/account/login', { method: 'POST', headers: { host: 'evil.test', origin: f.origin } }, (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    request.on('error', reject)
    request.end()
  })
  expect(rebound).toBe(403)
  expect((await f.call('/account/login?token=' + a.token)).status).toBe(400)
  expect((await f.call('/account/login', { method: 'PUT' })).status).toBe(405)
  expect((await f.call('/account/login', { method: 'POST', body: 'token=' + a.token })).status).toBe(403)
  const raw = (body: string, type = 'application/x-www-form-urlencoded') => f.call('/account/login', {
    method: 'POST', headers: { origin: f.origin, 'content-type': type }, body,
  })
  expect((await raw('token=' + 'x'.repeat(5000))).status).toBe(400)
  expect((await raw('token=a&token=b')).status).toBe(400)
  expect((await raw('{}', 'application/json')).status).toBe(400)
  expect((await f.call('/account/login', { method: 'HEAD' })).status).toBe(200)
})

it('invalidates sessions on disable, expiry, capacity, replacement and unload', async () => {
  const f = await fixture(1)
  const a = await f.mint('A'), b = await f.mint('B')
  const first = await f.login(a.token)
  expect((await f.post('/account/login', { token: b.token })).status).toBe(503)
  const second = await f.login(a.token, first.cookie)
  expect((await f.call('/api/absent', { headers: { cookie: first.cookie } })).status).toBe(401)
  await f.ctx.accounts.disable(a.account.id)
  expect((await f.call('/api/absent', { headers: { cookie: second.cookie } })).status).toBe(401)
  expect((await f.post('/account/login', { token: a.token })).status).toBe(401)
  await f.ctx.accounts.reactivate(a.account.id)
  expect((await f.call('/api/absent', { headers: { cookie: second.cookie } })).status).toBe(401)
  const third = await f.login(a.token)
  const admission = f.ctx.connection.admit({ headers: { host: new URL(f.origin).host, cookie: third.cookie } })
  if (!('peer' in admission)) throw new Error('test account not admitted')
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => { vi.useRealTimers() })
  const replacement = await f.login(a.token, third.cookie)
  vi.setSystemTime(Date.now() + 60_001)
  expect((await f.call('/api/absent', { headers: { cookie: replacement.cookie } })).status).toBe(401)
  expect(admission.peer.signal.aborted).toBe(true)
  vi.useRealTimers()
  const last = await f.login(a.token)
  await [...f.ctx.loader.entries()].find(entry => entry.options.id === 'account-web')!.fiber!.dispose()
  expect((await f.call('/account/login')).status).toBe(404)
  expect((await f.call('/api/absent', { headers: { cookie: last.cookie } })).status).toBe(401)
})

it('escapes every HTML delimiter and selects the page language', () => {
  expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  expect(copyFor(undefined).language).toBe('en')
  expect(copyFor('pt-BR, en;q=0.5').language).toBe('pt-BR')
})

it('marks account cookies Secure on a real TLS listener and binds them to its origin', async () => {
  const f = await fixture(1000, true)
  if (f.certificate === undefined) throw new Error('TLS material missing')
  const ca = f.certificate.ca
  const a = await f.mint('TLS account')
  const send = (path: string, body?: string, cookie = '') => new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpsRequest(f.origin + path, { ca, method: body === undefined ? 'GET' : 'POST',
      headers: { origin: f.origin, cookie, 'content-type': 'application/x-www-form-urlencoded' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => { resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    request.on('error', reject)
    request.end(body)
  })
  const login = await send('/account/login', new URLSearchParams({ token: a.token }).toString())
  expect(login.status).toBe(303)
  const cookie = login.headers['set-cookie']?.[0]
  if (cookie === undefined) throw new Error('TLS login did not issue a cookie')
  expect(cookie).toContain('; Secure')
  expect(cookie).not.toContain(a.token)
  const value = cookie.split(';')[0] ?? ''
  expect((await send('/', undefined, value)).status).toBe(200)
  expect(f.ctx.connection.admit({ headers: { host: 'localhost:4096', cookie: value } })).toEqual({ rejection: 401 })
})

it('refuses malformed access forms and missing grants and signs out anonymous browsers', async () => {
  const f = await fixture()
  const a = await f.mint('A'), b = await f.mint('B')
  expect((await f.call('/account/access')).headers.get('location')).toBe('/account/login')
  expect((await f.call('/account/logout')).status).toBe(405)
  expect((await f.post('/account/logout', {})).status).toBe(303)
  const { cookie } = await f.login(a.token, 'malformed; dsh-account-session=missing')
  expect((await f.call('/account/access', { method: 'POST', headers: { origin: f.origin, cookie }, body: '{}' })).status).toBe(400)
  expect((await f.post('/account/access', { action: 'grant', account_id: 'x'.repeat(257) }, cookie)).status).toBe(400)
  await f.ctx.accountGrants.grant(a.account.id, b.account.id)
  expect((await f.call(`/account/access?revoke=${b.account.id}&revoke=${b.account.id}`, { headers: { cookie } })).status).toBe(404)
  expect((await f.call('/account/access?unexpected=1', { headers: { cookie } })).status).toBe(400)
  expect((await f.post('/account/logout', {}, 'dsh-account-session=missing')).status).toBe(303)
})

it('expires idle sessions through the timer and prunes expired capacity before a login', async () => {
  const f = await fixture(1)
  const a = await f.mint('A')
  const timer = vi.spyOn(globalThis, 'setTimeout')
  onTestFinished(() => timer.mockRestore())
  const { cookie } = await f.login(a.token)
  const expire = timer.mock.calls.find(([, delay]) => delay === 60_000)?.[0]
  if (expire === undefined) throw new Error('session timer missing')
  expire()
  expect((await f.call('/account/access', { headers: { cookie } })).headers.get('location')).toBe('/account/login')
  await f.login(a.token)
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => { vi.useRealTimers() })
  vi.setSystemTime(Date.now() + 60_001)
  await f.login(a.token)
})

it('rechecks the account after a streamed form and rejects a session invalidated while reading', async () => {
  const f = await fixture()
  const a = await f.mint('A'), b = await f.mint('B')
  const { cookie } = await f.login(a.token)
  const reading = Promise.withResolvers<undefined>()
  const get = f.ctx.accounts.get.bind(f.ctx.accounts)
  const authenticate = vi.spyOn(f.ctx.accounts, 'get')
  onTestFinished(() => authenticate.mockRestore())
  authenticate.mockImplementation((id) => {
    reading.resolve(undefined)
    return get(id)
  })
  const answer = new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(f.origin + '/account/access', { method: 'POST', headers: {
      origin: f.origin, cookie, 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked',
    } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.write('action=grant&')
    void reading.promise.then(async () => {
      authenticate.mockRestore()
      await f.ctx.accounts.disable(a.account.id)
      req.end('account_id=' + b.account.id)
    }).catch(reject)
  })
  expect(await answer).toBe(303)
  expect(f.ctx.accountGrants.list(a.account.id)).toEqual([])
})
