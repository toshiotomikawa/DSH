/**
 * Serializes calls to one SQL child process and enforces the per-command deadline:
 * a command that overruns, or whose caller aborts, has its process killed
 * (SQLite rolls the open transaction back) and a fresh process serves the next call.
 * @module @deepseek-ai/dsh-storage-tables/runner
 */

import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { EngineOptions } from './engine.ts'
import { TablesError, deserializeError } from './errors.ts'
import type { Method, WorkerReply, WorkerRequest } from './types.ts'

/**
 * Start the SQL child process: no window, no console, IPC only. A child (not a
 * thread) because only killing a process interrupts a long native SQLite step.
 */
function spawnWorker(options: EngineOptions): ChildProcess {
  const args = [JSON.stringify(options)]
  /* v8 ignore next -- built-artifact runs own the bundled path. */
  if (!import.meta.url.endsWith('.ts')) return fork(fileURLToPath(new URL('./worker.cjs', import.meta.url)), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] })
  return fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: ['--import', import.meta.resolve('tsx')],
  })
}

/** Resolve once the child has exited (immediately when it already has). */
function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => { resolve() })
  })
}

/** One SQL child process plus a call queue. */
export class SqlRunner {
  private worker: Promise<ChildProcess> | undefined
  private child: ChildProcess | undefined
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

  /** Kill the child; later calls fail. */
  async close(): Promise<void> {
    this.closed = true
    await this.tail
    const child = this.child
    this.worker = undefined
    this.child = undefined
    if (child !== undefined) {
      child.kill('SIGKILL')
      await exited(child)
    }
  }

  private start(): Promise<ChildProcess> {
    const child = spawnWorker(this.options)
    return new Promise<ChildProcess>((resolve, reject) => {
      const fail = (error: Error) => {
        this.worker = undefined
        child.kill('SIGKILL')
        reject(error)
      }
      child.once('error', fail)
      child.once('exit', (code) => { fail(new Error(`SQL worker exited (${code}) before it was ready`)) })
      child.once('message', () => {
        child.removeAllListeners('error')
        child.removeAllListeners('exit')
        this.child = child
        resolve(child)
      })
    })
  }

  private async run(request: WorkerRequest, signal: AbortSignal | undefined): Promise<unknown> {
    if (this.closed) throw new TablesError('interno', 'o serviço de tabelas foi fechado')
    if (signal?.aborted === true) throw new TablesError('cancelado', 'chamada cancelada antes de começar')
    this.worker ??= this.start()
    let child: ChildProcess
    try {
      child = await this.worker
    } catch (error) {
      throw new TablesError('interno', `o worker SQL não iniciou: ${(error as Error).message}`)
    }
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        child.removeListener('message', onMessage)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
      }
      // The child is killed and reaped before the caller hears of the failure, so its file locks are gone.
      const abandon = (error: TablesError) => {
        cleanup()
        this.worker = undefined
        this.child = undefined
        child.kill('SIGKILL')
        void exited(child).then(() => { reject(error) })
      }
      const onMessage = (reply: WorkerReply) => {
        cleanup()
        if (reply.ok) resolve(reply.value)
        else reject(deserializeError(reply.error))
      }
      const onError = (error: Error) => { abandon(new TablesError('interno', `falha no worker SQL: ${error.message}`)) }
      const onExit = (code: number | null) => { abandon(new TablesError('interno', `o worker SQL terminou (${code})`)) }
      const onAbort = () => { abandon(new TablesError('cancelado', 'comando cancelado pelo chamador; nada foi gravado')) }
      const timer = setTimeout(() => {
        abandon(new TablesError('cancelado', `comando cancelado: passou de ${this.commandTimeoutMs} ms; nada foi gravado`))
      }, this.commandTimeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('message', onMessage)
      child.once('error', onError)
      child.once('exit', onExit)
      child.send(request)
    })
  }
}
