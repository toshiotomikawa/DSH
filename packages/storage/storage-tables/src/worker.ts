/** Child-process entry: owns one engine connection and answers one request at a time over IPC. */
import { TablesEngine } from './engine.ts'
import { serializeError } from './errors.ts'
import type { WorkerReply, WorkerRequest, WorkerStart } from './types.ts'

const send = (reply: WorkerReply) => process.send?.(reply)
const engine = new TablesEngine(JSON.parse(process.argv[2] as string) as WorkerStart)

process.on('message', (request: WorkerRequest) => {
  let reply: WorkerReply
  try {
    const run = engine[request.method] as (...args: unknown[]) => unknown
    reply = { ok: true, value: run.apply(engine, request.args as unknown[]) }
  } catch (error) {
    reply = { ok: false, error: serializeError(error) }
  }
  send(reply)
})
process.on('disconnect', () => process.exit(0))
send({ ok: true, value: 'ready' })
