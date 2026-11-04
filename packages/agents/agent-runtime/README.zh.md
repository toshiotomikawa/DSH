---
description: "将持久智能体身份连接到邮箱和例程会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-runtime

[English](README.md) | 中文

## 概述

将持久智能体身份连接到邮箱和例程会话。

## 使用本包

在 agent-registry、agent-memory、agents 和 system-prompt 之后全局加载，并在 agent-mailbox 和 agent-routine 之前加载。它提供 `agentDirectory` 和 `agentRoutineBridge`。邮箱会话先持久绑定身份，再创建或恢复；已绑定的会话会获得身份 persona 和必要记忆。每次例程执行都会创建一个全新会话，并在其回合结算之前返回准入结果。

可选的 `@deepseek-ai/dsh-agent-runtime/owners` 插件在 `remote-access` 中挂载账户策略。把它的 `fork-owner-policy` 条目加入已挂载持久存储和会话控制器的 Web 组合；随附的 Web 组合包默认开启它。它把可选的 `ownerId` 元数据保存在按记录存储的 `session_owners` 域中，不改动已发布的会话头和日志。既有会话由 `owner` 接管；创建、分叉和持久智能体绑定会在返回之前保存其受信任的所有者。所有者写入失败的会话会被记为拒绝，而不是保留创建事件最先接管的账户，因此在之后的分配成功之前，它对所有账户都保持隐藏。账户主体只能看到自己拥有的会话行和 FTS 结果，属于其他账户的会话 id 与未知的会话 id 得到相同的拒绝访问结果。伴随文件损坏会阻止账户策略激活，并保留损坏的文档。释放该插件会移除其服务和策略。

同一个插件还提供 `accountGrants`，即账户之间显式的定向授权，保存在 `account_grants` 域中：`grant(ownerId, granteeId)`、`revoke(ownerId, granteeId)` 和 `allows(ownerId, granteeId)`。只有当另一个账户向调用方授权时，持久智能体目录和 `agent_send_message` 才会列出该账户的智能体；中断遵循同一授权。宿主账户和同一所有者的调用不需要授权。`list(ownerId)` 返回某个所有者已准许的账户。持久智能体通过邮箱工具中的 `agent_grant_access` 和 `agent_revoke_access` 授权与撤销，它们只对调用方自己的账户生效。撤销会在下一次目录读取时生效，同时也会切断已被接受的邮件：当尝试待处理的投递以及写入回复时，邮箱会再次询问 `agentDirectory.reaches(fromId, toId)`，因此跨越已撤销账户的未投递消息或回复会被记为 `refused`，并附带一个绝不提及对方账户的中性原因。已经收到消息的回合会保留该消息。

`@deepseek-ai/dsh-agent-runtime/accounts` 插件打开按记录存储的 `accounts` 域，并提供 `accounts`：`create(name, role)` 返回新账户及其一次性令牌文件的路径，另有 `list`、`get`、`disable`、`reactivate` 和 `archive`，以及 `authenticate(token)` 和 `isAdministrator(id)`。令牌文本只会写入 `$DSH_HOME/accounts/tokens` 下权限为 `0o600` 的文件一次，该目录位于会话工作区之外，只保存其 SHA-256 哈希；返回值绝不携带密钥。已归档的账户保持可读但失去凭据；停用账户会保留其数据和令牌。`@deepseek-ai/dsh-agent-runtime/account-auth` 注册一个 Connection 主体来源，把 `Authorization: Bearer <token>` 映射为 `{ kind: 'account', ownerId }`，而 `accounts/ended` 会结束该账户已打开的 peer。`@deepseek-ai/dsh-agent-runtime/account-tools` 只向处于活动状态的管理员账户开放 `account_list`、`account_create`、`account_disable`、`account_reactivate` 和 `account_archive`；账户 id 绝不会被接受为调用方身份，`account_create` 返回令牌文件路径而不是令牌。没有账户凭据的请求保留原有的 owner 认证流程。

<a id="browser-account-entry"></a>

## 浏览器账户入口

`@deepseek-ai/dsh-agent-runtime/account-web` 提供 `/account/login`、`/account/access` 和仅接受 POST 的 `/account/logout`。登录仅通过有大小上限的同源表单 POST 接收入口令牌，并交换为不透明的 HttpOnly、SameSite=Strict 会话 cookie（TLS 下带 Secure）；入口令牌既不返回也不保留。服务器只在内存中保存会话凭据的哈希，并绑定监听器来源和账户。`sessionMinutes` 默认 720（1–10080），`maxSessions` 默认 1000（1–100000）。到期、退出、账户停用或归档以及插件卸载会结束相关账户的 Peer；由于 Connection 每个账户共享一个 Peer，该账户的其他浏览器会话会重新连接。重启后需要重新登录。全局固定窗口在每个 `loginWindowSeconds`（默认 60，范围 1–3600）内允许 `loginMaxFailures` 次认证失败（默认 20，范围 1–100000）。达到上限后，无论令牌是否有效，匿名登录均在认证前返回静态 429；有效会话仍可访问。成功登录不会重置计数。插件只保留两个数值，不追踪 IP；其他新登录也会受到临时限制。登录会清除旧的 owner cookie；退出不会自动恢复 owner 权限。

授权页面调用与 `agent_grant_access`、`agent_revoke_access`、`agent_list_grants` 相同的 `accountGrants.grant`、`revoke`、`list` 服务。调用方来自已认证账户，绝不来自表单的 owner id。目标通过 id 输入，不公开账户目录。页面只列出向外授予的访问权限，并在 POST 前确认撤销。按浏览器语言选择英语或葡萄牙语，其他语言使用英语。这些页面不调用模型，不运行智能体回合，也不使用持久浏览器存储。

## 模型体验

### 持久会话与例程

#### 模型看到什么

邮箱和例程工具基于稳定的配置 id 运行。`exec.agent.id` 是实时会话 id；桥接通过注册表元数据解析其持久智能体。收到的邮件仍是协作方数据，脚本载荷仍是外部数据。既有的身份预设会为每个已绑定的会话组合配置指令和必要记忆。

#### Token 影响

不增加模型调用。邮件投递和例程执行各自使用正常的会话回合。日历的受信任提醒载体会在提供方分发之前被取消；其持久投递回执让例程引擎恰好准入一次执行。普通的调度提醒不受影响。

#### KV Cache 影响

新会话复用配置的 persona 内容；会话专属的消息和载荷属于独立的历史。

## 已知限制与延期工作

- 通过持久智能体目录进行的发现和中断，限于调用方配置的所有者，或在显式保存的授权之后限于另一个账户。
- 没有所有者的旧配置属于 `owner`。
- `owners` 策略在随附的 Web 组合包中默认开启，在其他所有组合中关闭；除此之外，这些插件不修改随附的配置。
- 令牌轮换和密码找回不属于浏览器入口页面。
- 账户表单要求 Origin 与接收监听器的协议和 Host 匹配；这些入口表单不支持在反向代理处终止 TLS。
- 账户页面使用相对于根目录的路由；部署于反向代理路径前缀下时需要路由重写。尚未进行浏览器检查。
- `account_create` 把入口令牌写入 `$DSH_HOME/accounts/tokens` 下的受限文件；模型只会收到该路径，文件必须私下交给账户持有者，然后删除。
- 停用或归档账户会立即结束其 peer；不会取消这些 peer 内已经在运行的回合。
- 账户管理只存在于 `account-tools` 插件中；没有它时，受信任的宿主代码必须调用 `accounts` 服务。
- 旧的 `owner` 主体仍是受信任的宿主调用方，保留其现有的不受限访问。
- 撤销无法收回正在运行的回合已经收到的消息。
- 授权只允许智能体之间发送消息，不共享会话、记忆或表格。
- 不实现提供方账户和自动回退。
- 宿主关闭时会释放由例程运行器拥有的会话；邮箱拥有自己的投递会话。
