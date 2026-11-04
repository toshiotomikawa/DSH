# Agent Note: Image reads stay inside the addressed Session under account ownership

Status: implemented

English | [中文](2026-11-04-session-scoped-image-reads.zh.md)

## Problem

Account ownership gave each connection a filtered Session list and search, but `session/attachment` only authorized the Session identity and then read whatever reference the caller sent. Image ids are the SHA-256 of the normalized bytes, so an account that owned any Session and knew a hash could read an image that only another account's Session had logged. The M7a audit reproduced it: the corpus of the audit exposed the text of a fork to the account that should not have it, and the image read had no membership test at all.

The [store-scoped decision](2026-10-23-store-scoped-image-reads.md) accepted exactly this exposure because a membership scan costs history-length work on every uncached image read, which the desktop application could not afford.

## Decision

When the account ownership sidecar (`sessionOwners`) is mounted, `session/attachment` requires the addressed Session's own durable log to carry the requested reference. The handler observes that Session with `projectionMode: 'none'` and accepts the read only when a message derived from its events contains an image block with that attachment id. The gateway permission check on the Session resource still runs first, and the Session is never activated or resumed for the check.

A reference the addressed Session never logged fails with the same terminal `session/attachment-invalid` and reason `ATTACHMENT_NOT_FOUND` as an object that does not exist, whether the image belongs to another Session or to no Session, so the failure carries no existence oracle. An unreadable Session log does not fall back to a store read.

Without that sidecar the endpoint keeps its store-scoped upstream behavior, including the zero-history read path. The restriction exists to separate accounts; a Host that mounts one account has nothing to separate.

## Alternatives considered

**Keep store-scoped reads and rely on hash secrecy.** The id is computable from known PNG, JPEG, or WebP bytes that admission preserves unchanged, so the hash is not a boundary between accounts.

**Enforce membership unconditionally.** It closes the same hole, but it charges every single-account Host a log read per image for a rule that protects nothing there, and the shipped desktop composition mounts no account policy. The composition-conditional rule keeps the upstream cost off the path that needs no protection.

**Maintain a Session-to-image index or projection.** An index removes the repeated scan but needs derivation, lifetime, and invalidation work for every historical, forked, tool-result, and offloaded image before the first read; deferred until the cold-path scan proves expensive under accounts.

**Issue signed per-Session image tickets.** More issuance and validation state for the same membership rule.

## Consequences

Under account ownership a cold Session pays one full log observation per uncached image instead of none, so a long cold conversation loads its images proportionally to its history. A live Session reads its in-memory cut, and tool-result, fork-inherited, and offloaded images remain readable because their references stay in the events.

The `image-read.perf.ts` diagnostic still measures storage, transport, and history separately, but its `--expect-no-history` mode describes the pre-change controller and must be re-baselined before it is reused as evidence.

The rule is one identity check short of a complete Session log: a Session record adopted by `owner`, or a denied record, still authorizes only the gateway's own permission decision. Session existence, ownership, and denial remain the ownership sidecar's job; this rule only refuses bytes.

## Verification

`remote-access.host.spec.ts` proves that a reference logged only by another Session and a reference logged by nobody fail with the same code, reason, and message, that no bytes reach the store, and that a reference the addressed Session logged still resolves. `commands-queue-attachment.host.spec.ts` covers the logged read, the unlogged hash, a missing Session, the unreadable log, and the store-scoped path with no ownership policy mounted. `commands.ts` keeps 100% statement, branch, function, and line coverage under the Session Controller suite.
