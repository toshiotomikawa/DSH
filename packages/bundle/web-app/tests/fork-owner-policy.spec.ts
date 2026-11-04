/** The shipped Web bundle composes the account ownership policy on by default. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface ConfigRow {
  id?: string
  name?: string
  disabled?: unknown
}

interface PatchEntry extends ConfigRow {
  insert?: ConfigRow[]
}

/** The patch's `!!js` expressions are not configuration data this test reads. */
const jsExprType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => String(value) })

const rows = (yaml.load(readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8'), {
  schema: yaml.JSON_SCHEMA.extend(jsExprType),
}) as PatchEntry[]).flatMap(entry => entry.insert ?? [entry])

describe('the shipped Web composition', () => {
  it('mounts the account ownership policy without disabling it', () => {
    const row = rows.find(entry => entry.id === 'fork-owner-policy')
    expect(row).toMatchObject({ name: '@deepseek-ai/dsh-agent-runtime/owners' })
    expect(row?.disabled).toBeUndefined()
  })

  it('mounts the account entry, admission and administration plugins once each, on by default', () => {
    const ids = rows.map(entry => entry.id).filter((id): id is string => id !== undefined)
    expect(ids).toHaveLength(new Set(ids).size)
    for (const [id, plugin] of [
      ['fork-accounts', 'accounts'],
      ['fork-account-auth', 'account-auth'],
      ['fork-account-tools', 'account-tools'],
    ]) {
      const matching = rows.filter(entry => entry.id === id)
      expect(matching).toHaveLength(1)
      expect(matching[0]).toMatchObject({ name: `@deepseek-ai/dsh-agent-runtime/${plugin}` })
      expect(matching[0]?.disabled).toBeUndefined()
    }
  })

  it('mounts the persistent-agent registry the sidebar reads, on by default', () => {
    const matching = rows.filter(entry => entry.id === 'fork-agent-registry')
    expect(matching).toHaveLength(1)
    expect(matching[0]).toMatchObject({ name: '@deepseek-ai/dsh-agent-registry' })
    expect(matching[0]?.disabled).toBeUndefined()
  })
})
