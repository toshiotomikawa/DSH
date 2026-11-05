---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-04-fork-account-mailbox-attribution

[English](2026-11-04-fork-account-mailbox-attribution.md) | 中文

## 概述

确认分支在四个现有会话事件类型中新增的账户调用者归属和 agent-mailbox 消息来源。不改变写入版本、解码器、验证器或授权策略。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-04-fork-account-mailbox-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "59248499595135b76272553b443d5357e8001ad3046f18333f0ac6fc4bc739cf"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "9e99b4300ec5861e515350cd02b87f569bfb286216ac81dbb89d1f5225ced219"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "023f46f8d3d9469965c9a530c1085f8a714278d6af449934c481b7d6daddebf2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "d5c6d65577468bacc0386d5d828a8b7d81ee34e1652739448bd0e85689783346"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

收件箱 inserted 中的 user 来源、developer 消息中的 user 来源以及 user/message 来源，仍保留历史 kind=user 形式、rpcId 以及缺省或既有 principal。可选 principal 现在也接受带 ownerId 的 kind=account；缺省含义不变。同样的三个来源联合类型还接受 agent-mailbox 转发元数据。当前 JSONL 读写打开操作在未安装账户或邮箱插件时，仍完整保留旧、新来源 JSON 和内容。来源元数据既不认证连接，也不授予会话所有权。已发布 V4 的来源遍历、记录封装、生命周期检查和会话消息派生代码，与 邮箱新增之前的分支逐字节相同；旧读取器保留不熟悉的生产者元数据，而不赋予权限。因此双向读取都保留输入内容和既有身份，无需提升版本。

session/title-llm-request 的 messages 类型继承扩展后的 Message 联合类型，但既有生命周期约束更严格：必须是一个规范的 dsh-session-title-llm 用户消息，并引用之前的人类 user/message。生产者仍只写入该形式。历史规范请求，包括引用新账户归属输入的请求，继续可读。若把标题请求本身的来源换成账户或邮箱，读写打开操作会在暴露句柄之前拒绝，原始字节保持不变且不发生恢复截断。这是旧读取器既有行为，并非新允许的标题表示。没有修改历史格式或已定稿确认记录。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/fork-source-compatibility.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/session/session-persistence-jsonl/tests/native-developer-admission.spec.ts packages/session/session-title-llm/tests：四个文件中的 113 个测试通过。新增 28 项矩阵覆盖七条路径、普通和 zstd 代际文件、读写访问；检查已发布编解码器的保留行为、当前持久化、会话恢复和输入派生、字节保留、缺省/owner/account principal、邮箱转发 JSON 以及非规范标题来源的拒绝。Git 对象比较确认所检查的 V4/V2 读取器文件、JSONL 封装及会话核心和派生文件在邮箱新增之前的分支与任务基线之间未改变。不调用供应商、不登录，也不使用用户主目录。

<a id="dev-note"></a>
## 开发备注

无。
