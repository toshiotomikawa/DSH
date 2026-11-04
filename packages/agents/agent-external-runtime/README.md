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

The external turn publishes admitted memory, mailbox, routine, and table schemas through a process-local bridge. Codex also reaches that bridge on loopback with an ephemeral in-memory credential. Harness paths, owner identity, and the credential are not model arguments, prompt text, history, or harness config. `harnessBindings` is available only to trusted Host consumers.

#### Token effect

No model requests or token consumption.

#### KV Cache effect

No change to model input or prefix reuse.

## Known Limitations and Deferred Work

- This plugin publishes an external Agent through the persistent activation port. The bundled driver is a fake SDK that records Session turns and never calls the native API model.
- Directory separation does not provide operating-system isolation or establish the provider's authenticated identity. Harness login belongs to the official harness, outside this plugin.
- Step tools are the already admitted memory, mailbox, routine, and table calls. Native file, shell, network, computer use, and other MCP servers are refused. A call with no DSH approval flow ends as `permission_required` and opens no window.
- Codex reaches the same bridge on `127.0.0.1`. The ephemeral credential stays in memory and the child environment, never in the URL, history, or harness config. The bridge closes when the step or the account ends.
- Fallback and profile UI remain later stages. A missing plugin fails activation instead of falling back to the native API.
- `createClaudeSdk` is the Claude adapter and is not the bundled driver. Tests inject a fake factory. Without one, a lazy import fails closed before any network call. Codex stays unavailable and partial because official hidden spawn is still open. The adapter does not read harness credentials.
