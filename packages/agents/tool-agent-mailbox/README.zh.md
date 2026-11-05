---
description: "用于向持久智能体发消息、与其他账户共享智能体并按分区分组的模型工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-mailbox

[English](README.md) | 中文

## 概述

在持久的 `agent-mailbox` 服务之上注册 `agent_send_message`、`agent_list` 和 `agent_interrupt`，另有 `agent_grant_access`、`agent_revoke_access`、`agent_list_grants`、`agent_list_sections` 和 `agent_move_section`，用于在账户之间共享智能体并对其分组。工具名带有 `agent_` 前缀，因此不会与 subagent 树的控制工具冲突。

## 目录
- [开发备注](#dev-note)

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

加载到需要让调用方持久智能体看到邮箱工具的位置，与 `tools` 和 `agentMailbox` 并列。[`agent-mailbox`](../agent-mailbox/README.zh.md) 包负责持久化、投递、可见性和权限；这些工具自身不增加任何权限。调用方的账户始终来自其持久智能体，而不是来自参数：只有该账户可以授予或撤销对其智能体的访问，属于其他账户的智能体、分区或授权，其应答与不存在时完全相同。授权是单向的，只有在挂载了所有者策略的 `accountGrants` 服务时才生效；撤销会在下一次调用时切断访问，同时也会以中性原因拒绝任何会跨越该账户的未投递消息或回复；已经收到消息的回合会保留该消息。回复用 `reply_to_message_id` 指明原消息；新线程只接受一个收件方。

<a id="model-experience"></a>
## 模型体验

### 邮箱工具的 schema 与结果

#### 模型看到什么

生成的 [`agent_send_message`、`agent_list` 和 `agent_interrupt` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-agent-mailbox)。发送结果是每个收件方一份紧凑的接受回执；投递发生在回执之后。`agent_list` 返回可见的智能体及其执行状态、队列、当前正在工作的会话、不确定性标志和未完成的回复请求。`agent_interrupt` 报告是否已请求运行中的回合停止；不带会话 id 时，它中断唯一运行中的回合，若有多个在运行则要求提供 id。描述中说明消息文本是协作方内容，绝不是权威。

#### Token 影响

固定的 schema 成本，加上每次调用一条紧凑的 JSON 结果。一次发送会向目标会话追加一条用户消息；除工具结果之外，不会向发送方的 transcript（文本记录）添加任何内容。

#### KV Cache 影响

只要定义和可见性不变，schema 的前缀就保持稳定。调用及结果追加在可复用的请求前缀之后；投递追加在目标会话的前缀之后。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 中断是协作式的，无法撤销目标已经执行的外部影响。
- `agent_list` 是快照而不是预留；另一个发送方可能在读取之后立即填满目标队列。
- 投递失败表现为带原因的排队状态；崩溃时回合仍处于打开状态则表现为 `uncertain`，且不会自动重试。没有单独的重试工具。
- 只有当身份层实现了 `thread` 时才能使用线程；工具本身不创建会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
