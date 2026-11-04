---
description: "Remembers, forgets and searches data for the calling agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-memory

English | [中文](README.zh.md)

## Summary

Remembers, forgets and searches data for the calling agent.

## Use this package

Mount the registry and memory services globally beside `storage-domain`, `llm`, `sessions` and `agents`. Mount the tool plugin where memory tools should be available. Bind a session to a persistent profile before using its memory tools. The optional `@deepseek-ai/dsh-tool-agent-memory/preset` row takes `agentId` and belongs inside an agent preset; its persona shadows the deployment prefix. See [persistent agents](../../../docs/subsystems/persistent-agents.md) for configuration and transaction semantics.

## Model Experience

### Persistent identity and memories

#### What the model sees

The four tool schemas are in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-agent-memory). The preset contributes profile instructions literally, followed by essential memories explicitly marked as untrusted data.

#### Token effect

No extra model requests. Essential memory context is bounded by `essentialBytes`, including its warning and serialized ids. Search returns at most the requested result count, subject to the configured per-memory size.

#### KV Cache effect

The prompt prefix stays stable while the profile and essential selection are unchanged. A changed profile or essential memory changes subsequent prompt assembly and may invalidate prefix reuse.

## Known Limitations and Deferred Work

- No automatic model fallback, provider-account switching, permission elevation, mailbox or routine execution.
- The optional ownerId field is stored without access filtering until M7.
- Coordination is process-local, matching storage-domain.
- Session agentId metadata lives in the agents domain rather than changing upstream session headers.
- Memory commits are observed after completed turn/end; tools report staging, and the next agent prompt waits for admitted commits.
- Failed commits are logged and surfaced once to the affected session before retry.
