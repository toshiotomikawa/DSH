---
description: "通过受管的原生 CLI 进程进行一次性 Antigravity 委派。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-agy

[English](README.md) | 中文

## 概述

把一项文本任务委派给已安装的 Antigravity CLI。这个可选组合包注册 `subagent_agy`，启动全新的原生 CLI 进程，并且只暴露其最终响应。原生认证仍由 agy 负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

把 `cordis.patch.yml` 作为可选的配置层加载，并显式设置 `DSH_HOME`。在 Windows 上，把 `command` 设为原生的 `agy.exe`，避免使用 `.cmd` 包装层。每个模型都是由 `model` 和 `providerName` 配置的独立提供方实例。

配置与生命周期设置与 [subagent-grok](../subagent-grok/README.zh.md#use-this-package) 共用：命令、前缀参数、环境变量、期限、进程释放宽限期、输出上限、私有审计目录以及可选的额度状态文件。权限默认为 `reject`：适配器选择原生的计划模式，绝不传递 `--dangerously-skip-permissions`。只有显式的 `allow` 才会传递该标志。斜杠命令和技能展开在 print 模式下被禁用。

<a id="understand-the-implementation"></a>
## 理解实现

`index.ts` 读取 NDJSON，并要求恰好有一个终结 `result` 事件。中间的步骤和工具事件绝不会成为父级的输出。格式错误的 JSON、重复或缺失的终结结果都会安全地失败。`SUCCESS` 返回 `response`；已知的拒绝和长度状态映射到现有的 subagent 停止原因。其他原生失败和额度限制返回固定的诊断信息。受管的生命周期、有界审计、期限以及整个进程范围的清理，复用 Grok 的内部实现。

<a id="dev-note"></a>
## 开发备注

同时运行 Grok 和 agy 的测试目录，以覆盖两个解析器和共享的生命周期。录制的 agy fixture（测试前置数据）已精简为事件形态，不含任何账户、会话或工作区标识。

<a id="model-experience"></a>
## 模型体验

间接通过 `dsh-tool-subagent` 实现，它负责 `subagent_agy` 的 schema 和结果渲染；本提供方不增加会话继承、续接、按调用覆盖模型或结构化输出，只返回最终的助手文本或安全的失败。

#### KV Cache 影响

没有直接的失效；本提供方自身不贡献任何请求内容，因此其生命周期除了 subagent 工具已记录的 schema 和结果追加之外，不会改变可复用的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 原生计划模式约束工作，但不能替代宿主沙箱。
- 等待原生权限的 CLI 受配置的期限约束；不会向用户转发任何提示。
- 审计文件可能包含工作区内容，需要私有存储和保留策略。
- 原生协议变化时需要更新 fixture。
- 不提供自动重试、付费回退、额度采集，也不会激活默认配置。
