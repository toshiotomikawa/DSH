---
description: "Resolves explicit account harness bindings for persistent external agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-external-runtime

English | [中文](README.zh.md)

## Summary

Resolves explicit account harness bindings for persistent external agents.

## Use this package

Mount this optional Host plugin after the persistent registry, accounts and Session owner policy. Configure `bindings` with `accountId`, `runtime` (`claude-sdk` or `codex-sdk`), absolute `configDirectory` and positive integer `revision`. Empty bindings grant no harness access, including for legacy `owner`. A binding is deployment configuration, never a model tool argument. Reload with a higher revision after changing a binding or the harness login.

`harnessBindings.resolve(sessionId, workspace)` derives the profile from durable Session metadata and requires agreement with its owner sidecar. Named accounts must still be active. Local existing directories are canonicalized without listing their content; duplicate account/runtime rows and overlapping physical directories belonging to different owners are rejected before service publication. Workspace overlap with any configured harness directory is refused. The result is a detached private Host value: do not return it to tools, log it or put it in a prompt. Symlink retargeting of a canonical directory fails with `binding_stale`.

Expected failures use `HarnessBindingError.code`; filesystem paths and causes are not exposed. Configuration errors prevent publication; activation errors leave the binding unchanged. Correct the Host configuration or identity and retry explicitly. Disposal removes the service.

See [persistent agents](../../../docs/subsystems/persistent-agents.md) for identity and ownership semantics.

## Model Experience

### Account harness configuration

#### What the model sees

No tools or prompt text. `harnessBindings` is available only to trusted Host consumers.

#### Token effect

No model requests or token consumption.

#### KV Cache effect

No change to model input or prefix reuse.

## Known Limitations and Deferred Work

- This configuration plugin does not start a driver or SDK. External profiles cannot use native API activation.
- Directory separation does not provide operating-system isolation or establish the provider's authenticated identity. Harness login belongs to the official harness, outside this plugin.
- Binding reload cancellation, driver activation, MCP permissions, SDK adapters, fallback and profile UI are separate integration stages.
- Claude uses the official Agent SDK; Codex uses the official app-server through the existing managed process path. Neither is imported or launched here.
