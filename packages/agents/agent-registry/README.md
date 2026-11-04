---
description: "Stores named profiles and binds sessions to stable agent identities."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-registry

## Summary

Stores named profiles and binds sessions to stable agent identities.

## Use this package

Mount the registry and memory services globally beside `storage-domain`, `llm`, `sessions` and `agents`. Mount the tool plugin where memory tools should be available. Bind a session to a persistent profile before using its memory tools. The optional `@deepseek-ai/dsh-tool-agent-memory/preset` row takes `agentId` and belongs inside an agent preset; its persona shadows the deployment prefix. See [persistent agents](../../../docs/subsystems/persistent-agents.md) for configuration and transaction semantics.

New profiles record the Remote connection account as `ownerId`; trusted local creation defaults to `owner`. A Remote account can list, read and edit only its own profiles, and model-supplied ownership cannot replace the connection identity. Existing records without an owner retain the single-account meaning. Session bindings copy the profile owner into the optional Session ownership sidecar; profile edits cannot transfer ownership.

Sidebar sections are flat groups owned by one account: `listSections`, `createSection(name)`, `renameSection(id, name)`, `deleteSection(id)` and `assignSection(agentId, sectionId | null)`. A profile stores `sectionId`; moving or ungrouping it changes only that field, never the profile id, history, memory or routines. Deleting a section ungroups its members first, then removes the group. A name is 1 to 40 characters; an unknown or foreign section id fails with the same `Unknown section` error, and sections never grant access to another account. The sidebar UI that renders these groups is not part of this package yet.

## Model Experience

### Persistent identity and memories

#### What the model sees

This service contributes no text by itself. The optional persistent-agent preset row reads profile instructions and essential memories for the selected agent.

#### Token effect

No extra model requests. Essential memory context is bounded by `essentialBytes`, including its warning and serialized ids. Search returns at most the requested result count, subject to the configured per-memory size.

#### KV Cache effect

The prompt prefix stays stable while the profile and essential selection are unchanged. A changed profile or essential memory changes subsequent prompt assembly and may invalidate prefix reuse.

## Known Limitations and Deferred Work

- No automatic model fallback, provider-account switching, permission elevation, mailbox or routine execution.
- Account filtering follows the Remote connection principal; trusted Host code outside a Remote call retains administrative access.
- Account creation, authentication and sharing are deferred.
- Coordination is process-local, matching storage-domain.
- Session agentId metadata lives in the agents domain rather than changing upstream session headers.
- Memory commits are observed after completed turn/end; tools report staging, and the next agent prompt waits for admitted commits.
- Failed commits are logged and surfaced once to the affected session before retry.
