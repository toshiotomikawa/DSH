---
description: "Resolves explicit account harness bindings for persistent external agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-external-runtime

English | [中文](README.zh.md)

The Host plugin installs the official Claude adapter lazily. Plugin load does not import the SDK, read credentials or start a process. Tests explicitly inject simulated SDKs; the product never completes a turn with a recording fake.

## Summary

Resolves explicit account harness bindings for persistent external agents.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this optional Host plugin after the persistent registry, accounts and Session owner policy. Configure `bindings` with `accountId`, `runtime` (`claude-sdk` or `codex-sdk`), absolute `configDirectory` and positive integer `revision`. Empty bindings grant no harness access, including for legacy `owner`. A binding is deployment configuration, never a model tool argument. Reload with a higher revision after changing a binding or the harness login.

`harnessBindings.resolve(sessionId, workspace)` derives the profile from durable Session metadata and requires agreement with its owner sidecar. Named accounts must still be active. Local existing directories are canonicalized without listing their content; duplicate account/runtime rows and overlapping physical directories belonging to different owners are rejected before service publication. Workspace overlap with any configured harness directory is refused. The result is a detached private Host value: do not return it to tools, log it or put it in a prompt. Symlink retargeting of a canonical directory fails with `binding_stale`.

Expected failures use `HarnessBindingError.code`; filesystem paths and causes are not exposed. A Host that installed no external adapter refuses the profile with `HarnessAdapterError.code` `sdk_unavailable` before publishing anything. Configuration errors prevent publication; activation errors leave the binding unchanged. Correct the Host configuration or identity and retry explicitly. Disposal removes the service.

See [persistent agents](../../../docs/subsystems/persistent-agents.md) for identity and ownership semantics.

<a id="model-experience"></a>
## Model Experience

Subscription quota is recognized only from a rejected `five_hour` or `seven_day` SDK notification. Informational limits, authentication errors and unknown failures do not select an API route. `EXTERNAL_QUOTA_EXHAUSTED` closes the external turn as failed, with no automatic retry or transfer of its input, mailbox receipt or routine settlement.

The per-record `agent_external_quota` domain keeps a refusal by owner and persistent agent. Only a later activation may use the first saved reserve, after explicit `automaticFallback` consent, route revalidation and successful disposal of the previous handle. A tool call or partial output prohibits that reserve. Abortion and unconfirmed teardown keep the refusal. A clean provider-reported deadline expires on the next activation; an absent deadline requires explicit Host recovery through the activation service's quota state, after the live handle is closed. Native execution starts a new turn; it never adopts the failed turn. A stored external log written before this driver reserved an empty system head stays readable by the driver, but any native turn over it is refused with `SURFACE_HEAD_MISSING`; start a new conversation. The plugin never rewrites that history.

### Account harness configuration

#### What the model sees

The external turn publishes admitted memory, mailbox, routine, and table schemas through a process-local bridge. Codex also reaches that bridge on loopback with an ephemeral in-memory credential. Harness paths, owner identity, and the credential are not model arguments, prompt text, history, or harness config. `harnessBindings` is available only to trusted Host consumers.

#### Token effect

The Host installs the official Claude adapter, so an external turn consumes the subscription of the account whose harness directory is bound. A separately activated reserve uses the ordinary native API route and its normal token costs; saving a reserve alone does not enable it.

#### KV Cache effect

No change to model input or prefix reuse.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- This plugin publishes an external Agent through the persistent activation port. The Host installs the official Claude adapter; a service without one refuses activation with `sdk_unavailable` instead of completing a turn. Only explicit reserve consent can select a native API on a later activation.
- Directory separation does not provide operating-system isolation or establish the provider's authenticated identity. Harness login belongs to the official harness, outside this plugin.
- Step tools are the already admitted memory, mailbox, routine, and table calls. Native file, shell, network, computer use, and other MCP servers are refused. A call with no DSH approval flow ends as `permission_required` and opens no window.
- Codex reaches the same bridge on `127.0.0.1`. The ephemeral credential stays in memory and the child environment, never in the URL, history, or harness config. The bridge closes when the step or the account ends.
- A missing plugin fails activation instead of selecting a native API. Profile UI remains a separate consumer of the saved configuration.
- `createClaudeSdk` is the Claude adapter and is not the bundled driver. Tests inject a fake factory. Without one, a lazy import fails closed before any network call. Codex stays unavailable and partial because official hidden spawn is still open. The adapter does not read harness credentials.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
