---
description: "面向模型、基于共享关系表的工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-tables

[English](README.md) | 中文

## 概述

注册八个表工具：`table_create`、`table_list`、`table_schema`、`table_alter`、`table_drop`、`data_query`、`data_execute` 和 `data_batch`。每次调用都以经过认证的会话所有者身份运行：私有表保存在该账户的文件中，共享表位于 `tables-shared.sqlite`，每一行都记录其作者（`autor`）和可用于比较并设置更新的 `revisao` 计数器。

## 使用本包

与 `tools` 以及来自 [`@deepseek-ai/dsh-storage-tables`](../storage-tables/README.zh.md) 的 `ctx.tables` 服务并列加载。工具负责准入和渲染；服务负责数据库文件、期限和上限。`data_query` 接受一条 SELECT，默认每页 200 行；`data_execute` 和 `data_batch` 接受单条 INSERT、UPDATE 或 DELETE 语句，参数单独绑定，绝不拼入 SQL。`escopo` 选择 `privada`（账户自己的文件，账户默认值）或 `compartilhada`；`table_list`、`table_schema`、`table_alter` 和 `table_drop` 能看到调用方可打开的两个文件。

## 模型体验

### 表工具的 schema 与结果

#### 模型看到什么

生成的 [`table_create`、`table_list`、`table_schema`、`table_alter`、`table_drop`、`data_query`、`data_execute` 和 `data_batch` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-tables)。描述中说明：`table_drop` 不可逆且需要 `confirmar`；`data_query` 只读且上限为 1000 行；`escopo` 选择私有文件还是共享文件；参数必须绑定而不是插值。结果是紧凑的 JSON：表摘要或 schema、受影响的行数以及插入的行 id。

#### Token 影响

固定的 schema 成本，加上每次调用一条紧凑的 JSON 结果。查询最多返回所请求的一页（默认 200，上限 1000）；没有自动的上下文贡献。

#### KV Cache 影响

只要定义和可见性不变，schema 的前缀就保持稳定。调用及结果追加在可复用的请求前缀之后；读取表不会改变模型可见的 schema。

## 已知限制与延期工作

- 共享文件对每个账户可见；按表的授权列表尚未实现，且一次 SQL 调用只在单个文件内联接。
- `data_query` 没有游标；模型用自己的 `WHERE` 和 `LIMIT` 分页，被截断的结果会明确说明。
- 自由形式的 DDL 会被拒绝：表只能通过专用工具创建和修改。
- 被删除的表无法通过这些工具恢复。
- 结果受数据库和值上限约束；超过配置上限的值会被拒绝，而不是被截断。
