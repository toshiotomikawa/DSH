import { Context } from '@deepseek-ai/cordis'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import type { ConnectionTrustRequest } from '../src/rpc.ts'

const HOST = '127.0.0.1:4096'
const A: Principal = { kind: 'account', ownerId: 'a' }

async function mounted(): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [], {
      isAuthenticated: () => false,
      authenticateApi: () => undefined,
    } as unknown as BrowserAuth)
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

function request(headers: Record<string, string> = {}): ConnectionTrustRequest {
  return { headers: { host: HOST, ...headers } }
}

describe('Connection principal sources', () => {
  it('admits the first non-owner principal and reuses its Peer across requests', async () => {
    const { connection, dispose } = await mounted()
    connection.registerPrincipalSource(() => undefined)
    connection.registerPrincipalSource(() => ({ ...A }))
    const first = connection.admit(request())
    const second = connection.admit(request({ cookie: 'unused' }))
    expect('peer' in first && first.peer.principal).toEqual(A)
    expect('peer' in second && second.peer).toBe('peer' in first ? first.peer : undefined)
    await dispose()
  })

  it('refuses a source that claims the trusted host owner', async () => {
    const { connection, dispose } = await mounted()
    connection.registerPrincipalSource(() => ({ kind: 'owner' }))
    expect(() => connection.admit(request())).toThrow('must not claim the owner principal')
    await dispose()
  })

  it('withdraws a source with its disposer', async () => {
    const { connection, dispose } = await mounted()
    const removal = connection.registerPrincipalSource(() => A)
    expect('peer' in connection.admit(request())).toBe(true)
    await removal()
    expect(connection.admit(request())).toEqual({ rejection: 401 })
    await dispose()
  })

  it('disposes the account Peer on revocation and admits a new one later', async () => {
    const { connection, dispose } = await mounted()
    const source = vi.fn(() => A)
    connection.registerPrincipalSource(source)
    const admitted = connection.admit(request())
    if (!('peer' in admitted)) throw new Error('admission refused')
    await connection.revokePrincipal(A)
    expect(admitted.peer.signal.aborted).toBe(true)
    await connection.revokePrincipal({ kind: 'account', ownerId: 'never-admitted' })
    const again = connection.admit(request())
    expect('peer' in again && again.peer).not.toBe(admitted.peer)
    await dispose()
  })

  it('disposes account Peers with the Connection fiber', async () => {
    const { connection, dispose } = await mounted()
    connection.registerPrincipalSource(() => A)
    const admitted = connection.admit(request())
    if (!('peer' in admitted)) throw new Error('admission refused')
    await dispose()
    expect(admitted.peer.signal.aborted).toBe(true)
  })
})
