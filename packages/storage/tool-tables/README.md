---
description: "Model-facing tools over the shared relational tables."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-tables

## Summary

Registers the eight shared-table tools: `table_create`, `table_list`, `table_schema`, `table_alter`, `table_drop`, `data_query`, `data_execute` and `data_batch`. Every agent of the server sees the same tables, and each row records its author (`autor`) and a `revisao` counter usable for compare-and-set updates.

## Use this package

Mount beside `tools` and the `ctx.tables` service from [`@deepseek-ai/dsh-storage-tables`](../storage-tables/README.md). The tools own admission and rendering; the service owns the database, deadlines and ceilings. `data_query` accepts one SELECT and pages at 200 rows by default; `data_execute` and `data_batch` accept single INSERT, UPDATE or DELETE statements with parameters bound separately, never pasted into the SQL.

## Model Experience

### Shared-table tool schemas and results

#### What the model sees

The generated [`table_create`, `table_list`, `table_schema`, `table_alter`, `table_drop`, `data_query`, `data_execute` and `data_batch` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-tables). The descriptions state that `table_drop` is irreversible and needs `confirmar`, that `data_query` is read-only and capped at 1000 rows, and that parameters must be bound rather than interpolated. Results are compact JSON: table summaries or schemas, affected-row counts and the inserted row id.

#### Token effect

Fixed schema cost plus one compact JSON result per call. A query returns at most the requested page (default 200, ceiling 1000); there is no automatic context contribution.

#### KV Cache effect

Schemas are prefix-stable while their definitions and visibility are unchanged. Calls and results append after the reusable request prefix; reading a table does not change the model-visible schema.

## Known Limitations and Deferred Work

- The shared database has no per-owner isolation until the multi-user milestone; every agent sees every table.
- `data_query` has no cursor; the model pages with its own `WHERE` and `LIMIT`, and a truncated result says so.
- Free-form DDL is refused: tables are created and altered only through the dedicated tools.
- A dropped table is not recoverable through the tools.
- Results are capped by the database and value ceilings; a value above the configured limit is rejected rather than truncated.
