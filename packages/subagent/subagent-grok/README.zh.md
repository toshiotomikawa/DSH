---
description: "通过受管的原生 CLI 进程进行一次性 Grok Build 委派。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-grok

[English](README.md) | 中文

## 概述

把一项文本任务委派给已安装的 Grok Build CLI。这个可选组合包注册 `subagent_grok`。每次调用都会在调用方的工作区中启动全新的进程，并且只返回最终的助手文本。原生认证仍由 Grok 负责。

<a id="use-this-package"></a>
## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

把 `cordis.patch.yml` 作为可选的配置层加载。显式设置 `DSH_HOME`；组合包会把审计产物写在该目录之下。在 Windows 上，用原生可执行文件的路径配置 `command`，而不是 `.cmd` 垫片。共享的子进程提供方负责 `windowsHide`、凭据清除以及整个进程范围的终止。不会使用 shell 展开提示词。

部署方负责 `providerName`、`command`、`args`（前缀参数）、`model`、`permission`、`env`、`timeoutMs`（120000）、`disposeGraceMs`（3000）、`maxOutputBytes`（4194304）、`logDirectory`（必填的绝对路径）、`quotaFile`（可选）和 `minimumRemainingPercent`（10）。多个模型使用各自独立的具名实例。`permission` 默认为 `reject`（`dontAsk`）；只有显式的 `allow` 才会选择 `bypassPermissions`。内置的网页搜索和嵌套 subagent 被禁用。

`quotaFile` 是形如 `{ "remainingPercent": 75 }` 的 JSON 文件。低于下限的值会在启动前拒绝；无效或不可读的文件按失败关闭处理。没有检查器时，插件会发出警告并继续。`quotaStatus` 向宿主消费方暴露该文件的读取器；提供方的偏好由调用方决定。没有自动重试，也没有付费回退。

<a id="understand-the-implementation"></a>
## 理解实现

`index.ts` 负责 Grok 的整体结果 JSON 协议。`headless.ts` 负责本插件与 `subagent-agy` 共用的受管生命周期；共享可以避免重复 150 多行代码，同时不必引入另一个包。每个子进程都有期限和输出上限。收集到的 stdout/stderr 保存在每次运行专属的私有日志中，绝不追加到父级会话。日志可能包含工作区或工具内容：请使用私有目录并在那里管理保留。上限同样约束审计产物；截断会被记录，绝不会被报告为成功。

原生的 `end_turn` 映射为 `completed`，拒绝映射为 `refusal`，长度限制映射为 `max-tokens`，取消映射为 `aborted`。其他失败使用现有的 `error` 停止原因，并附带固定的诊断信息，包括 `cota_baixa`、`cota_esgotada` 或 `tempo_esgotado`。原始 stderr、环境变量值和异常消息绝不会进入诊断信息。非零退出不可能成功完成。dispose（资源释放）是幂等的，并会等待受管范围退出；无法观察到的清理失败会使释放被拒绝，并警告进程状态未知。任务启动之后失败，绝不构成自动重试的许可。

<a id="dev-note"></a>
## 开发备注

运行 `node node_modules/vitest/vitest.mjs run packages/subagent/subagent-grok packages/subagent/subagent-agy`。fixture（测试前置数据）不需要凭据或网络。测试包含真实且无害的 Node 子进程，用于验证密钥清除和期限清理。真实的提供方调用为手动执行，并单独限制。

<a id="model-experience"></a>
## 模型体验

间接通过 `dsh-tool-subagent` 实现，它负责 `subagent_grok` 的 schema 和结果渲染；本提供方不增加会话继承、续接、按调用覆盖模型或结构化输出，只返回最终的助手文本或安全的失败。

#### KV Cache 影响

没有直接的失效；本提供方自身不贡献任何请求内容，因此其生命周期除了 subagent 工具已记录的 schema 和结果追加之外，不会改变可复用的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 不提供续接、后续消息、模型发现、交互式批准或自动额度采集。
- 额度的新鲜度由写入方负责，CLI 版本必须与记录的 JSON 约定一致。
- 流式工具流量保留在有界的本地审计产物中。
- 原生账户和配置可能影响工具；本集成不增加沙箱。
- 该组合包是可选的，不会在默认配置中启用。
