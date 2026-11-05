---
description: "持久智能体例程的模型工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-routine

[English](README.md) | 中文

## 概述

在 agent-routine 之上注册 routine_create、routine_update、routine_list、routine_test 和 routine_no_update。

## 目录
- [开发备注](#dev-note)

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

与 tools 和 agentRoutines 并列加载，并确保 agentRoutineBridge 可用。桥接把 exec.agent.id（实时会话 id）解析为拥有这些例程的持久智能体。模型参数无法选择其他智能体的例程。手动测试在暂停状态下也能运行，且不会启用日历，也不会移动其下一次触发时间。

<a id="model-experience"></a>
## 模型体验

### 例程管理与结果

#### 模型看到什么

生成的工具 schema，以及包含例程 id、状态和执行历史的紧凑 JSON 结果。创建或测试返回的是准入结果，而不是已完成的报告。`routine_no_update` 仅在例程执行内部有效，它会抑制该次报告，同时保留历史。脚本载荷仍是外部数据，不能取代已注册的指令。

#### Token 影响

固定的工具 schema 成本，加上每次调用一条结果。routine_test 会准入一个单独的执行回合；列出和编辑定义不调用模型提供方。

#### KV Cache 影响

工具定义在启用期间保持前缀稳定。工具调用及结果追加到调用方的历史中；被准入的例程工作使用拥有自己前缀的新会话。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 暂停无法撤销已准入运行的外部影响。
- 移除例程会明确删除其执行历史。
- 工具依赖桥接和服务处理所有权与调度；它们不增加用户级授权，也不提供自动的提供方回退。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
