/** Account and mailbox attribution retain V4 readability without their producer plugins. */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const cases = [
  ...(['agent/inbox/spliced', 'developer/message', 'user/message'] as const)
    .flatMap(type => (['principal', 'agent-mailbox'] as const).map(change => ({ type, change }))),
]
const modes = (['none', 'zstd'] as const).flatMap(compression => (['read', 'write'] as const).map(access => ({ compression, access })))
const legacy = { kind: 'user', rpcId: 'historical-request' }
const owner = { ...legacy, principal: { kind: 'owner' } }
const account = { ...legacy, principal: { kind: 'account', ownerId: 'account-a' } }
const mailbox = { kind: 'agent-mailbox', form: 'relay', messageId: 'mail-1', senderId: 'agent-a', senderName: 'A', senderSessionId: 'session-a' }

function message(source: object, role = 'user') {
  return { id: 'input', role, source, content: [{ type: 'text', text: 'Preserved input' }] }
}
function payload(type: string, sources: object[]) {
  if (type === 'agent/inbox/spliced') return { target: 'next-turn', start: 0, inserted: sources.map(source => message(source)) }
  if (type === 'developer/message') return { turn: 1, step: 1, message: message(sources[0]!, 'developer') }
  if (type === 'user/message') return { turn: 1, step: 1, ...message(sources[0]!) }
  return { titleProvider: 'test-title', messageSeqs: [], route: { provider: 'test', model: 'test' }, system: 'Title', maxTokens: 32, messages: sources.map(source => message(source)) }
}

describe.each(modes)('fork attribution compatibility ($compression, $access)', ({ compression, access }) => {
  it.each(cases)('preserves old and new $change in $type through released codec and installed persistence', async ({ type, change }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-source-'))
    const ctx = new Context()
    onTestFinished(async () => {
      try { await ctx.fiber.dispose() }
      finally { await rm(root, { recursive: true, force: true }) }
    })
    // No account, mailbox, Gateway or provider plugin is installed in this reader.
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    const variants = change === 'principal' ? [[legacy], [owner], [account]] : [[legacy], [mailbox]]
    for (const [index, sources] of variants.entries()) {
      const id = SessionId(`${type.replaceAll('/', '-')}-${change}-${index}`)
      const header = { type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1, delegationDepth: 0, isSeeded: false }
      const events = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        { type, ...(['developer/message', 'user/message'].includes(type) ? { surfaceOp: 'append' } : {}), data: payload(type, sources) },
        { type: 'step/end', data: { turn: 1, step: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ].map((event, seq) => ({ ...event, seq, time: seq + 1 }))
      const lines = [header, ...events].map(row => JSON.stringify(row) + '\n')
      const bytes = compression === 'none' ? Buffer.from(lines.join('')) : Buffer.concat(await Promise.all(lines.map(compressZstdFrame)))
      const path = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, compression)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)

      // The released codec is unchanged from before all three introducing commits.
      const decoder = releasedV4SessionFormatCodec.createDecoder(header, 'strict')
      const decoded = new SessionFormatEventCollector()
      for (const event of events) decoder.decodeRow(event, decoded)
      decoder.finish(decoded)
      expect(decoded.values).toEqual(events)

      const handle = await ctx.sessionPersistence.open(id, access)
      try {
        const snapshot = await handle.read()
        expect(snapshot.events).toEqual(events)
        const restored = Session.fromRestore(id, snapshot.events, handle.header, SessionLogOffset(0), 'detached')
        expect(restored.snapshotEvents().slice(0, events.length)).toEqual(events)
        expect(restored.deriveMessages()).toEqual(type === 'user/message' ? [payload(type, sources)]
          : type === 'developer/message' ? [message(sources[0]!, 'developer')] : [])
      } finally { await handle.close() }
      expect(await readFile(path)).toEqual(bytes)
    }
  })

  it('keeps historical title requests readable and refuses newly typed noncanonical message variants without truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-title-source-'))
    const ctx = new Context()
    onTestFinished(async () => {
      try { await ctx.fiber.dispose() }
      finally { await rm(root, { recursive: true, force: true }) }
    })
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    const variants = [
      { human: legacy, title: { kind: 'dsh-session-title-llm' }, valid: true },
      { human: account, title: { kind: 'dsh-session-title-llm' }, valid: true },
      { human: legacy, title: account, valid: false },
      { human: legacy, title: mailbox, valid: false },
    ]
    for (const [index, variant] of variants.entries()) {
      const id = SessionId(`title-source-${index}`)
      const header = { type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1, delegationDepth: 0, isSeeded: false }
      const events = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        { type: 'user/message', surfaceOp: 'append', data: payload('user/message', [variant.human]) },
        { type: 'session/title-llm-request', data: { ...payload('session/title-llm-request', [variant.title]), messageSeqs: [2] } },
        { type: 'step/end', data: { turn: 1, step: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ].map((event, seq) => ({ ...event, seq, time: seq + 1 }))
      const lines = [header, ...events].map(row => JSON.stringify(row) + '\n')
      const bytes = compression === 'none' ? Buffer.from(lines.join('')) : Buffer.concat(await Promise.all(lines.map(compressZstdFrame)))
      const path = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, compression)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
      if (variant.valid) {
        const handle = await ctx.sessionPersistence.open(id, access)
        try { expect((await handle.read()).events).toEqual(events) }
        finally { await handle.close() }
      } else {
        await expect(ctx.sessionPersistence.open(id, access)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
        await expect(ctx.sessionPersistence.open(id, access)).rejects.toThrow('messages do not represent messageSeqs')
      }
      expect(await readFile(path)).toEqual(bytes)
    }
  })
})
