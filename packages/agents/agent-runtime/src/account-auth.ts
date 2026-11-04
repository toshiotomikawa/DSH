/** Admit an account entry token as the connection principal, and end it with the account. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './accounts.ts'

/** Loader plugin name. */
export const name = 'account-auth'
/** Accounts prove tokens; Connection carries admitted requests. */
export const inject = ['accounts', 'connection']

/** First value of one request header, in either header representation. */
function header(request: ConnectionTrustRequest, name: string): string | undefined {
  const headers = request.headers
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const key = Object.keys(headers).find(entry => entry.toLowerCase() === name)
  const value = key === undefined ? undefined : headers[key]
  return typeof value === 'string' ? value : value?.[0]
}

/** Bearer value of one request, if its header signals a bearer credential. */
function bearer(request: ConnectionTrustRequest): string | undefined {
  const value = header(request, 'authorization')
  if (value === undefined) return undefined
  const match = /^Bearer[ ]+(\S+)$/i.exec(value.trim())
  return match?.[1]
}

/**
 * Mount the account admission source and end account Peers when the account ends.
 * @param ctx - injected account and connection services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.registerPrincipalSource((request): Principal | undefined => {
    const token = bearer(request)
    if (token === undefined) return undefined
    const account = ctx.accounts.authenticate(token)
    return account === undefined ? undefined : { kind: 'account', ownerId: account.id }
  }), 'account-auth: bearer principal')
  ctx.effect(() => ctx.on('accounts/ended', (accountId) => {
    void ctx.connection.revokePrincipal({ kind: 'account', ownerId: accountId })
  }), 'account-auth: disabled accounts lose their Peers')
}
