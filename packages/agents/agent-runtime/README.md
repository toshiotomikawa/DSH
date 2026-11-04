---
description: "Connects persistent agent identities to mailbox and routine sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-runtime

## Summary

Connects persistent agent identities to mailbox and routine sessions.

## Use this package

Mount globally after agent-registry, agent-memory, agents and system-prompt, before agent-mailbox and agent-routine. It provides `agentDirectory` and `agentRoutineBridge`. Mailbox conversations are durably bound before creation or resume; bound sessions receive the identity persona and essential memories. Each routine execution creates one fresh session and returns admission before its turn settles.

The optional `@deepseek-ai/dsh-agent-runtime/owners` plugin mounts the account policy in `remote-access`. Add its `fork-owner-policy` entry to a Web composition that already mounts persistent storage and the Session Controller. It stores optional `ownerId` metadata in the per-record `session_owners` domain, leaving released Session headers and logs unchanged. Existing Sessions are adopted by `owner`; create, fork and persistent-agent binding save their trusted owner before returning. A Session whose owner write fails is recorded as denied instead of keeping the account the creation event adopted first, so it stays hidden from every account until a later assignment succeeds. Account principals see only owned Session rows and FTS results, and foreign and unknown Session ids receive the same access denial. Sidecar damage blocks account-policy activation and preserves the damaged document. Disposing the plugin removes its service and policy.

## Model Experience

### Persistent conversations and routines

#### What the model sees

Mailbox and routine tools operate on stable profile ids. `exec.agent.id` is the live session id; the bridge resolves its persistent agent through registry metadata. Incoming mail remains collaborator data, and script payloads remain external data. The existing identity preset composes profile instructions and essential memories for every bound session.

#### Token effect

No extra model calls. Mail delivery and routine execution each use their own normal session turns. The calendar's trusted reminder carrier is cancelled before provider dispatch; its durable delivery receipt lets the routine engine admit exactly one execution. Ordinary scheduler reminders are unaffected.

#### KV Cache effect

New sessions reuse the profile's persona content; session-specific messages and payloads are separate history.

## Known Limitations and Deferred Work

Discovery and interruption through the persistent-agent directory stay within the calling profile owner. Legacy ownerless profiles belong to `owner`. The plugins are opt-in and do not modify shipped profiles. The `owners` entry requires a trusted account principal supplied by a Host connection adapter; account provisioning, sign-in, sections and sharing are deferred. The legacy `owner` principal remains the trusted Host caller with its existing unrestricted access. No account-specific UI or event grants are introduced. Provider accounts and automatic fallback are not implemented. Host shutdown disposes sessions owned by the routine runner; mailbox owns its own delivery sessions.
