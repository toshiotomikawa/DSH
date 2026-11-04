---
description: "Shared relational tables for agents behind ctx.tables."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-tables

## Summary

Provides `ctx.tables`, one SQLite database file per scope: `tables-shared.sqlite` for the deployment and `tables-<ownerId>.sqlite` for each authenticated account. The synchronous engine owns the table catalog, single-statement SQL admission through the SQLite authorizer, atomic writes, page and size ceilings, automatic row columns (`criado_em`, `atualizado_em`, `revisao`, `autor`) and an in-memory audit ring.

## Use this package

Mount it with a `path` or `dshHome`; the default shared database is `<dshHome>/data/tables-shared.sqlite`, and each account file sits beside it. A call names its required `scope` (`privada` or `compartilhada`) and optional `ownerId`; the service opens only the shared file and that owner's file, routes the call to one of them, and never creates or reads another account's file. `maxDbBytes`, `maxValueBytes`, `commandTimeoutMs` and `busyTimeoutMs` bound each file, one value, one command and SQLite lock waits. Each command runs in a hidden SQL child process; a deadline or caller abort kills that process and a fresh one serves the next call. The model-facing tools live in `@deepseek-ai/dsh-tool-tables`; this package registers no tool or prompt itself.

## Model Experience

None, as this service registers no tool, prompt section or other model-facing content; the model reaches it only through the tools of `@deepseek-ai/dsh-tool-tables`.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected; tool calls and results append through the tool package.

## Known Limitations and Deferred Work

- The shared file is visible to every authenticated account; per-table grant lists from spec 04 are not implemented yet.
- The audit ring is in memory and bounded to the latest 200 records; it is not a durable audit log.
- A command that exceeds the deadline is rolled back by killing the child, so a long native SQLite step cannot be interrupted more gently.
- Table creation is only available through `table_create`; free-form DDL is rejected.
- A SQL call runs against one scope, chosen by the `escopo` argument; it does not join the shared and private files in one statement.
