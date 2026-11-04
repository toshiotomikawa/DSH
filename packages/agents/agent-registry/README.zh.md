---
description: "存储具名配置，并将会话绑定到稳定的智能体标识。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-registry

[English](README.md) | 中文

## 概述

存储具名配置，并将会话绑定到稳定的智能体标识。

## 使用本包

在全局范围内加载注册表和记忆服务，与 `storage-domain`、`llm`、`sessions` 和 `agents` 并列。在需要提供记忆工具的位置加载工具插件。使用记忆工具之前，先把会话绑定到持久配置。可选的 `@deepseek-ai/dsh-tool-agent-memory/preset` 行接受 `agentId`，应放在 agent（智能体）预设内；其 persona 会覆盖部署前缀。配置与事务语义见[持久智能体](../../../docs/subsystems/persistent-agents.zh.md)。

新配置把 Remote 连接的账户记为 `ownerId`；受信任的本地创建默认为 `owner`。Remote 账户只能列出、读取和编辑自己的配置，模型提供的所有权无法替换连接身份。没有所有者的既有记录保留单账户含义。会话绑定把配置的所有者复制到可选的会话所有权伴随文件中；编辑配置无法转移所有权。

侧栏分区是由单个账户拥有的扁平分组：`listSections`、`createSection(name)`、`renameSection(id, name)`、`deleteSection(id)` 和 `assignSection(agentId, sectionId | null)`。配置保存 `sectionId`；移动或取消分组只改变该字段，绝不改变配置 id、历史、记忆或例程。删除分区时先取消其成员的分组，再移除该分组。名称长度为 1 到 40 个字符；未知或属于其他账户的分区 id 会以相同的 `Unknown section` 错误失败，分区绝不授予对其他账户的访问权。渲染这些分组的侧栏界面尚不属于本包。

档案缺省的 `runtime` 解析为 `native`。`claude-sdk` 和 `codex-sdk` 使用独立的可选 `runtimeModel`；原生模式保留但不使用该字段。外部档案不验证未使用的主 API 路由，但仍验证所有保存的备用路由，自动回退仍须显式同意。`selection()` 在 API 激活前拒绝外部档案；切换运行时不会隐式选择 API。可选的[外部运行时配置](../agent-external-runtime/README.zh.md)负责解析私有账户工具目录。

## 模型体验

### 持久身份与记忆

#### 模型看到什么

本服务自身不贡献任何文本。可选的持久智能体预设行会为所选智能体读取配置指令和必要记忆。

#### Token 影响

不增加模型请求。必要记忆上下文受 `essentialBytes` 限制，包括其警告和序列化的 id。搜索最多返回所请求的结果数，并受每条记忆配置大小的约束。

#### KV Cache 影响

配置和必要记忆的选择不变时，提示词前缀保持稳定。配置或必要记忆发生变化，会改变之后的提示词组装，并可能使前缀复用失效。

## 已知限制与延期工作

- 不提供自动模型回退、提供方账户切换、权限提升、邮箱或例程执行。
- 账户过滤遵循 Remote 连接的主体；Remote 调用之外的受信任宿主代码保留管理权限。
- 账户创建、认证和共享延期实现。
- 协调仅在进程内进行，与 storage-domain 一致。
- 会话的 agentId 元数据保存在 agents 域中，而不是修改上游会话头。
- 记忆提交在 turn/end 完成后才被观察到；工具只报告暂存，下一次智能体提示词会等待已接纳的提交。
- 失败的提交会被记录日志，并在重试前向受影响的会话报告一次。
