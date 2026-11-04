import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { externalTestParent } from '../../subagent/tests/external-activation-helpers.ts'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Config, parse, product } from '../src/index.ts'
import { failure, isRecord, quotaStatus, register, resolveConfig, start, type ResolvedConfig as Settings } from '../src/headless.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-m4-'))
  directories.push(cwd)
  const ctx = new Context(); contexts.push(ctx)
  const parent = await externalTestParent(ctx, cwd)
  const signal = new AbortController()
  const request = { cwd, parent, signal: signal.signal, prompt: [{ type: 'text' as const, text: 'OK' }] }
  const config: Settings = resolveConfig(Config({ logDirectory: join(cwd, 'logs') }),'grok')
  const done = Promise.withResolvers<SubprocessOutcome>()
  let stdout = '{"text":"OK","stopReason":"end_turn"}'
  let stderr = ''
  let lossy = false
  const terminate = vi.fn(() => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) })
  const waitForExit = vi.fn(async () => true)
  const child: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
    },
    done: done.promise,
    terminate, waitForExit,
  }
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => child)
  const warn = vi.fn()
  return { cwd, ctx, config, request, signal, done, child, spawn, warn, terminate, waitForExit,
    output: (out: string, err = '', truncated = false) => { stdout = out; stderr = err; lossy = truncated },
    run: () => start(request, config, product, spawn, warn),
  }
}

describe('Grok wire output', () => {
  it('replays recorded JSON and exposes only final text', async () => {
    const fixture = await readFile(new URL('./fixtures/success.json', import.meta.url), 'utf8')
    expect(parse(fixture)).toEqual({ output: [{ type: 'text', text: 'M4_OK' }], stopReason: 'completed' })
  })
  it.each([
    [[], 'error'], [{}, 'error'], [{ text:'',stopReason:'end_turn' }, 'error'],
    [{ text:'OK',stopReason:'end_turn',error:'failed' }, 'error'],
    [{ stopReason:'refusal' }, 'refusal'], [{ stopReason:'max_tokens' }, 'max-tokens'],
    [{ stopReason:'quota_exceeded' },'error'], [{ error:'usage limit exceeded' },'error'],
  ])('maps terminal %j to %s', (data, reason) =>{  expect(parse(JSON.stringify(data)).stopReason).toBe(reason) })
  it('rejects malformed JSON and recognizes records', () => {
    expect(() => parse('{')).toThrow()
    expect(isRecord(null)).toBe(false); expect(isRecord([])).toBe(false); expect(isRecord({})).toBe(true)
  })
  it('keeps model and permission deployment-owned', () => {
    const config = resolveConfig(Config({ logDirectory: process.cwd() }),'grok')
    expect(product.argv(config,'hi')).toContain('dontAsk')
    expect(product.argv({ ...config,permission:'allow',model:'m' },'hi')).toContain('bypassPermissions')
    expect(product.argv({ ...config,model:'m' },'hi').slice(-2)).toEqual(['--model','m'])
  })
})

describe('managed headless lifecycle', () => {
  it('completes, reaps survivors, writes private audit and disposes idempotently', async () => {
    const f = await setup(); const run = await f.run()
    f.done.resolve({ exitCode:0,signal:null })
    expect((await run.result).stopReason).toBe('completed')
    expect(f.terminate).toHaveBeenCalled()
    expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({ cwd:f.cwd,stdio:{ stdin:'ignore' },env:{} })
    const files = await readdir(f.config.logDirectory)
    expect(files).toHaveLength(1)
    const audit: unknown = JSON.parse(await readFile(join(f.config.logDirectory,files[0]!), 'utf8'))
    expect(isRecord(audit) && typeof audit.stdout === 'string' && audit.stdout.includes('OK')).toBe(true)
    expect(run.dispose()).toBe(run.dispose()); await run.dispose()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('quota unknown'))
  })
  it('refuses low quota before spawning; malformed quota fails closed', async () => {
    const f = await setup(); f.config.quotaFile = join(f.cwd,'quota.json')
    await writeFile(f.config.quotaFile,'{"remainingPercent":9}')
    const run = await f.run(); expect((await run.result).diagnostic).toContain('cota_baixa'); await run.dispose()
    expect(f.spawn).not.toHaveBeenCalled()
    await writeFile(f.config.quotaFile,'{"remainingPercent":null}')
    await expect(f.run()).rejects.toThrow('quota status')
    await writeFile(f.config.quotaFile,'bad')
    await expect(f.run()).rejects.toThrow('quota status')
    await writeFile(f.config.quotaFile,'{"remainingPercent":10}')
    expect(await quotaStatus(f.config)).toBe(10)
  })
  it.each([
    ['{', '', 0, false, 'error'],
    ['{}', 'quota exhausted', 1, false, 'error'],
    ['{}', 'secret error', 2, false, 'error'],
    ['{"text":"OK","stopReason":"end_turn"}', '', 1, false, 'error'],
    ['{}', '', 0, true, 'error'],
  ])('contains protocol/process/limit failure %#', async (out,err,code,lossy,reason) => {
    const f = await setup(); f.output(out,err,lossy)
    const run = await f.run(); f.done.resolve({ exitCode:code,signal:null })
    const result = await run.result
    expect(result.stopReason).toBe(reason); expect(result.diagnostic).not.toContain('secret')
    await run.dispose()
  })
  it('cancels by signal, observes exit and does not retry', async () => {
    const f = await setup(); const run = await f.run(); f.signal.abort()
    // Fake subprocess models the managed range's reaction to its signal.
    f.done.resolve({ exitCode:null,signal:'SIGTERM' })
    expect((await run.result).stopReason).toBe('aborted')
    await run.dispose(); expect(f.spawn).toHaveBeenCalledTimes(1)
  })
  it('enforces its deadline', async () => {
    const f = await setup(); f.config.timeoutMs = 10
    const run = await start(f.request,f.config,product,(spec) => {
      spec.signal!.addEventListener('abort',()=>{ f.done.resolve({ exitCode:null,signal:'SIGTERM' }) })
      return f.child
    }, f.warn)
    expect((await run.result).diagnostic).toContain('tempo_esgotado'); await run.dispose()
  })
  it('disposal cancels an in-flight child', async () => {
    const f = await setup(); const run = await f.run()
    await run.dispose(); expect((await run.result).stopReason).toBe('aborted')
  })
  it('contains post-publication process rejection', async () => {
    const f = await setup(); const run = await f.run(); f.done.reject(new Error('secret'))
    expect((await run.result).diagnostic).toContain('process, protocol or audit failure'); await run.dispose()
  })
  it('refuses cancellation, non-text prompts and startup failures safely', async () => {
    const f = await setup()
    await expect(start(f.request,f.config,product,()=>{throw new Error('secret')},f.warn)).rejects.toThrow('process startup failed')
    f.signal.abort(); await expect(f.run()).rejects.toThrow('cancelled')
  })
  it('does not mix simultaneous runs', async () => {
    const a = await setup(); const b = await setup(); b.output('{"text":"B","stopReason":"end_turn"}')
    const [one,two] = await Promise.all([a.run(),b.run()])
    a.done.resolve({ exitCode:0,signal:null }); b.done.resolve({ exitCode:0,signal:null })
    expect((await one.result).output).toEqual([{ type:'text',text:'OK' }])
    expect((await two.result).output).toEqual([{ type:'text',text:'B' }])
    await Promise.all([one.dispose(),two.dispose()])
  })
  it('validates deployment bounds before registering', async () => {
    const f = await setup()
    for (const patch of [{ timeoutMs:0 },{ disposeGraceMs:Infinity },{ maxOutputBytes:NaN },{ logDirectory:'relative' },{ minimumRemainingPercent:101 }]) {
      expect(()=>{ register(f.ctx,{ ...f.config,...patch },product) }).toThrow()
    }
    expect(failure('x').diagnostic).toContain('x')
  })
  it('rejects non-text input before spawning',async()=>{
    const f=await setup()
    await expect(start({ ...f.request,prompt:[{ type:'reasoning',text:'internal' }] },f.config,product,f.spawn,f.warn)).rejects.toThrow('text prompt required')
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it('rechecks cancellation after asynchronous preparation',async()=>{
    const f=await setup(); const pending=f.run(); queueMicrotask(()=>{ f.signal.abort() })
    await expect(pending).rejects.toThrow('cancelled before startup'); expect(f.spawn).not.toHaveBeenCalled()
  })
  it('allows known sufficient quota without the unknown-quota warning',async()=>{
    const f=await setup(); f.config.quotaFile=join(f.cwd,'quota.json'); await writeFile(f.config.quotaFile,'{"remainingPercent":90}')
    const run=await f.run(); f.done.resolve({ exitCode:0,signal:null })
    expect((await run.result).stopReason).toBe('completed'); expect(f.warn).not.toHaveBeenCalled(); await run.dispose()
  })
  it('maps structured quota errors even on nonzero exit',async()=>{
    const f=await setup(); f.output('{"error":"quota exhausted"}')
    const run=await f.run(); f.done.resolve({ exitCode:1,signal:null })
    expect((await run.result).diagnostic).toContain('cota_esgotada'); await run.dispose()
  })
  it('preserves timeout classification when termination rejects the transport',async()=>{
    const f=await setup(); f.config.timeoutMs=10
    const run=await start(f.request,f.config,product,(spec)=>{
      spec.signal!.addEventListener('abort',()=>{ f.done.reject(new Error('transport')) }); return f.child
    },f.warn)
    expect((await run.result).diagnostic).toContain('tempo_esgotado'); await run.dispose()
  })
  it('preserves cancellation when the transport rejects',async()=>{
    const f=await setup(); const run=await f.run(); f.signal.abort(); f.done.reject(new Error('transport'))
    expect((await run.result).stopReason).toBe('aborted'); await run.dispose()
  })
  it('reports unknown cleanup state and refuses to claim disposal succeeded',async()=>{
    const f=await setup(); f.waitForExit.mockRejectedValue(new Error('cleanup'))
    const run=await f.run(); f.done.reject(new Error('transport'))
    expect((await run.result).stopReason).toBe('error')
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('status unknown'))
    await expect(run.dispose()).rejects.toThrow('cleanup')
  })
})
