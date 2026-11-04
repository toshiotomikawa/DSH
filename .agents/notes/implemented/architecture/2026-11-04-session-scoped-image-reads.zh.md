# Agent Note: 账户归属下图片读取限制在目标 Session 内

Status: implemented

[English](2026-11-04-session-scoped-image-reads.md) | 中文

## Problem

账户归属让每个连接拥有过滤后的 Session 列表和搜索，但 `session/attachment` 只授权 Session 身份，随后读取调用方提交的任何引用。图片 ID 是规范化字节的 SHA-256，因此拥有任意 Session 并知道哈希的账户可以读取仅被其他账户 Session 记录的图片。M7a 审计复现了这一点：审计语料把 fork 的文本暴露给了不该看到它的账户，而读图路径完全没有成员校验。

[存储作用域决策](2026-10-23-store-scoped-image-reads.zh.md)正是因为成员扫描会让每次未缓存读图都产生与历史长度成正比的工作，而桌面应用无法承担这笔开销，才接受了这一暴露。

## Decision

挂载账户归属 sidecar（`sessionOwners`）时，`session/attachment` 要求目标 Session 自己的持久日志包含所请求的引用。处理函数以 `projectionMode: 'none'` 观察该 Session，只有当由事件推导出的消息含有该附件 ID 的图片块时才接受读取。Gateway 对 Session 资源的权限检查依然先执行，且该检查从不激活或恢复 Session。

目标 Session 从未记录的引用，与不存在的对象返回相同的终止错误 `session/attachment-invalid` 和原因 `ATTACHMENT_NOT_FOUND`，无论图片属于其他 Session 还是不属于任何 Session，因此失败不构成存在性提示。日志不可读时不会退回到存储读取。

未挂载该 sidecar 时，端点保留上游的存储作用域行为，包括零历史读取路径。该限制用于分隔账户；只挂载一个账户的 Host 没有需要分隔的对象。

## Alternatives considered

**保留存储作用域读取，依赖哈希保密。** 对于准入时原样保留的已知 PNG、JPEG 或 WebP 字节，ID 可以直接计算，哈希不构成账户之间的边界。

**无条件执行成员校验。** 它关闭同一漏洞，但会让每个单账户 Host 为一条在那里不保护任何东西的规则在每次读图时支付一次日志读取，而随产品发布的桌面组合并未挂载账户策略。按组合生效的规则让上游开销留在不需要保护的路径之外。

**维护 Session 到图片的索引或投影。** 索引可以消除重复扫描，但需要为每个历史、fork 继承、工具结果与已卸载图片在首次读取前完成推导、生命周期和失效处理；在冷路径扫描被证明昂贵之前推迟。

**签发按 Session 的图片票据。** 为同一条成员规则增加签发与校验状态。

## Consequences

在账户归属下，冷 Session 的每个未缓存图片都支付一次完整的日志观察，而不是零次，因此较长的冷会话读图开销与历史长度成正比。活动 Session 读取内存中的切片；工具结果、fork 继承与已卸载图片仍然可读，因为其引用保留在事件中。

`image-read.perf.ts` 诊断仍分别度量存储、传输与历史，但其 `--expect-no-history` 模式描述的是变更前的控制器，复用为证据前必须重新建立基线。

该规则距离完整的 Session 日志检查只差一步：被 `owner` 收编的 Session 记录或被拒绝的记录仍只由 Gateway 自己的权限判断决定。Session 的存在、归属与拒绝仍由归属 sidecar 负责；本规则只拒绝字节。

## Verification

`remote-access.host.spec.ts` 证明仅被其他 Session 记录的引用与无人记录的引用以相同的代码、原因和消息失败，没有字节到达存储，而目标 Session 记录的引用仍然解析成功。`commands-queue-attachment.host.spec.ts` 覆盖已记录读取、未记录哈希、缺失 Session、不可读日志，以及未挂载归属策略时的存储作用域路径。在 Session Controller 套件下，`commands.ts` 保持语句、分支、函数和行 100% 覆盖。
