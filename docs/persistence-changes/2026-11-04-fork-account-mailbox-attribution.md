---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-04-fork-account-mailbox-attribution

English | [中文](2026-11-04-fork-account-mailbox-attribution.zh.md)

## Summary

Acknowledges the fork additions of account caller attribution and agent-mailbox message sources in four existing Session event types. No writer version, decoder, validator or authorization policy changes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-04-fork-account-mailbox-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "59248499595135b76272553b443d5357e8001ad3046f18333f0ac6fc4bc739cf"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "9e99b4300ec5861e515350cd02b87f569bfb286216ac81dbb89d1f5225ced219"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "023f46f8d3d9469965c9a530c1085f8a714278d6af449934c481b7d6daddebf2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "d5c6d65577468bacc0386d5d828a8b7d81ee34e1652739448bd0e85689783346"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Inbox inserted user sources, developer message user sources and user/message sources retain their historical kind=user forms, rpcId and absent or existing principal. The optional principal now also admits kind=account with ownerId; absence retains the historical meaning. The same three source unions additionally admit agent-mailbox relay metadata. Current JSONL read/write opens preserve historical and new source JSON and content without account or mailbox plugins. Source metadata does not authenticate a connection or grant Session ownership. The released V4 source traversal, framing, lifecycle checks and Session message derivation are byte-identical to the code before the mailbox addition (before the fork mailbox/account changes); older readers preserve unfamiliar producer metadata rather than granting it authority. Thus both directions retain input content and existing identities without a version bump.

The session/title-llm-request messages type inherits those widened Message unions, but its existing lifecycle invariant is stricter: one canonical dsh-session-title-llm user message must represent earlier human user/message references. The producer still writes exactly that form. Historical canonical requests, including those referencing new account-attributed human input, remain readable. Account or mailbox sources substituted into the title request itself are refused on read and write opens before a handle is exposed, with original bytes retained and no recovery truncation. This is the unchanged older-reader behavior, not a newly accepted title representation. No historical format or finalized acknowledgement is modified.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/fork-source-compatibility.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/session/session-persistence-jsonl/tests/native-developer-admission.spec.ts packages/session/session-title-llm/tests: 113 tests passed in four files. The new 28-case matrix covers the seven paths, plain/zstd generations and read/write access; it checks released-codec retention, installed persistence, Session restoration/derived input, byte preservation, absent/owner/account principals, mailbox relay JSON and refusal of noncanonical title sources. Git blob comparison confirmed all inspected V4/V2 reader files, JSONL framing and Session core/derivation files unchanged across the pre-mailbox fork and the task baseline. No provider request, login or user home is used.

<a id="dev-note"></a>
## Dev Note

None.
