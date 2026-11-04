---
description: "位于 ctx.tables 之后、供智能体使用的共享关系表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-tables

[English](README.md) | 中文

## 概述

提供 `ctx.tables`，每个作用域对应一个 SQLite 数据库文件：部署共用 `tables-shared.sqlite`，每个经过认证的账户使用 `tables-<ownerId>.sqlite`。同步引擎负责表目录、通过 SQLite 授权器实现的单语句 SQL 准入、原子写入、分页与大小上限、自动的行列（`criado_em`、`atualizado_em`、`revisao`、`autor`）以及内存中的审计环。

## 使用本包

通过 `path` 或 `dshHome` 加载；默认的共享数据库是 `<dshHome>/data/tables-shared.sqlite`，每个账户的文件与它并列。调用需指明必填的 `scope`（`privada` 或 `compartilhada`）和可选的 `ownerId`；服务只打开共享文件和该所有者的文件，把调用路由到其中之一，绝不创建或读取其他账户的文件。`maxDbBytes`、`maxValueBytes`、`commandTimeoutMs` 和 `busyTimeoutMs` 分别限制每个文件、单个值、单条命令以及 SQLite 的锁等待。每条命令都在隐藏的 SQL 子进程中运行；超过期限或调用方中止会终止该进程，下一次调用由新的子进程服务。面向模型的工具位于 `@deepseek-ai/dsh-tool-tables`；本包自身不注册任何工具或提示词。

## 模型体验

无，因为本服务不注册任何工具、提示词分节或其他面向模型的内容；模型只能通过 `@deepseek-ai/dsh-tool-tables` 的工具访问它。

#### KV Cache 影响

这里没有任何内容进入模型请求，因此提供方的缓存复用不受影响；工具调用及结果通过工具包追加。

## 已知限制与延期工作

- 共享文件对每个经过认证的账户可见；规范 04 中按表的授权列表尚未实现。
- 审计环保存在内存中，仅限最近 200 条记录；它不是持久的审计日志。
- 超过期限的命令通过终止子进程来回滚，因此较长的原生 SQLite 步骤无法被更温和地中断。
- 创建表只能通过 `table_create`；自由形式的 DDL 会被拒绝。
- 一次 SQL 调用针对由 `escopo` 参数选择的单个作用域运行；它不会在一条语句中联接共享文件和私有文件。
