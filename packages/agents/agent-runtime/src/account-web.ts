/** Browser entry and directional agent grants without exposing account credentials to a model. @module */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type {} from './accounts.ts'
import type {} from './owners.ts'
import { copyFor, page, escapeHtml } from './account-web-page.ts'

/** Loader plugin name. */
export const name = 'account-web'
/** Account identity, directional grants and trusted HTTP carrier. */
export const inject = ['accounts', 'accountGrants', 'connection', 'webServer']
/** In-memory browser session bounds; omitted values use the documented defaults. */
export interface Config {
  /** Absolute lifetime in minutes, defaults to 720. */
  sessionMinutes?: number
  /** Maximum concurrent browser sessions, defaults to 1000. */
  maxSessions?: number
}
/** Validate deployment limits before registering any HTTP routes. */
export const Config: z<Config> = z.object({
  sessionMinutes: z.natural().min(1).max(10_080).default(720),
  maxSessions: z.natural().min(1).max(100_000).default(1000),
})

const COOKIE = 'dsh-account-session'
const FORM_LIMIT = 4096
interface Session { accountId: string; origin: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }

function header(request: ConnectionTrustRequest, name: string): string | undefined {
  if (request.headers instanceof Headers) return request.headers.get(name) ?? undefined
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function cookies(request: ConnectionTrustRequest): Map<string, string> {
  return new Map((header(request, 'cookie') ?? '').split(';').map((part) => {
    const at = part.indexOf('=')
    return at < 0 ? ['', ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()]
  }))
}

/** Read a bounded form without retaining oversized request bytes. */
async function form(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > FORM_LIMIT) { request.resume(); return undefined }
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
function exactFields(fields: URLSearchParams, names: readonly string[]): boolean {
  return [...fields.keys()].every(key => names.includes(key))
    && names.every(key => fields.getAll(key).length === 1)
}

/**
 * Register server-rendered account pages and the session principal source.
 * Sessions retain only a credential hash and are discarded when this plugin unloads.
 * @param ctx - account services and HTTP carrier.
 * @param config - optional session limits; defaults apply when absent.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = { sessionMinutes: config.sessionMinutes ?? 720, maxSessions: config.maxSessions ?? 1000 }
  const sessions = new Map<string, Session>()
  const secure = ctx.webServer.protocol === 'https:'
  const originOf = (request: ConnectionTrustRequest) => `${ctx.webServer.protocol}//${header(request, 'host') ?? ''}`
  const cookie = (value: string, clear = false) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`
  const active = (session: Session) => session.expiresAt > Date.now()
    && ctx.accounts.get(session.accountId).state === 'active'
  const remove = (key: string) => {
    const session = sessions.get(key)
    if (session !== undefined) clearTimeout(session.timer)
    sessions.delete(key)
    return session
  }
  const expire = (key: string) => {
    const session = remove(key)
    if (session !== undefined) void ctx.connection.revokePrincipal({ kind: 'account', ownerId: session.accountId })
  }
  const prune = () => { for (const [key, session] of sessions) if (!active(session)) expire(key) }
  const readSession = (request: ConnectionTrustRequest): Session | undefined => {
    const value = cookies(request).get(COOKIE)
    if (value === undefined) return undefined
    const key = digest(value)
    const session = sessions.get(key)
    if (session === undefined) return undefined
    if (!active(session)) {
      expire(key)
      return undefined
    }
    return session.origin === originOf(request) ? session : undefined
  }
  ctx.effect(() => ctx.connection.registerPrincipalSource((request) => {
    if (!cookies(request).has(COOKIE)) return undefined
    const session = readSession(request)
    return session === undefined ? null : { kind: 'account', ownerId: session.accountId }
  }), 'account-web: session principal')
  ctx.on('accounts/ended', (id) => {
    for (const [key, session] of sessions) if (session.accountId === id) expire(key)
  })
  ctx.effect(() => async () => {
    const accounts = new Set([...sessions.values()].map(session => session.accountId))
    for (const key of sessions.keys()) remove(key)
    await Promise.all([...accounts].map(ownerId => ctx.connection.revokePrincipal({ kind: 'account', ownerId })))
  }, 'account-web: ephemeral sessions')

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const copy = copyFor(request.headers['accept-language'])
    response.setHeader('cache-control', 'no-store')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('content-security-policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    const html = (body: string, status = 200) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      response.end(request.method === 'HEAD' ? undefined : page(copy, body))
    }
    const redirect = (path: string) => { response.writeHead(303, { location: path }); response.end() }
    if (ctx.connection.requestRejection(request) === 403) { html(copy.refused, 403); return }
    const path = new URL(request.url ?? '/', 'http://dsh.invalid')
    if (path.search !== '' && (path.pathname !== '/account/access' || [...path.searchParams.keys()].some(key => key !== 'revoke'))) {
      html(copy.invalid, 400); return
    }
    if (!['GET', 'HEAD', 'POST'].includes(request.method ?? '')) {
      response.setHeader('allow', 'GET, HEAD, POST'); html(copy.invalid, 405); return
    }
    if (request.method === 'POST' && header(request, 'origin') !== originOf(request)) { html(copy.refused, 403); return }
    const login = (error = '') => { html(`${error === '' ? '' : `<p role="alert">${error}</p>`}<h1>${copy.login}</h1>
      <form method="post" action="/account/login" autocomplete="off"><label>${copy.token}
      <input type="password" name="token" required maxlength="256" autocomplete="off" spellcheck="false"></label>
      <button>${copy.enter}</button></form>` , error === '' ? 200 : 401) }
    if (path.pathname === '/account/login') {
      if (request.method !== 'POST') { login(); return }
      const fields = await form(request)
      if (fields === undefined || !exactFields(fields, ['token'])) { html(copy.invalid, 400); return }
      const account = ctx.accounts.authenticate((fields.get('token') ?? '').trim())
      fields.delete('token')
      if (account === undefined) { login(copy.failed); return }
      prune()
      const previous = cookies(request).get(COOKIE)
      if (previous !== undefined) expire(digest(previous))
      if (sessions.size >= limits.maxSessions) { html(copy.capacity, 503); return }
      const value = randomBytes(32).toString('base64url')
      const lifetime = limits.sessionMinutes * 60_000
      const key = digest(value)
      const timer = setTimeout(() => { expire(key) }, lifetime)
      timer.unref()
      sessions.set(key, { accountId: account.id, origin: originOf(request), expiresAt: Date.now() + lifetime, timer })
      // Remove owner credentials so a later logout cannot silently restore owner authority.
      const cleared = [...cookies(request).keys()].filter(key => /^dsh-auth-[A-Za-z0-9_-]+$/.test(key))
        .map(key => `${key}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`)
      response.setHeader('set-cookie', [...cleared, cookie(value)])
      redirect('/'); return
    }
    const session = readSession(request)
    if (path.pathname === '/account/logout') {
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); html(copy.invalid, 405); return }
      const credential = cookies(request).get(COOKIE)
      if (credential !== undefined) remove(digest(credential))
      if (session !== undefined) await ctx.connection.revokePrincipal({ kind: 'account', ownerId: session.accountId })
      response.setHeader('set-cookie', cookie('', true))
      redirect('/account/login'); return
    }
    if (session === undefined) { redirect('/account/login'); return }
    const grants = ctx.accountGrants
    const owner = session.accountId
    if (request.method === 'POST') {
      const fields = await form(request)
      if (fields === undefined || !exactFields(fields, ['action', 'account_id'])) { html(copy.invalid, 400); return }
      const target = (fields.get('account_id') ?? '').trim()
      const action = fields.get('action')
      if (target === '' || target.length > 256 || target === owner || !['grant', 'revoke'].includes(action ?? '')) { html(copy.invalid, 400); return }
      // A session may end while its body is streaming; recheck before changing grants.
      if (readSession(request) !== session) { redirect('/account/login'); return }
      if (action === 'revoke') {
        if (!grants.allows(owner, target)) { html(copy.missing, 404); return }
        await grants.revoke(owner, target)
      } else { await grants.grant(owner, target) }
      redirect('/account/access'); return
    }
    const account = ctx.accounts.get(owner)
    const revoke = path.searchParams.get('revoke')
    const revokeForm = (target: string) => `<form method="post" action="/account/access"><input type="hidden" name="action" value="revoke"><input type="hidden" name="account_id" value="${escapeHtml(target)}"><button>${copy.confirm}</button></form>`
    if (revoke !== null) {
      if (path.searchParams.getAll('revoke').length !== 1 || !grants.allows(owner, revoke)) { html(copy.missing, 404); return }
      html(`<h1>${copy.revoke}</h1><p>${escapeHtml(revoke)}</p>${revokeForm(revoke)}<a href="/account/access">${copy.cancel}</a>`); return
    }
    html(`<h1>${copy.access}</h1><p>${escapeHtml(account.name)} (${escapeHtml(owner)})</p><p>${copy.scope}</p>
      <form method="post" action="/account/access"><input type="hidden" name="action" value="grant"><label>${copy.accountId}
      <input name="account_id" required maxlength="256"></label><button>${copy.grant}</button></form>
      <ul>${grants.list(owner).map(id => `<li>${escapeHtml(id)} <a href="/account/access?revoke=${encodeURIComponent(id)}">${copy.revoke}</a></li>`).join('')}</ul>
      <a href="/account/access">${copy.refresh}</a>`)
  }
  for (const path of ['/account/login', '/account/access', '/account/logout']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: async (request, response) => {
      try { await handle(request, response) } catch (_error) {
        // Request bodies and domain errors can contain submitted secrets; never log or reflect them.
        response.writeHead(500, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
        response.end('Account request failed')
      }
    } }), `account-web: ${path}`)
  }
}
