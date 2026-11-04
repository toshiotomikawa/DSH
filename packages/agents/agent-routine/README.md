---
description: "Persistent per-agent routines over the host scheduler."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-routine

## Summary

Persists routine definitions and execution history, serializes admission, and handles calendar delivery, quota waits and authenticated local script triggers.

## Use this package

Mount with storage-domain, schedule and host-webserver. For persistent agents, mount agent-runtime first to supply agentRoutineBridge. Each admitted execution receives a fresh bound session; the runner returns admission immediately and reports the turn outcome through engine.settle. The local trigger uses a token file under DSH_HOME unless configured otherwise. Scripts may explicitly run a paused routine when scriptEnabled is true; calendar and webhook deliveries respect pause.

The engine owns its scheduler tasks. Generic schedule edits, Remote edits and bulk cleanup cannot mutate or remove these tasks; use `routine_update`, which validates the three-minute recurrence floor and preserves the fresh-session target. A pre-write `schedule/validate-edit` hook enforces this policy in the routine plugin, without replacing scheduler methods or changing ordinary tasks.

## Model Experience

### Fresh routine executions

#### What the model sees

The admitted instruction, a `[ROTINA]` execution notice and any script payload in a fenced `[DADOS EXTERNOS]` block. Identity and essential memories come from the persistent-agent runtime. The instruction must stand alone because each execution starts a new session. tool-agent-routine supplies definition, history and no-update tools.

#### Token effect

Each admitted execution uses its own ordinary model turn. Calendar delivery itself adds no provider call when agent-runtime is mounted. Waiting for quota adds no model calls until the engine admits a retry.

#### KV Cache effect

The identity prefix can remain stable across executions; the run instruction and optional payload are separate session content. This package does not promise provider-side cache reuse.

## Known Limitations and Deferred Work

- Execution is process-local and requires the host to remain running.
- A run with possible external effects fails with uncertainty instead of automatically repeating those effects.
- A stopped host cannot promise exact-time execution; missed-occurrence policies determine later admission.
- Provider account selection and automatic model fallback are outside this package.
