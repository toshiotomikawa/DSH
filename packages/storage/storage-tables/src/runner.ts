/**
 * Serializes calls to one SQL Worker and enforces the per-command deadline:
 * a command that overruns, or whose caller aborts, has its Worker terminated
 * (SQLite rolls the open transaction back) and a fresh Worker serves the next call.
 * @module @deepseek-ai/dsh-storage-tables/runner
 */

import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import type { EngineOptions } from './engine.ts'
import { TablesError, deserializeError } from './errors.ts'
import type { Method, WorkerReply, WorkerRequest } from './rpc.ts'

function workerSpawn(): { readonly entry: URL; readonly options: WorkerOptions } {
  /* v8 ignore next -- built-artifact runs own the bundled path. */
  if (!import.meta.url.endsWith('.ts')) return { entry: new URL('./worker.cjs', import.meta.url), options: { execArgv: [] } }
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(new URL('./worker.ts', import.meta.url).href)})`,
  ].join('\n')
  return { entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), options: { execArgv: [] } }
}

/** One Worker plus a call queue. */
export class SqlRunner {
  private worker: Promise<Worker> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  /**
   * @param options - engine start-up data handed to every Worker.
   * @param commandTimeoutMs - deadline for one command.
   */
  constructor(private readonly options: EngineOptions, private readonly commandTimeoutMs: number) {}

  /**
   * Run one engine method; calls execute strictly in arrival order.
   * @param method - engine method.
   * @param args - its arguments (structured-cloneable).
   * @param signal - cancels the call; an in-flight command is aborted by terminating the Worker.
   * @returns the engine's return value.
   * @throws {TablesError} the engine's failure, or `cancelado` on timeout or abort.
   */
  call(method: Method, args: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    const result = this.tail.then(() => this.run({ method, args }, signal))
    this.tail = result.catch(() => {})
    return result
  }

  /** Terminate the Worker; later calls fail. */
  async close(): Promise<void> {
    this.closed = true
    await this.tail
    const worker = await this.worker?.catch(() => undefined)
    this.worker = undefined
    await worker?.terminate()
  }

  private start(): Promise<Worker> {
    const { entry, options } = workerSpawn()
    const worker = new Worker(entry, { ...options, workerData: this.options })
    return new Promise<Worker>((resolve, reject) => {
      const fail = (error: Error) => {
        this.worker = undefined
        reject(error)
      }
      worker.once('error', fail)
      worker.once('exit', code => fail(new Error(`SQL worker exited (${code}) before it was ready`)))
      worker.once('message', () => {
        worker.removeAllListeners('error')
        worker.removeAllListeners('exit')
        resolve(worker)
      })
    })
  }

  private async run(request: WorkerRequest, signal: AbortSignal | undefined): Promise<unknown> {
    if (this.closed) throw new TablesError('interno', 'o serviço de tabelas foi fechado')
    if (signal?.aborted === true) throw new TablesError('cancelado', 'chamada cancelada antes de começar')
    this.worker ??= this.start()
    let worker: Worker
    try {
      worker = await this.worker
    } catch (error) {
      throw new TablesError('interno', `o worker SQL não iniciou: ${(error as Error).message}`)
    }
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        worker.removeListener('message', onMessage)
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
      }
      const abandon = (error: TablesError) => {
        cleanup()
        this.worker = undefined
        void worker.terminate()
        reject(error)
      }
      const onMessage = (reply: WorkerReply) => {
        cleanup()
        if (reply.ok) resolve(reply.value)
        else reject(deserializeError(reply.error))
      }
      const onError = (error: Error) => { abandon(new TablesError('interno', `falha no worker SQL: ${error.message}`)) }
      const onExit = (code: number) => { abandon(new TablesError('interno', `o worker SQL terminou (${code})`)) }
      const onAbort = () => { abandon(new TablesError('cancelado', 'comando cancelado pelo chamador; nada foi gravado')) }
      const timer = setTimeout(() => {
        abandon(new TablesError('cancelado', `comando cancelado: passou de ${this.commandTimeoutMs} ms; nada foi gravado`))
      }, this.commandTimeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      worker.on('message', onMessage)
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.postMessage(request)
    })
  }
}
