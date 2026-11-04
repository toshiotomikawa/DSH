/** Opt-in live proof: one request through the existing ACP provider, never the host LLM. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { externalTestParent, startExternalActivation } from '../../subagent/tests/external-activation-helpers.ts'
import * as acp from '../src/index.ts'

describe.skipIf(process.env.M4_OPENCODE_SMOKE !== '1')('OpenCode configured ACP integration',()=>{
  it('delegates one prompt to the selected Go model and returns the final answer',async()=>{
    const cwd = resolve('.dsh-test')
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await mountWorkingDirectoryFixture(ctx)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(acp,{
        providerName:'opencode-go-flash',
        command:process.env.M4_OPENCODE_COMMAND ?? 'opencode',args:['acp'],permission:'reject',
        env:{
          DSH_HOME:cwd,
          OPENCODE_CONFIG_CONTENT:JSON.stringify({ model:'opencode-go/deepseek-v4.1-flash',permission:'deny' }),
          OPENCODE_DISABLE_AUTOUPDATE:'1',
        },
      })
      const parent = await externalTestParent(ctx,cwd)
      const run = await startExternalActivation(ctx,'opencode-go-flash',{
        cwd,parent,signal:AbortSignal.timeout(60_000),
        prompt:[{ type:'text',text:'Reply exactly M4_OK. Do not use any tools.' }],
      })
      try {
        const result = await run.result
        expect(result.stopReason).toBe('completed')
        expect(result.output.filter(block=>block.type==='text').map(block=>block.text).join('')).toContain('M4_OK')
      } finally { await run.dispose() }
    } finally { await ctx.fiber.dispose() }
  },75_000)
})
