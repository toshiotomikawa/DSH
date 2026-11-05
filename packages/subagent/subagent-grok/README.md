---
description: "One-shot Grok Build delegation through a managed native CLI process."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-grok

English | [中文](README.zh.md)

## Summary

Delegate one text task to an installed Grok Build CLI. The optional bundle registers `subagent_grok`. Every call starts a fresh process in the caller's workspace and returns only the terminal assistant text. Native authentication stays with Grok.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Load `cordis.patch.yml` as an optional profile layer. Set `DSH_HOME` explicitly; the bundle writes audit artifacts below that home. On Windows configure `command` with the native executable path, rather than a `.cmd` shim. The shared subprocess provider owns `windowsHide`, credential scrubbing and termination of the whole process range. No shell is used to expand the prompt.

The deployment owns `providerName`, `command`, `args` (prefix arguments), `model`, `permission`, `env`, `timeoutMs` (120000), `disposeGraceMs` (3000), `maxOutputBytes` (4194304), `logDirectory` (required absolute path), `quotaFile` (optional) and `minimumRemainingPercent` (10). Multiple models use separate named instances. `permission` defaults to `reject` (`dontAsk`); only an explicit `allow` selects `bypassPermissions`. Built-in web search and nested subagents are disabled.

`quotaFile` is a JSON file with `{ "remainingPercent": 75 }`. A value below the floor refuses before spawn; invalid/unreadable files fail closed. Without a checker the plugin warns and proceeds. `quotaStatus` exposes the file reader to host consumers; provider preference belongs to the caller. There are no automatic retries or paid fallbacks.

<a id="understand-the-implementation"></a>
## Understand the implementation

`index.ts` owns Grok's whole-result JSON protocol. `headless.ts` owns the common managed lifecycle used by this plugin and `subagent-agy`; sharing avoids duplicating more than 150 lines without introducing another package. Each child has a deadline and an output cap. Collected stdout/stderr are saved in a private per-run log, never appended to the parent conversation. Logs may contain workspace/tool content: use a private directory and manage retention there. The cap also bounds audit artifacts; truncation is recorded and never reported as success.

Native `end_turn` maps to `completed`, refusal to `refusal`, length limit to `max-tokens`, cancellation to `aborted`. Other failures use the existing `error` stop reason with fixed diagnostics including `cota_baixa`, `cota_esgotada` or `tempo_esgotado`. Raw stderr, environment values and exception messages never enter diagnostics. A nonzero exit cannot complete successfully. Dispose is idempotent and waits for managed-range exit; an unobservable cleanup failure rejects disposal and warns that process state is unknown. Failure after starting a task is never permission to retry it automatically.

<a id="dev-note"></a>
## Dev Note

Run `node node_modules/vitest/vitest.mjs run packages/subagent/subagent-grok packages/subagent/subagent-agy`. Fixtures need no credentials or network. The tests include real harmless Node subprocesses for secret scrubbing and deadline cleanup. Live provider calls are manual and limited separately.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-subagent`, which owns the `subagent_grok` schema and result rendering; this provider adds no conversation inheritance, continuation, per-call model override or structured output, only final assistant text or a safe failure.

#### KV Cache effect

No direct invalidation; the provider contributes no request content of its own, so its lifecycle does not change the reusable prefix beyond the subagent tool's documented schema and result append.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- No continuation, follow-up messages, model discovery, interactive approvals or automatic quota collection.
- Quota freshness is the writer's responsibility, and CLI versions must match the recorded JSON contract.
- Streaming tool traffic stays in bounded local audit artifacts.
- Native accounts and configuration can influence tools; this integration does not add a sandbox.
- The bundle is optional and is not enabled in default profiles.
