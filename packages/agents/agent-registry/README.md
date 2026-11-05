---
description: "Stores named profiles and binds sessions to stable agent identities."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-registry

English | [中文](README.zh.md)

## Summary

Stores named profiles and binds sessions to stable agent identities.

## Table of Contents
- [Dev Note](#dev-note)

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the registry and memory services globally beside `storage-domain`, `llm`, `sessions` and `agents`. Mount the tool plugin where memory tools should be available. Bind a session to a persistent profile before using its memory tools. The optional `@deepseek-ai/dsh-tool-agent-memory/preset` row takes `agentId` and belongs inside an agent preset; its persona shadows the deployment prefix. See [persistent agents](../../../docs/subsystems/persistent-agents.md) for configuration and transaction semantics.

New profiles record the Remote connection account as `ownerId`; trusted local creation defaults to `owner`. A Remote account can list, read and edit only its own profiles, and model-supplied ownership cannot replace the connection identity. Existing records without an owner retain the single-account meaning. Session bindings copy the profile owner into the optional Session ownership sidecar; profile edits cannot transfer ownership.

Sidebar sections are flat groups owned by one account: `listSections`, `createSection(name)`, `renameSection(id, name)`, `deleteSection(id)` and `assignSection(agentId, sectionId | null)`. A profile stores `sectionId`; moving or ungrouping it changes only that field, never the profile id, history, memory or routines. Deleting a section ungroups its members first, then removes the group. A name is 1 to 40 characters; an unknown or foreign section id fails with the same `Unknown section` error, and sections never grant access to another account. The sidebar UI that renders these groups is not part of this package yet.

Profiles resolve an omitted `runtime` as `native`. `claude-sdk` and `codex-sdk` store a separate optional `runtimeModel`; it is retained but unused in native mode. External profiles skip validation of the unused primary API route, while every saved reserve remains validated and automatic fallback still requires explicit consent. `selection()` refuses external profiles before API activation; changing runtime never silently selects an API provider. The optional [external runtime configuration](../agent-external-runtime/README.md) resolves private account harness directories.

<a id="model-experience"></a>
## Model Experience

### Persistent identity and memories

#### What the model sees

This service contributes no text by itself. The optional persistent-agent preset row reads profile instructions and essential memories for the selected agent.

#### Token effect

No extra model requests. Essential memory context is bounded by `essentialBytes`, including its warning and serialized ids. Search returns at most the requested result count, subject to the configured per-memory size.

#### KV Cache effect

The prompt prefix stays stable while the profile and essential selection are unchanged. A changed profile or essential memory changes subsequent prompt assembly and may invalidate prefix reuse.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- No automatic model fallback, provider-account switching, permission elevation, mailbox or routine execution.
- Account filtering follows the Remote connection principal; trusted Host code outside a Remote call retains administrative access.
- Account creation, authentication and sharing are deferred.
- Coordination is process-local, matching storage-domain.
- Session agentId metadata lives in the agents domain rather than changing upstream session headers.
- Memory commits are observed after completed turn/end; tools report staging, and the next agent prompt waits for admitted commits.
- Failed commits are logged and surfaced once to the affected session before retry.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
