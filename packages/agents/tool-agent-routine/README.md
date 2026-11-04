---
description: "Model tools for persistent agent routines."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-routine

## Summary

Registers routine_create, routine_update, routine_list, routine_test and routine_no_update over agent-routine.

## Use this package

Mount beside tools and agentRoutines with agentRoutineBridge available. The bridge resolves exec.agent.id, a live session id, into the persistent agent that owns its routines. Model arguments cannot select another agent's routines. A manual test works while paused and does not arm the calendar or move its next occurrence.

## Model Experience

### Routine management and outcomes

#### What the model sees

The generated tool schemas and compact JSON results containing routine ids, state and execution history. Creating or testing returns admission rather than a completed report. `routine_no_update` applies only inside a routine execution and suppresses its report while preserving history. Script payloads remain external data and cannot replace the registered instruction.

#### Token effect

Fixed tool-schema cost and one result per call. routine_test admits a separate execution turn; listing and editing definitions do not call a provider.

#### KV Cache effect

Tool definitions remain prefix-stable while enabled. Tool calls and results append to the caller's history; admitted routine work uses a new session with its own prefix.

## Known Limitations and Deferred Work

- Pausing does not undo external effects of an already admitted run.
- Removing a routine explicitly deletes its execution history.
- Tools rely on the bridge and service for ownership and scheduling; they do not add user-level authorization or automatic provider fallback.
