import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { externalTestParent, startExternalActivation } from '../../subagent/tests/external-activation-helpers.ts'
import * as grok from '../src/index.ts'
import * as agy from '../../subagent-agy/src/index.ts'

let ctx:Context|undefined
let cwd:string|undefined
afterEach(async()=>{
  await ctx?.fiber.dispose(); if(cwd) await rm(cwd,{ recursive:true,force:true })
  delete process.env.M4_SECRET_TOKEN; delete process.env.M4_CUSTOM_AUTH
})
async function launch(env:Record<string,string>={}, timeoutMs=5000, plugin:typeof grok|typeof agy=grok){
  cwd=await mkdtemp(join(tmpdir(),'dsh-m4-native-')); ctx=new Context()
  await ctx.plugin(SessionProjectionRegistry); await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime); await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(plugin,{ command:process.execPath,args:[fileURLToPath(new URL('./fixtures/cli.mjs',import.meta.url))],logDirectory:join(cwd,'logs'),env,timeoutMs })
  const parent=await externalTestParent(ctx,cwd)
  const controller=new AbortController()
  const run=await startExternalActivation(ctx,plugin===grok?'grok':'agy',{ cwd,parent,prompt:[{ type:'text',text:'OK' }],signal:controller.signal })
  return { run,controller }
}
it('scrubs ambient credentials at the real managed process boundary',async()=>{
  process.env.M4_SECRET_TOKEN='marker-do-not-forward'
  const { run }=await launch()
  expect((await run.result).output).toEqual([{ type:'text',text:'SCRUBBED' }])
  await run.dispose()
})
it('registers the agy plugin and drives its independent CLI wire adapter',async()=>{
  const { run }=await launch({ M4_FIXTURE_MODE:'agy' },5000,agy)
  expect((await run.result).output).toEqual([{ type:'text',text:'SCRUBBED' }]); await run.dispose()
})
it('kills a real hanging child on deadline, leaving no live PID',async()=>{
  const marker=join(tmpdir(),`m4-pid-${process.pid}-${Date.now()}`)
  try {
    const { run }=await launch({ M4_FIXTURE_MODE:'hang',M4_PID_FILE:marker },1500)
    const result=await run.result
    expect(result.diagnostic).toContain('tempo_esgotado'); await run.dispose()
    const pid=Number(await readFile(marker,'utf8'))
    expect(()=>process.kill(pid,0)).toThrow()
  } finally {await rm(marker,{ force:true })}
})
it('does not forward a credential-like variable whose name the old pattern missed (finding 3)',async()=>{
  process.env.M4_CUSTOM_AUTH='marker-custom-auth'
  const { run }=await launch()
  expect((await run.result).output).toEqual([{ type:'text',text:'SCRUBBED' }])
  await run.dispose()
})
it('still forwards variables the deployment lists explicitly (finding 3)',async()=>{
  process.env.M4_CUSTOM_AUTH='ambient'
  const { run }=await launch({ M4_CUSTOM_AUTH:'explicit' })
  expect((await run.result).output).toEqual([{ type:'text',text:'LEAK' }])
  await run.dispose()
})
it('leaves no detached grandchild alive after the final answer (finding 1)',async()=>{
  const marker=join(tmpdir(),`m4-orphan-${process.pid}-${Date.now()}`)
  let pid=0
  try {
    const { run }=await launch({ M4_FIXTURE_MODE:'orphan',M4_PID_FILE:marker })
    expect((await run.result).output).toEqual([{ type:'text',text:'SCRUBBED' }])
    await run.dispose()
    pid=Number(await readFile(marker,'utf8'))
    expect(()=>process.kill(pid,0)).toThrow()
  } finally {
    if (pid>0) { try { process.kill(pid,'SIGKILL') } catch { /* already gone */ } }
    await rm(marker,{ force:true })
  }
})
