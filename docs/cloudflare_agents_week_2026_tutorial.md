# Cloudflare Agents Week 2026 核心技术教程：构建 Agentic Cloud

> 项目级架构落地版请优先看
> [Cloudflare Agentic Cloud 2026 Guide](cloudflare-agentic-cloud-2026-guide.md)。
> 本文保留为中文技术教程和概览。

Cloudflare 在 2026 年 4 月 12 日至 17 日举办了首届 **Agents Week 2026**。本次发布会的核心理念是：为“Agentic Web（Agentic 时代网络）”提供从底层计算到网络安全、从状态存储到模型推理的完整基础设施。本教程将带你深入了解并掌握此次发布的核心组件。

---

## 1. 计算层 (Compute)

在 Agent 时代，AI 不仅需要调用工具，更需要实际执行代码的沙盒环境。

### 1.1 Dynamic Workers (动态 Workers)
* **概念**：基于 V8 Isolate 的轻量级代码沙盒环境，比传统容器快 100 倍。
* **优势**：毫秒级冷启动，支持动态运行 AI 实时生成的代码。
* **应用场景**：为每一个消费者级别的 Agent 实时分配一个安全的执行上下文。

### 1.2 Sandboxes GA (沙盒正式发布)
* **概念**：赋予 Agent 真正的“专属电脑”。提供持久化的 Linux 隔离环境。
* **特性**：
  - 允许 Agent 克隆 Git 仓库、安装软件包、运行长时间的后台任务。
  - 按实际活动的 CPU 时间计费（不为闲置时间付费）。
* **配套 SDK (`@cloudflare/sandbox`)**：支持 `exec`, `gitClone`, `writeFile`, `terminal`, `exposePort` 等方法。

---

## 2. 状态与存储 (State & Storage)

普通的无状态 API 无法支撑复杂的自主 Agent 任务，它们需要记忆与持久化。

### 2.1 Agent Memory (Agent 记忆)
* **概念**：全托管的长期记忆服务，建立在 Durable Objects 和 Vectorize 之上。
* **机制**：
  - **四种记忆分类**：Facts（事实）, Events（事件）, Instructions（指令）, Tasks（任务）。
  - 支持 `ingest`（批量摄取对话）, `remember`（显式记忆）, `recall`（回忆/合成答案）, `forget/list`（删除/查看列表）。
* **优势**：避免将漫长的历史记录塞入 Prompt，解决上下文遗忘和污染问题。

### 2.2 Durable Object Facets
* **概念**：允许 AI 生成的代码不仅包含逻辑，还能自带持久化存储。
* **应用场景**：为每一个由 AI 生成的微服务提供独立、隔离的 SQLite 数据库。

### 2.3 Artifacts (Beta)
* **概念**：专为 Agent 打造的原生 Git 兼容版本化存储。
* **机制**：Agent 可快速创建自己的仓库，底层利用 Durable Objects + SQLite + R2 快照实现，并且支持标准 Git 客户端 `git clone`。

---

## 3. 网络与安全 (Network & Security)

### 3.1 Sandbox Auth (沙盒认证)
* **概念**：Agent 与外部世界的安全隔离墙。
* **机制**：网络层注入凭证。API Key 和 OAuth token 在代理层注入，Agent 运行的不可信代码永远不会直接接触到这些机密信息。

### 3.2 Agentic Inbox 的外部 MCP Bearer 支持
Agentic Inbox 现在支持两类外部 MCP 连接：OAuth 连接继续走 Cloudflare Agents SDK 的授权回调；不支持 OAuth 的 MCP 服务可以走静态 Bearer token。Bearer token 不会写入 SDK 的 `server_options`，而是先用 `MCP_BEARER_KEK_CURRENT` 派生出的 AES-GCM key 加密后存进 mailbox Durable Object 的 SQLite，运行时再通过 `transport.fetch` 闭包注入 `Authorization: Bearer ...`。

上线步骤：

1. 生成 32 字节 KEK：
   ```bash
   openssl rand -base64 32
   ```
2. 写入生产 secret：
   ```bash
   wrangler secret put MCP_BEARER_KEK_CURRENT
   ```
3. 确认 `wrangler.jsonc` 中 `L4_MCP_ENABLED` 与 `L4_MCP_BEARER_ENABLED` 均为 `"true"`。
4. 部署后，只有当 Bearer 子开关为 `"true"` 且 `MCP_BEARER_KEK_CURRENT` 存在时，Bearer add / rehydrate 路径才会运行；否则 OAuth 不受影响，Bearer 路径 fail-closed。

KEK 轮换 runbook：

1. 记录旧 current，生成新 KEK。
2. 将旧值写入 `MCP_BEARER_KEK_PREVIOUS`，将新值写入 `MCP_BEARER_KEK_CURRENT`。
3. 将 `MCP_BEARER_KEK_VERSION` 从 `1` 递增到 `2`（后续轮换继续递增）。
4. 部署并观察 Bearer 连接 rehydrate；旧 blob 可用 previous 解密，新写入 blob 使用 current。
5. 当旧 blob 全部淘汰或重录后，再清空 `MCP_BEARER_KEK_PREVIOUS`。

### 3.3 Cloudflare Mesh
* **概念**：Agent 的零信任私有网络。
* **功能**：通过 `cf1:network` VPC 绑定，允许 Agent 在没有反向代理的情况下直接访问内网数据库和私有 API。

---

## 4. Agent 工具箱 (The Agent Toolbox)

### 4.1 统一的推理层：AI Gateway & Workers AI
* **AI Gateway**：目前已支持 14+ 模型提供商的 70 多种模型。
* **Workers AI**：提供包括 Kimi K2.5 等在内的前沿大模型推理。
* **Unweight**：无损的推理时压缩系统，能减少高达 22% 的模型体积，进一步降低推理延迟和成本。

### 4.2 Browser Run (赋予 Agent 浏览器能力)
* **概念**：在 Cloudflare 边缘网络上运行完整的浏览器会话。
* **新特性**：
  - **Live View**：人类可以在后台实时查看 Agent 在页面上的操作轨迹。
  - **Human in the Loop (HITL)**：Agent 遇到卡点（如验证码或登录）时，人类可随时接管介入。

### 4.3 状态化电子邮件 (Email Service Public Beta)
* **概念**：为 AI Agent 提供原生的双向收发邮件能力，旨在替代 Zapier 等胶水工具。
* **机制**：通过 Email Routing 接收，基于 Durable Objects 实现状态持久化，最后经 Email Sending 发送。自带 SPF, DKIM, DMARC 鉴权，防御伪造攻击。

---

## 5. 开发者标准与度量 (Standards & Measurement)

* **Agent Readiness Score (Agent 就绪度评分)**：通过 `isitagentready.com` 类似 Lighthouse 的工具，帮助网站所有者评估其网站对 AI 爬虫和 Agent 的友好程度。

## 总结

Cloudflare 通过 Agents Week 2026 将传统框架层（如 LangChain、AutoGpt）需要用“胶水”拼凑的能力（如沙盒执行、私有网络访问、跨轮持久化状态），直接下沉变为了具备 SLA 保障的网络基础设施。开发者现在可以使用这套平台，低成本地构建数以千万计的并发 Agent。
