# Agent Note: Account entry through ephemeral browser sessions

Status: implemented

English | [中文](2026-11-04-browser-account-entry.zh.md)

## Problem

A browser cannot attach the existing account bearer header during ordinary navigation. Reusing the Host owner cookie would let an account enter with unrestricted owner authority, while retaining its long-lived entry token in browser storage would unnecessarily expose that token.

## Decision

The account-owned plugin exchanges the entry token for a separate, in-memory session credential and registers its principal source with Connection. Server-rendered forms keep the credential out of client plugins and model tools. The [account runtime README](../../../../packages/agents/agent-runtime/README.md#browser-account-entry) owns the routes, limits and revocation behavior.

A principal source can explicitly reject a credential with null. Abstention and rejection differ because the owner cookie is a separate authority: an invalid account session must not fall through to it. Index authorization uses the same source and trust fence as API admission, and frontend-static renders the admitted Peer. This extends the [browser trust decision](2026-07-28-api-browser-trust-boundary.md) without changing its Host/Origin rules or owner launch-token exchange.

## Alternatives considered

**Retain the account entry token in browser storage.** Rejected because a separate revocable session credential provides navigation authentication without repeatedly exposing the long-lived entry token.

**Invoke grants through a model tool and a synthetic agent session.** Rejected because a browser account is already authenticated and grants are owned by AccountGrants; creating an agent only to reach that same domain adds a false caller and a transcript.

## Consequences

Restart or plugin unload requires another login. The account plugin owns credential lifetime while Connection owns Peers; session revocation closes the shared account Peer, so other browser sessions of that account reconnect. Forms require the receiving listener's same-origin POST, and the initial pages use root-relative routes. HTTP/Loader integration tests cover identity projection, outgoing grants, revocation, hostile form input, credential rejection, expiry, unload and native TLS cookies without opening a browser or calling a provider.
