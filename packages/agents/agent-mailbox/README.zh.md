---
description: "根在不同会话中的持久智能体之间的持久消息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mailbox

[English](README.md) | 中文

## 概述

存储根会话不同的持久智能体之间的持久消息和按收件方的投递记录。发送方始终是经过认证的实时智能体；身份层提供可见目标、稳定 id 和中断权限。

## 目录
- [开发备注](#dev-note)

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

与 `storage-domain`、`agents` 和 `session-persistence` 并列加载，并由持久智能体集成提供 `agentDirectory` 实现。目录把稳定 id 解析为会话，决定可见性和中断权限，并为 `newThread` 创建全新会话。投递通过 `ctx.agents` 打开或恢复目标会话，并通过 `followup` 排入一个回合；忙碌的目标会把消息保留到它的下一个回合，该回合结束后队列继续。目录上可选的 `reaches(fromId, toId)` 会在尝试待处理的投递以及写入回复时再次被询问；权限被撤回后，投递以 `refused` 结束，并附带一个不提及任何账户的中性原因，回复则沿用开启该会话的智能体的权限。已经收到消息的回合会保留该消息。配套的 `@deepseek-ai/dsh-tool-agent-mailbox` 提供 `agent_send_message`、`agent_list` 和 `agent_interrupt`。

消息、投递状态和经过哈希的 `idempotencyKey` 保存在同一条消息记录中，因此键与消息不会出现分歧。重复的键返回之前的消息；文本、收件方集合、线程标志、标题或目的地不同则视为冲突。回复只接受来自原消息收件方的一次，并返回到发出原消息的会话。重启时，若某次投递记录的回合在其会话日志中没有 `turn/end`，该投递变为 `uncertain` 且不会重发；从未开始的投递则回到 `queued`。

新消息和回复会记录经过认证的发送配置的所有者，旧配置默认为 `owner`。持久智能体目录在校验收件方之前，把发现和中断限制在调用方的所有者范围内。

<a id="model-experience"></a>
## 模型体验

### 已投递的邮箱消息

#### 模型看到什么

每次被接受的投递都会成为目标会话中的一条用户消息。它带有 `agent-mailbox` 来源，写明邮箱消息 id、发送方名称和稳定 id，声明文本是协作方内容而非权威，并在期望回复时包含 `reply_to_message_id` 指引。消息正文上限为 64 KiB。

#### Token 影响

每次投递追加一条用户消息，每次发送对每个收件方最多一条。回复指引增加一个固定行；仅供告知的消息则省略它。

#### KV Cache 影响

投递追加在目标会话已有历史之后，不会替换更早的 token。发送消息不会改变发送方自己的请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 投递仅在进程内进行，并通过同一个泵串行化；重启会重试已排队的投递，崩溃时回合仍处于打开状态的投递会被标记为 `uncertain` 而不是重发，因此外部工作绝不会被盲目重复。
- 所有者元数据继承自发送配置。账户认证和显式共享授权延期实现。
- 中断是请求目标的 agent loop（智能体循环）取消其当前回合；它无法撤销已经执行的外部影响。
- 新会话使用身份层提供的路由；没有路由的目标，只有在其会话已记录选择时才能被唤醒。
- 不提供邮件、聊天或其他外部渠道的投递：本包只承载智能体之间的消息。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
