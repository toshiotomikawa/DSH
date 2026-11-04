---
description: "Model-facing tools over the shared relational tables."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-tables

English | [中文](README.zh.md)

## Summary

Registers the eight table tools: `table_create`, `table_list`, `table_schema`, `table_alter`, `table_drop`, `data_query`, `data_execute` and `data_batch`. Each call runs as the authenticated session owner: private tables stay in that account's file, shared tables are in `tables-shared.sqlite`, and each row records its author (`autor`) and a `revisao` counter usable for compare-and-set updates.

## Use this package

Mount beside `tools` and the `ctx.tables` service from [`@deepseek-ai/dsh-storage-tables`](../storage-tables/README.md). The tools own admission and rendering; the service owns the database files, deadlines and ceilings. `data_query` accepts one SELECT and pages at 200 rows by default; `data_execute` and `data_batch` accept single INSERT, UPDATE or DELETE statements with parameters bound separately, never pasted into the SQL. `escopo` selects `privada` (the account's own file, the account default) or `compartilhada`; `table_list`, `table_schema`, `table_alter` and `table_drop` see both files the caller may open.

## Model Experience

### Table tool schemas and results

#### What the model sees

The generated [`table_create`, `table_list`, `table_schema`, `table_alter`, `table_drop`, `data_query`, `data_execute` and `data_batch` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-tables). The descriptions state that `table_drop` is irreversible and needs `confirmar`, that `data_query` is read-only and capped at 1000 rows, that `escopo` chooses the private or shared file, and that parameters must be bound rather than interpolated. Results are compact JSON: table summaries or schemas, affected-row counts and the inserted row id.

#### Token effect

Fixed schema cost plus one compact JSON result per call. A query returns at most the requested page (default 200, ceiling 1000); there is no automatic context contribution.

#### KV Cache effect

Schemas are prefix-stable while their definitions and visibility are unchanged. Calls and results append after the reusable request prefix; reading a table does not change the model-visible schema.

## Known Limitations and Deferred Work

- The shared file is visible to every account; per-table grant lists are not implemented yet, and a SQL call joins only within one file.
- `data_query` has no cursor; the model pages with its own `WHERE` and `LIMIT`, and a truncated result says so.
- Free-form DDL is refused: tables are created and altered only through the dedicated tools.
- A dropped table is not recoverable through the tools.
- Results are capped by the database and value ceilings; a value above the configured limit is rejected rather than truncated.
