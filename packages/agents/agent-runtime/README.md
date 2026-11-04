---
description: "Connects persistent agent identities to mailbox and routine sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-runtime

## Summary

Connects persistent agent identities to mailbox and routine sessions.

## Use this package

Mount globally after agent-registry, agent-memory, agents and system-prompt, before agent-mailbox and agent-routine. It provides `agentDirectory` and `agentRoutineBridge`. Mailbox conversations are durably bound before creation or resume; bound sessions receive the identity persona and essential memories. Each routine execution creates one fresh session and returns admission before its turn settles.

The optional `@deepseek-ai/dsh-agent-runtime/owners` plugin mounts the account policy in `remote-access`. Add its `fork-owner-policy` entry to a Web composition that already mounts persistent storage and the Session Controller; the shipped Web bundle composes it ON. It stores optional `ownerId` metadata in the per-record `session_owners` domain, leaving released Session headers and logs unchanged. Existing Sessions are adopted by `owner`; create, fork and persistent-agent binding save their trusted owner before returning. A Session whose owner write fails is recorded as denied instead of keeping the account the creation event adopted first, so it stays hidden from every account until a later assignment succeeds. Account principals see only owned Session rows and FTS results, and foreign and unknown Session ids receive the same access denial. Sidecar damage blocks account-policy activation and preserves the damaged document. Disposing the plugin removes its service and policy.

The same plugin provides `accountGrants`, an explicit directional grant between accounts stored in the `account_grants` domain: `grant(ownerId, granteeId)`, `revoke(ownerId, granteeId)` and `allows(ownerId, granteeId)`. The persistent-agent directory and `agent_send_message` list another account's agents only when that account granted the caller; interruption follows the same grant. The host account and same-owner calls need no grant. Grant creation has no tool or UI yet: trusted Host code calls the service.

The `@deepseek-ai/dsh-agent-runtime/accounts` plugin opens the per-record `accounts` domain and provides `accounts`: `create(name, role)` returns the new account and its one-time entry token, `list`, `get`, `disable`, `reactivate` and `archive`, plus `authenticate(token)` and `isAdministrator(id)`. Only a SHA-256 hash of the token is stored; the plaintext is returned once from `create` and never again. Archived accounts stay readable and lose their credential; disabling an account keeps its data and token. `@deepseek-ai/dsh-agent-runtime/account-auth` registers a Connection principal source that maps `Authorization: Bearer <token>` to `{ kind: 'account', ownerId }`, and `accounts/ended` ends that account's open peers. `@deepseek-ai/dsh-agent-runtime/account-tools` exposes `account_list`, `account_create`, `account_disable`, `account_reactivate` and `account_archive` to an active administrator account only; account ids are never accepted as caller identity. With no account token presented, every request stays the single-account `owner`, so an installation that creates no account behaves exactly as before.

## Model Experience

### Persistent conversations and routines

#### What the model sees

Mailbox and routine tools operate on stable profile ids. `exec.agent.id` is the live session id; the bridge resolves its persistent agent through registry metadata. Incoming mail remains collaborator data, and script payloads remain external data. The existing identity preset composes profile instructions and essential memories for every bound session.

#### Token effect

No extra model calls. Mail delivery and routine execution each use their own normal session turns. The calendar's trusted reminder carrier is cancelled before provider dispatch; its durable delivery receipt lets the routine engine admit exactly one execution. Ordinary scheduler reminders are unaffected.

#### KV Cache effect

New sessions reuse the profile's persona content; session-specific messages and payloads are separate history.

## Known Limitations and Deferred Work

- Discovery and interruption through the persistent-agent directory stay within the calling profile owner, or another account after an explicit stored grant.
- Legacy ownerless profiles belong to `owner`.
- The `owners` policy is composed ON in the shipped Web bundle and off in every other composition; the plugins otherwise do not modify shipped profiles.
- The `owners` entry requires a trusted account principal supplied by a Host connection adapter; the sidebar UI for sections, account sign-in pages, token rotation and password recovery are deferred.
- Accounts enter only through the bearer token issued at creation; the browser page keeps using the single-account owner peer until a sign-in UI exists.
- `account_create` returns the entry token inside the model conversation; hand it to the account holder through a private channel, and do not treat that transcript as a secret store.
- Disabling or archiving an account ends its peers immediately; it does not cancel turns already running inside those peers.
- Account administration exists only in the `account-tools` plugin; without it, trusted Host code must call the `accounts` service.
- The legacy `owner` principal remains the trusted Host caller with its existing unrestricted access.
- No account-specific UI or event grants are introduced.
- Provider accounts and automatic fallback are not implemented.
- Host shutdown disposes sessions owned by the routine runner; mailbox owns its own delivery sessions.
