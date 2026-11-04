---
description: "Durable messages between persistent agents rooted in different sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mailbox

## Summary

Stores durable messages and per-recipient deliveries between persistent agents whose root sessions differ. The sender is always the authenticated live agent; the identity layer supplies visible targets, stable ids and interruption authority.

## Use this package

Mount beside `storage-domain`, `agents` and `session-persistence`, and provide an `agentDirectory` implementation from the persistent-agent integration. The directory resolves stable ids to conversations, decides visibility and interruption authority, and creates a fresh conversation for `newThread`. Delivery opens or resumes the target conversation through `ctx.agents` and queues one turn through `followup`; a busy target keeps the message for its next turn. The companion `@deepseek-ai/dsh-tool-agent-mailbox` exposes `agent_send_message`, `agent_list` and `agent_interrupt`.

Messages and pending deliveries live in the `agent_mailbox` storage domain. A repeated `idempotencyKey` returns the previous message instead of accepting a second one. A reply is accepted only from a recipient of the original message, only once, and returns to the conversation that sent the original request.

## Model Experience

### Delivered mailbox messages

#### What the model sees

Each accepted delivery becomes one user message in the target conversation. It carries the `agent-mailbox` source, names the mailbox message id, the sender name and stable id, states that the text is collaborator content rather than authority, and includes a `reply_to_message_id` instruction when a reply is expected. The message body is bounded to 64 KiB.

#### Token effect

One appended user message per delivery, at most one per recipient per send. The reply instruction adds one fixed line; informational messages omit it.

#### KV Cache effect

The delivery appends after the target conversation's existing history and does not replace earlier tokens. Sending a message does not change the sender's own request prefix.

## Known Limitations and Deferred Work

- Delivery is process-local and serialized through one pump; a restart retries queued deliveries, but an unobservable crash after an external turn starts is not exactly-once.
- `ownerId` is stored without access filtering until the multi-user milestone.
- Interruption asks the target's agent loop to cancel its current turn; it cannot undo external effects that already ran.
- A new conversation uses the route supplied by the identity layer; a target without a route can only be woken when its session already records a selection.
- No email, chat or other external channel delivery: this package carries agent-to-agent messages only.
