---
description: "Shared relational tables for agents behind ctx.tables."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-tables

## Summary

Provides `ctx.tables`, one SQLite database shared by every agent of the deployment. The synchronous engine owns the table catalog, single-statement SQL admission through the SQLite authorizer, atomic writes, page and size ceilings, automatic row columns (`criado_em`, `atualizado_em`, `revisao`, `autor`) and an in-memory audit ring.

## Use this package

Mount it with a `path` or `dshHome`; the default database is `<dshHome>/data/tables-shared.sqlite`. `maxDbBytes`, `maxValueBytes`, `commandTimeoutMs` and `busyTimeoutMs` bound the file, one value, one command and SQLite lock waits. Each command runs in a hidden SQL child process; a deadline or caller abort kills that process and a fresh one serves the next call. The model-facing tools live in `@deepseek-ai/dsh-tool-tables`; this package registers no tool or prompt itself.

## Model Experience

None, as this service registers no tool, prompt section or other model-facing content; the model reaches it only through the tools of `@deepseek-ai/dsh-tool-tables`.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected; tool calls and results append through the tool package.

## Known Limitations and Deferred Work

- One database per deployment; per-owner isolation and `tables-<ownerId>.sqlite` files are deferred to the multi-user milestone.
- The audit ring is in memory and bounded to the latest 200 records; it is not a durable audit log.
- A command that exceeds the deadline is rolled back by killing the child, so a long native SQLite step cannot be interrupted more gently.
- Table creation is only available through `table_create`; free-form DDL is rejected.
- `ownerId` on tables is stored without access filtering until the multi-user milestone.
