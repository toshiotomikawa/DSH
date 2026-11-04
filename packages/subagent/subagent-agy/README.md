---
description: "One-shot Antigravity delegation through a managed native CLI process."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-agy

## Summary

Delegate one text task to the installed Antigravity CLI. The optional bundle registers `subagent_agy`, starts a fresh native CLI process and exposes only its terminal response. Native authentication stays with agy.

## Use this package

Load `cordis.patch.yml` as an optional profile layer with `DSH_HOME` set explicitly. On Windows set `command` to the native `agy.exe`, avoiding `.cmd` wrappers. Each model is a separate provider instance configured by `model` and `providerName`.

Configuration and lifecycle settings are shared with [subagent-grok](../subagent-grok/README.md#use-this-package): command, prefix args, environment, deadline, process-release grace, output cap, private audit directory and optional quota status file. Permissions default to `reject`: the adapter selects native plan mode and never passes `--dangerously-skip-permissions`. Only explicit `allow` passes that flag. Slash-command/skill expansion is disabled in print mode.

## Understand the implementation

`index.ts` reads NDJSON and requires exactly one terminal `result` event. Intermediate step/tool events never become parent output. Malformed JSON, duplicate or missing terminal results fail safely. `SUCCESS` returns `response`; known refusal and length states map to the existing subagent stop reasons. Other native failures and quota limits return fixed diagnostics. The managed lifecycle, bounded audit, deadlines and whole-process-range cleanup are reused from Grok's internal implementation.

## Model Experience

The existing generic subagent tool exposes `subagent_agy`. There is no conversation inheritance, continuation, model override per call or structured-output capability. The caller receives final assistant text or a failure diagnostic; permission and model choices stay deployment-owned.

## Known Limitations and Deferred Work

Native plan mode constrains work and is not a replacement for a host sandbox. A CLI waiting on a native permission is bounded by the configured deadline; no prompt is forwarded to the user. Audit files may contain workspace content and need private storage and retention. Native protocol changes require updating fixtures. No automatic retries, paid fallback, quota collection or default-profile activation.

## Dev Note

Run the Grok and agy test directories together to cover both parsers and the shared lifecycle. The recorded agy fixture was reduced to its event shape and contains no account, session or workspace identifiers.
