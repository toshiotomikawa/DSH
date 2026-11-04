# Agent Note: 通过临时浏览器会话进入账户

Status: implemented

[English](2026-11-04-browser-account-entry.md) | 中文

## 问题

浏览器普通导航无法附加现有的账户 bearer 头。复用宿主的 owner cookie 会让账户获得无限制的 owner 权限，而把长期入口令牌保存在浏览器存储中又会不必要地暴露令牌。

## 决策

账户插件把入口令牌交换为独立的内存会话凭据，并向 Connection 注册 principal source。服务器渲染的表单让凭据远离客户端插件和模型工具。[账户运行时 README](../../../../packages/agents/agent-runtime/README.zh.md#browser-account-entry) 负责说明路由、限制和撤销行为。

Principal source 可以用 null 显式拒绝凭据。不处理和拒绝必须区分，因为 owner cookie 是另一项权限：无效的账户会话不得回退到它。Index 授权使用与 API 准入相同的 source 和信任检查，frontend-static 使用已准入的 Peer 渲染。这扩展了[浏览器信任决策](2026-07-28-api-browser-trust-boundary.zh.md)，而不改变其 Host/Origin 规则或 owner 启动令牌交换。

## 考虑过的替代方案

**把账户入口令牌保存在浏览器存储中。** 拒绝，因为独立且可撤销的会话凭据支持导航认证，无需反复暴露长期入口令牌。

**通过模型工具和合成的智能体会话执行授权。** 拒绝，因为浏览器账户已经认证，授权由 AccountGrants 所有；为了调用同一个领域服务而创建智能体，会引入虚假的调用方和会话记录。

## 后果

重启或卸载插件后需要重新登录。账户插件拥有凭据生命周期，Connection 拥有 Peer；撤销会话会关闭共享的账户 Peer，因此同一账户的其他浏览器会话会重新连接。表单要求与接收监听器同源的 POST，初始页面使用相对于根目录的路由。HTTP/Loader 集成测试覆盖身份投影、向外授权、撤销、恶意表单输入、凭据拒绝、到期、卸载和原生 TLS cookie，无需打开浏览器或调用提供方。
