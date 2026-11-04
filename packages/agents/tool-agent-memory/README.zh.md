---
description: "为调用方智能体记住、忘记和搜索数据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-memory

[English](README.md) | 中文

## 概述

为调用方智能体记住、忘记和搜索数据。

## 使用本包

在全局范围内加载注册表和记忆服务，与 `storage-domain`、`llm`、`sessions` 和 `agents` 并列。在需要提供记忆工具的位置加载工具插件。使用记忆工具之前，先把会话绑定到持久配置。可选的 `@deepseek-ai/dsh-tool-agent-memory/preset` 行接受 `agentId`，应放在 agent（智能体）预设内；其 persona 会覆盖部署前缀。配置与事务语义见[持久智能体](../../../docs/subsystems/persistent-agents.zh.md)。

## 模型体验

### 持久身份与记忆

#### 模型看到什么

四个工具的 schema 见[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-agent-memory)。预设先原样提供配置指令，再提供被明确标记为不可信数据的必要记忆。

#### Token 影响

不增加模型请求。必要记忆上下文受 `essentialBytes` 限制，包括其警告和序列化的 id。搜索最多返回所请求的结果数，并受每条记忆配置大小的约束。

#### KV Cache 影响

配置和必要记忆的选择不变时，提示词前缀保持稳定。配置或必要记忆发生变化，会改变之后的提示词组装，并可能使前缀复用失效。

## 已知限制与延期工作

- 不提供自动模型回退、提供方账户切换、权限提升、邮箱或例程执行。
- 可选的 ownerId 字段只被保存，在 M7 之前不做访问过滤。
- 协调仅在进程内进行，与 storage-domain 一致。
- 会话的 agentId 元数据保存在 agents 域中，而不是修改上游会话头。
- 记忆提交在 turn/end 完成后才被观察到；工具只报告暂存，下一次智能体提示词会等待已接纳的提交。
- 失败的提交会被记录日志，并在重试前向受影响的会话报告一次。
