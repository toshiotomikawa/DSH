import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { Config, parse, product } from '../src/index.ts'
import { resolveConfig } from '../../subagent-grok/src/headless.ts'

const wire = (result: unknown) => JSON.stringify({ event:'result',result })
describe('Antigravity native wire output', () => {
  it('replays recorded NDJSON, keeping only the terminal response', async () => {
    const fixture = await readFile(new URL('./fixtures/success.ndjson',import.meta.url),'utf8')
    expect(parse(fixture)).toEqual({ output:[{ type:'text',text:'M4_OK\n' }],stopReason:'completed' })
  })
  it.each([
    ['', 'error'], ['[]','error'], ['{}','error'], [wire(null),'error'],
    [wire({ status:'REFUSED' }),'refusal'], [wire({ status:'MAX_TOKENS' }),'max-tokens'],
    [wire({ status:'quota_exhausted' }),'error'], [wire({ error:'rate limit' }),'error'],
    [wire({ status:'SUCCESS',response:'' }),'error'],[wire({ status:'ERROR' }),'error'],
    [wire({ status:'SUCCESS',response:'ok' })+'\n'+wire({ status:'SUCCESS',response:'two' }),'error'],
  ])('maps terminal %s to %s', (data,reason)=>{ expect(parse(data).stopReason).toBe(reason) })
  it('rejects malformed JSON instead of publishing a partial answer',()=>{ expect(()=>parse('{')).toThrow() })
  it('requires explicit allow and fixes the model per instance',()=>{
    const config = resolveConfig(Config({ logDirectory:process.cwd() }),'agy')
    expect(product.argv(config,'x')).not.toContain('--dangerously-skip-permissions')
    expect(product.argv(config,'x')).not.toContain('--mode')
    expect(product.argv({ ...config,permission:'allow',model:'native-model' },'x')).toContain('--dangerously-skip-permissions')
    expect(product.argv({ ...config,model:'native-model' },'x').slice(-2)).toEqual(['--model','native-model'])
  })
})
