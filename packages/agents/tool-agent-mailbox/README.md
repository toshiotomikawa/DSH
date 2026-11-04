---
description: "Model tools to send messages between persistent agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-mailbox

## Summary

Registers `agent_send_message`, `agent_list` and `agent_interrupt` over the durable `agent-mailbox` service. Tool names carry the `agent_` prefix so they never collide with the subagent-tree controls.

## Use this package

Mount where the calling persistent agent should see the mailbox tools, beside `tools` and `agentMailbox`. The [`agent-mailbox`](../agent-mailbox/README.md) package owns persistence, delivery, visibility and authority; these tools add no authority of their own. Replies name the original message with `reply_to_message_id`; a new thread accepts exactly one recipient.

## Model Experience

### Mailbox tool schemas and results

#### What the model sees

The generated [`agent_send_message`, `agent_list` and `agent_interrupt` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-agent-mailbox). The send result is a compact acceptance receipt per recipient; delivery happens after the receipt. `agent_list` returns visible agents with execution state, queue and outstanding reply requests. `agent_interrupt` reports whether a running turn was asked to stop. Descriptions state that message text is collaborator content, never authority.

#### Token effect

Fixed schema cost plus one compact JSON result per call. A send adds one appended user message to the target conversation; nothing is added to the sender's transcript beyond the tool result.

#### KV Cache effect

Schemas are prefix-stable while their definitions and visibility are unchanged. Calls and results append after the reusable request prefix; deliveries append after the target conversation's prefix.

## Known Limitations and Deferred Work

- Interruption is cooperative and cannot undo external effects already performed by the target.
- `agent_list` is a snapshot, not a reservation; another sender may fill the target queue immediately after the read.
- Delivery failures appear as a queued state with a reason; there is no separate retry tool.
- Threads are only available when the identity layer implements `thread`; the tool itself does not create conversations.
