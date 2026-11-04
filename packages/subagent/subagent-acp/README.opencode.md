# OpenCode configuration proof

`cordis.patch.yml` mounts the existing ACP plugin and the generic subagent tool as `subagent_opencode_go_flash`. It fixes `opencode-go/deepseek-v4.1-flash` through `OPENCODE_CONFIG_CONTENT` and rejects permission requests. Each additional native model requires another named ACP instance with its own configuration. No core or ACP implementation change is needed.

The overlay uses `command: opencode`; on Windows override it with the native executable path rather than a `.cmd` wrapper. The subprocess service supplies hidden execution, credential scrubbing and whole-range cleanup. Native account authentication remains local to OpenCode. The ACP provider supports `session/cancel`; it advertises no `agentPreset` or `agentOptions` capability.

The opt-in `tests/opencode.spec.ts` mounts the real subagent service, subprocess service and ACP provider. Set `M4_OPENCODE_SMOKE=1`, optionally `M4_OPENCODE_COMMAND`, and `DSH_HOME` to the repository's `.dsh-test`; then run that test file with Vitest. It delegates one short prompt with a 60-second bound. Ordinary tests skip the live call. Existing mock ACP tests cover protocol setup, refusals, streamed fragments, permissions and cancellation without model usage.

There is no provider quota checker in the existing ACP implementation; native quota failures retain its normal error mapping. The new headless providers' quota-file check is separate. The host should select the preferred account/model before delegation; no provider retries on another paid route.
