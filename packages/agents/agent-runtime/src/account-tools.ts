/** Model tools that administer accounts and the account's own agent grants. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './accounts.ts'
import type {} from './owners.ts'

/** Loader plugin name. */
export const name = 'account-tools'
/** Tool registry, accounts and the session owner sidecar. */
export const inject = ['tools', 'accounts', 'sessionOwners']

const accountValue = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true }, name: { type: 'string', required: true },
    role: { type: 'string', enum: ['administrator', 'member'], required: true },
    state: { type: 'string', enum: ['active', 'disabled', 'archived'], required: true },
  },
} as const

/** The authenticated account of the calling session; never a model-supplied id. */
function accountOf(ctx: Context, agent: Agent | undefined): string {
  if (agent === undefined) throw new Error('Account tools require a live agent session')
  const owner = ctx.sessionOwners.ownerOf(agent.id)
  if (owner === undefined) throw new Error('Account tools require an account-bound session')
  return ctx.accounts.get(owner).id
}

/** The calling account, which must be an active administrator. */
function administratorOf(ctx: Context, agent: Agent | undefined): string {
  const id = accountOf(ctx, agent)
  if (!ctx.accounts.isAdministrator(id)) throw new Error('This tool requires an administrator account')
  return id
}

function knownAccount(ctx: Context, id: string): string {
  const trimmed = id.trim()
  if (trimmed === '') throw new Error('account_id must not be empty')
  return ctx.accounts.get(trimmed).id
}

/**
 * Register the account administration and grant tools.
 * @param ctx - injected services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'account_list',
    description: 'List every account of this Host with its role and state. Restricted to an administrator account.',
    parameters: {},
    output: { schema: { type: 'array', items: accountValue }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(_args, exec) {
      administratorOf(ctx, exec.agent)
      return Promise.resolve(ctx.accounts.list().map(({ id, name, role, state }) => ({ id, name, role, state })))
    },
  })), 'accounts.list()')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'account_create',
    description:
      'Create one account and write its entry token to a restricted file outside the workspace. '
      + 'The result carries only that file path: hand it to the account holder through a private channel, '
      + 'then delete the file. The token text must never be copied into a message or a file inside the workspace. '
      + 'Only an administrator account may create accounts.',
    parameters: {
      name: { type: 'string', required: true, description: 'Display name; another account may share it.' },
      role: { type: 'string', enum: ['administrator', 'member'], description: 'Defaults to member.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ...accountValue.properties, token_file: { type: 'string', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Account ${value.id} created. Entry token written to ${value.token_file}. `
          + 'Hand that file to the account holder privately, then delete it.',
      }],
    },
    async execute(args, exec) {
      administratorOf(ctx, exec.agent)
      const { account, tokenFile } = await ctx.accounts.create(args.name, args.role ?? 'member')
      return { id: account.id, name: account.name, role: account.role, state: account.state, token_file: tokenFile }
    },
  })), 'accounts.create()')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'account_disable',
    description: 'Stop one account from signing in and acting, and end its open connections. Its data is kept. Only an administrator account may do this.',
    parameters: { account_id: { type: 'string', required: true } },
    output: { schema: accountValue, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      administratorOf(ctx, exec.agent)
      const account = await ctx.accounts.disable(knownAccount(ctx, args.account_id))
      return { id: account.id, name: account.name, role: account.role, state: account.state }
    },
  })), 'accounts.disable()')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'account_reactivate',
    description: 'Admit a disabled account again; its data and token survive. Only an administrator account may do this.',
    parameters: { account_id: { type: 'string', required: true } },
    output: { schema: accountValue, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      administratorOf(ctx, exec.agent)
      const account = await ctx.accounts.reactivate(knownAccount(ctx, args.account_id))
      return { id: account.id, name: account.name, role: account.role, state: account.state }
    },
  })), 'accounts.reactivate()')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'account_archive',
    description: 'Archive an account instead of deleting it: the record and its data stay and its entry token is destroyed. Only an administrator account may do this.',
    parameters: { account_id: { type: 'string', required: true } },
    output: { schema: accountValue, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      administratorOf(ctx, exec.agent)
      const account = await ctx.accounts.archive(knownAccount(ctx, args.account_id))
      return { id: account.id, name: account.name, role: account.role, state: account.state }
    },
  })), 'accounts.archive()')
}
