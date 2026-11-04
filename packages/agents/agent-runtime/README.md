---
description: "Connects persistent agent identities to mailbox and routine sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-runtime

## Summary

Connects persistent agent identities to mailbox and routine sessions.

## Use this package

Mount globally after agent-registry, agent-memory, agents and system-prompt, before agent-mailbox and agent-routine. It provides `agentDirectory` and `agentRoutineBridge`. Mailbox conversations are durably bound before creation or resume; bound sessions receive the identity persona and essential memories. Each routine execution creates one fresh session and returns admission before its turn settles.

## Model Experience

### Persistent conversations and routines

#### What the model sees

Mailbox and routine tools operate on stable profile ids. `exec.agent.id` is the live session id; the bridge resolves its persistent agent through registry metadata. Incoming mail remains collaborator data, and script payloads remain external data. The existing identity preset composes profile instructions and essential memories for every bound session.

#### Token effect

No extra model calls. Mail delivery and routine execution each use their own normal session turns. The calendar's trusted reminder carrier is cancelled before provider dispatch; its durable delivery receipt lets the routine engine admit exactly one execution. Ordinary scheduler reminders are unaffected.

#### KV Cache effect

New sessions reuse the profile's persona content; session-specific messages and payloads are separate history.

## Known Limitations and Deferred Work

- All registered profiles are visible in the single-user deployment. ownerId is retained without authorization logic until multi-user support.
- The plugin is opt-in and does not modify shipped profiles.
- Provider accounts and automatic fallback are not implemented.
- Host shutdown disposes sessions owned by the routine runner; mailbox owns its own delivery sessions.
