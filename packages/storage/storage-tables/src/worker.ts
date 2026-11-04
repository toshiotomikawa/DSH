/** Worker Thread entry: owns one engine connection and answers one request at a time. */
import { parentPort, workerData } from 'node:worker_threads'
import { TablesEngine } from './engine.ts'
import { serializeError } from './errors.ts'
import type { WorkerReply, WorkerRequest, WorkerStart } from './rpc.ts'

const engine = new TablesEngine(workerData as WorkerStart)

parentPort?.on('message', (request: WorkerRequest) => {
  let reply: WorkerReply
  try {
    const run = engine[request.method] as (...args: unknown[]) => unknown
    reply = { ok: true, value: run.apply(engine, request.args) }
  } catch (error) {
    reply = { ok: false, error: serializeError(error) }
  }
  parentPort?.postMessage(reply)
})
parentPort?.postMessage({ ok: true, value: 'ready' } satisfies WorkerReply)
