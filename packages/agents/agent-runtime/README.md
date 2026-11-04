---
description: "Connects persistent agent identities to mailbox and routine sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-runtime

English | [中文](README.zh.md)

## Summary

Connects persistent agent identities to mailbox and routine sessions.

## Use this package

Mount globally after agent-registry, agent-memory, agents and system-prompt, before agent-mailbox and agent-routine. It provides `agentDirectory` and `agentRoutineBridge`. Mailbox conversations are durably bound before creation or resume; bound sessions receive the identity persona and essential memories. Each routine execution creates one fresh session and returns admission before its turn settles.

The optional `@deepseek-ai/dsh-agent-runtime/owners` plugin mounts the account policy in `remote-access`. Add its `fork-owner-policy` entry to a Web composition that already mounts persistent storage and the Session Controller; the shipped Web bundle composes it ON. It stores optional `ownerId` metadata in the per-record `session_owners` domain, leaving released Session headers and logs unchanged. Existing Sessions are adopted by `owner`; create, fork and persistent-agent binding save their trusted owner before returning. A Session whose owner write fails is recorded as denied instead of keeping the account the creation event adopted first, so it stays hidden from every account until a later assignment succeeds. Account principals see only owned Session rows and FTS results, and foreign and unknown Session ids receive the same access denial. Sidecar damage blocks account-policy activation and preserves the damaged document. Disposing the plugin removes its service and policy.

The same plugin provides `accountGrants`, an explicit directional grant between accounts stored in the `account_grants` domain: `grant(ownerId, granteeId)`, `revoke(ownerId, granteeId)` and `allows(ownerId, granteeId)`. The persistent-agent directory and `agent_send_message` list another account's agents only when that account granted the caller; interruption follows the same grant. The host account and same-owner calls need no grant. `list(ownerId)` returns the accounts one owner admitted. Persistent agents grant and revoke through `agent_grant_access` and `agent_revoke_access` of the mailbox tools, which act only for the caller’s own account. A revoke applies on the next directory read and also cuts mail that was already accepted: the mailbox asks `agentDirectory.reaches(fromId, toId)` again when a pending delivery is attempted and when a reply is written, so an undelivered message or reply across the revoked account is recorded as `refused` with a neutral reason that never names the other account. A turn that already received a message keeps it.

The `@deepseek-ai/dsh-agent-runtime/accounts` plugin opens the per-record `accounts` domain and provides `accounts`: `create(name, role)` returns the new account and the path of its one-time token file, `list`, `get`, `disable`, `reactivate` and `archive`, plus `authenticate(token)` and `isAdministrator(id)`. The token text is written once to a `0o600` file under `$DSH_HOME/accounts/tokens`, outside the Session workspace, and only its SHA-256 hash is stored; the returned value never carries the secret. Archived accounts stay readable and lose their credential; disabling an account keeps its data and token. `@deepseek-ai/dsh-agent-runtime/account-auth` registers a Connection principal source that maps `Authorization: Bearer <token>` to `{ kind: 'account', ownerId }`, and `accounts/ended` ends that account's open peers. `@deepseek-ai/dsh-agent-runtime/account-tools` exposes `account_list`, `account_create`, `account_disable`, `account_reactivate` and `account_archive` to an active administrator account only; account ids are never accepted as caller identity, and `account_create` returns the token file path rather than the token. Requests without an account credential retain the legacy owner authentication flow.

## Browser account entry

`@deepseek-ai/dsh-agent-runtime/account-web` serves `/account/login`, `/account/access` and POST-only `/account/logout`. Login accepts the entry token only in a bounded, same-origin form POST and exchanges it for an opaque, HttpOnly, SameSite=Strict session cookie (Secure on TLS); the entry token is neither returned nor retained. The server stores only a hash of the session credential in memory, bound to the listener origin and account. `sessionMinutes` defaults to 720 (1–10080), and `maxSessions` to 1000 (1–100000). Expiry, logout, account disable/archive and plugin unload end the applicable account Peers; because Connection shares a Peer per account, other browser sessions of that account reconnect. Restart requires another login. Login clears the previous owner cookie; signing out never restores owner authority automatically.

The access page calls the same `accountGrants.grant`, `revoke` and `list` service used by `agent_grant_access`, `agent_revoke_access` and `agent_list_grants`. The caller is the authenticated account, never an owner id in a form. Targets are entered by id; no account directory is exposed. The page lists only outgoing grants and confirms revocation before its POST. English and Portuguese are selected from the browser language; other languages use English. No model, agent turn or persistent browser storage participates in either page.

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
- A revoke cannot recall a message a running turn already received.
- Legacy ownerless profiles belong to `owner`.
- The `owners` policy is composed ON in the shipped Web bundle and off in every other composition; the plugins otherwise do not modify shipped profiles.
- Token rotation and password recovery remain outside the browser entry pages.
- Account forms require Origin to match the receiving listener’s protocol and Host; TLS termination at a reverse proxy is not supported by these entry forms.
- Account pages use root-relative routes; deployments under a reverse-proxy path prefix require route rewriting. Browser inspection has not been performed.
- `account_create` writes the entry token to a restricted file under `$DSH_HOME/accounts/tokens`; the model receives only that path, and the file must be handed to the account holder privately and then deleted.
- Disabling or archiving an account ends its peers immediately; it does not cancel turns already running inside those peers.
- Account administration exists only in the `account-tools` plugin; without it, trusted Host code must call the `accounts` service.
- The legacy `owner` principal remains the trusted Host caller with its existing unrestricted access.
- Grants admit messages between agents, never shared conversations, memories or tables.
- Provider accounts and automatic fallback are not implemented.
- Host shutdown disposes sessions owned by the routine runner; mailbox owns its own delivery sessions.
