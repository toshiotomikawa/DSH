/** Keyless production-profile proof for both optional CLI plugins. */
import { expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

async function logs(directory:string):Promise<string> {
  const entries=await readdir(directory,{ withFileTypes:true })
  const parts=await Promise.all(entries.map(entry=>entry.isDirectory()
    ? logs(join(directory,entry.name)) : readFile(join(directory,entry.name),'utf8')))
  return parts.join('\n')
}

it.each(['grok','agy'])('boots %s through Loader, delegates and persists the final answer',async (provider)=>{
  let events=''
  const driver=fileURLToPath(new URL('../../subagent-acp/tests/fixtures/loader/driver.ts',import.meta.url))
  await runLoaderSmoke({
    label:`M4 ${provider} composition`,tempDirPrefix:`m4-${provider}-loader-`,
    binScript:driver,libBinScript:driver,
    configPath:fileURLToPath(new URL(`../../subagent-${provider}/tests/fixtures/loader.patch.yml`,import.meta.url)),
    tsconfigPath:resolve('tsconfig.json'),
    env:{
      DSH_HOME:resolve(`.dsh-test/loader-${provider}`),
      M4_NATIVE_PROVIDER:provider,
      M4_TEST_CLI:fileURLToPath(new URL('./fixtures/cli.mjs',import.meta.url)),
      M4_TEST_MOCK_LLM:fileURLToPath(new URL('../../subagent-acp/tests/fixtures/loader/mock-delegating-llm.ts',import.meta.url)),
    },
    inspect:async (cwd)=>{events=await logs(join(cwd,'.sessions'))},
  })
  expect(events).toContain('tool/result')
  expect(events).toContain('subagent-settled')
  expect(events).toContain('SCRUBBED')
},LOADER_SMOKE_TEST_TIMEOUT_MS)
