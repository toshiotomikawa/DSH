---
description: "解析持久智能体的显式账户配置目录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-external-runtime

[English](README.md) | 中文

## 概述

解析持久智能体的显式账户配置目录。

## 使用方式

在持久智能体注册表、账户和会话所有者策略之后挂载此可选 Host 插件。`bindings` 配置包含 `accountId`、`runtime`（`claude-sdk` 或 `codex-sdk`）、绝对目录 `configDirectory` 和正整数 `revision`。空配置不授予任何工具运行时访问权限，包括旧版 `owner`。绑定属于部署配置，不能由模型工具指定。修改绑定或工具登录后，应提高版本号并重新加载。

`harnessBindings.resolve(sessionId, workspace)` 从持久会话元数据解析档案，并要求其所有者与会话侧存储一致。命名账户必须仍处于活动状态。本地现存目录经规范化处理，但不会列出内容；同一账户与运行时的重复配置，以及不同所有者之间重叠的实际目录，会在服务发布前被拒绝。工作区不能与任何已配置的工具目录重叠。返回值是独立的私有 Host 数据，不得返回给工具、写入日志或放入提示词。规范目录的符号链接被重定向时，操作以 `binding_stale` 失败。

预期失败通过 `HarnessBindingError.code` 标识，不暴露文件系统路径或底层原因。配置错误阻止服务发布；激活错误不会修改绑定。修正 Host 配置或身份后，需显式重试。卸载会移除服务。

身份与所有权语义见[持久智能体](../../../docs/subsystems/persistent-agents.zh.md)。

## 模型体验

### 账户工具配置

#### 模型看到的内容

没有工具或提示词。`harnessBindings` 仅供可信 Host 消费者使用。

#### Token 影响

没有模型请求或 token 消耗。

#### KV 缓存影响

不改变模型输入或前缀复用。

## 已知限制和后续工作

- 此插件通过持久激活端口发布外部 Agent。随附驱动是假 SDK，只记录 Session 回合，从不调用原生 API 模型。
- 目录分离不是操作系统隔离，也不证明供应商的登录身份。登录由官方工具负责，位于此插件之外。
- MCP 权限、官方 SDK 适配器、回退和档案界面仍是后续阶段。缺少此插件时激活失败，而不会退回原生 API。
- Claude 使用官方 Agent SDK；Codex 通过现有受管理进程路径使用官方 app-server。本插件不会导入或启动它们。
