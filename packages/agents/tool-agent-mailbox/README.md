---
description: "Model tools to message persistent agents, share them with other accounts and group them in sections."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-mailbox

English | [中文](README.zh.md)

## Summary

Registers `agent_send_message`, `agent_list` and `agent_interrupt` over the durable `agent-mailbox` service, plus `agent_grant_access`, `agent_revoke_access`, `agent_list_grants`, `agent_list_sections` and `agent_move_section` for sharing agents between accounts and grouping them. Tool names carry the `agent_` prefix so they never collide with the subagent-tree controls.

## Use this package

Mount where the calling persistent agent should see the mailbox tools, beside `tools` and `agentMailbox`. The [`agent-mailbox`](../agent-mailbox/README.md) package owns persistence, delivery, visibility and authority; these tools add no authority of their own. The account of the caller always comes from its persistent agent, never from an argument: only that account can grant or revoke access to its agents, and a foreign agent, section or grant answers exactly like a missing one. A grant is one-way and works only where the `accountGrants` service of the owner policy is mounted; a revoke cuts access on the next call and also refuses, with a neutral reason, any undelivered message or reply that would cross the account; a turn that already received a message keeps it. Replies name the original message with `reply_to_message_id`; a new thread accepts exactly one recipient.

## Model Experience

### Mailbox tool schemas and results

#### What the model sees

The generated [`agent_send_message`, `agent_list` and `agent_interrupt` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-agent-mailbox). The send result is a compact acceptance receipt per recipient; delivery happens after the receipt. `agent_list` returns visible agents with execution state, queue, the conversations currently working, an uncertainty flag and outstanding reply requests. `agent_interrupt` reports whether a running turn was asked to stop; without a conversation id it interrupts the only running one and asks for the id when several run. Descriptions state that message text is collaborator content, never authority.

#### Token effect

Fixed schema cost plus one compact JSON result per call. A send adds one appended user message to the target conversation; nothing is added to the sender's transcript beyond the tool result.

#### KV Cache effect

Schemas are prefix-stable while their definitions and visibility are unchanged. Calls and results append after the reusable request prefix; deliveries append after the target conversation's prefix.

## Known Limitations and Deferred Work

- Interruption is cooperative and cannot undo external effects already performed by the target.
- `agent_list` is a snapshot, not a reservation; another sender may fill the target queue immediately after the read.
- Delivery failures appear as a queued state with a reason; a crash with an open turn appears as `uncertain` and is not retried automatically. There is no separate retry tool.
- Threads are only available when the identity layer implements `thread`; the tool itself does not create conversations.
