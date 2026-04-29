# 产品叙事完成度评估报告

Updated: 2026-04-29

## 评估范围

本报告基于 `.omx/specs/deep-interview-product-narrative-completeness.md` 输出，评估对象是 Agentic Inbox 当前仓库内的产品叙事是否足以完成第一步用户转化：让新用户看懂一个典型 `finance@` 工作流，并能复述 Agentic Inbox 如何改变这个工作流。

评估镜头：用户转化，而不是投资人叙事、商业模式、定价、市场规模或融资故事。

主要证据来源：

- `README.md`
- `docs/product-narrative.md`
- `docs/foundation-architecture.md`
- `docs/cloudflare-agentic-cloud-2026-guide.md`
- `docs/agent-tool-extension-architecture.md`
- `docs/PROGRESS.md`
- `docs/assets/agentic-inbox-product-narrative-en.png`
- `docs/assets/agentic-inbox-product-narrative-zh.png`

## 总体结论

**产品叙事完成度：74 / 100。**

Agentic Inbox 已经具备清晰的类别定义和可信的 Cloudflare-native 架构底座：它不是普通 AI 邮件客户端，而是把共享角色邮箱变成 agent-native 工作流空间。当前叙事的强项是“为什么邮箱适合做 agent 工作流底座”“为什么 mailbox 是隔离单元”“为什么能力边界比通用工具更重要”。

但如果以“新用户能否快速看懂 finance@ 发票工作流”为主要转化目标，当前叙事仍然偏架构和平台化，finance 场景还没有成为用户进入产品的第一条主线。仓库里已经有很强的发票能力证明，尤其是 `docs/PROGRESS.md` 记录的 XML/OFD/PDF/ZIP、外链下载、OCR、R2 持久化、发票 UI、MCP 工具和人工上传兜底；但这些证据目前更像工程进度记录，没有被重组为面向新用户的 before/after 故事、演示路径和行动入口。

一句话判断：**底层产品叙事已经成立，用户转化叙事还差一个以 `finance@` 为中心的“具体故事层”。**

## 评分总表

| 维度 | 分数 | 当前证据 | 主要缺口 | 优先级 |
| --- | ---: | --- | --- | --- |
| 类别清晰度 | 86 | `README.md` 和 `docs/product-narrative.md` 已明确 “open-source agent-native mailboxes for durable workflows” 与 “agent-native shared mailbox platform” | 类别语义强，但对非技术用户仍偏抽象 | P1 |
| 用户痛点清晰度 | 62 | 已说明 shared role mailbox、durable threads、attachments、human review 等现实基础 | 缺少 finance 用户的日常痛点：发票散落、附件过期、人工录入、对账追溯、审批前复核 | P0 |
| Finance 工作流清晰度 | 68 | `docs/product-narrative.md` 有 6 步 finance mailbox；`docs/PROGRESS.md` 有完整发票 pipeline 证明 | Finance 仍是 Golden Workflows 中的一节，没有成为 README/叙事首页的主故事 | P0 |
| Before / After 对比 | 46 | 间接表达了“email 是 session，attachment 是 artifact” | 缺少明确的“传统邮箱怎么做 / Agentic Inbox 怎么做 / 用户得到什么变化”对照 | P0 |
| 信任与控制 | 84 | `docs/product-narrative.md` 有 Trust Contract；架构文档强调 Worker trust boundary、signed internal context、ACL、capabilities | 用户侧还需要更浅显的“agent 不会自动发送、不绕过权限、字段有来源”说明 | P1 |
| 第一步行动清晰度 | 59 | README 有 deploy/setup，产品文档有 canonical loop | 对目标转化动作“先看懂 finance workflow”支持不足；README 太快进入部署步骤 | P0 |
| 与 AI email client / automation tool 差异化 | 80 | 明确提出不是 AI email client；capabilities、MCP、mailbox-scoped runtime 差异清楚 | 差异化偏概念，需要借 finance 场景展示“不是智能回复，而是可审计工作流” | P1 |
| 视觉叙事支持 | 72 | 已有英文/中文产品叙事图，表达 mailbox -> agent -> workflow -> human review | 图片可帮助理解，但还不是 finance workflow 的逐步 storyboard | P1 |
| 技术用户架构可信度 | 89 | `foundation-architecture`、Cloudflare guide、tool extension docs 完整，符合 Cloudflare agent infra 方向 | 文档之间层级还需要更明确，避免新用户一开始被架构细节淹没 | P2 |
| 开源自托管信心 | 83 | README 有 Cloudflare deploy、auth、R2/DO/D1/Workers AI、MCP；Apache 2.0 | 需要把“自托管后能跑通 finance demo”的路径写得更短 | P1 |

## 维度详评

### 1. 类别清晰度：86 / 100

当前类别定义已经比较成熟：Agentic Inbox 是“agent-native shared mailbox platform”，短句是“open-source agent-native mailboxes for durable workflows”。这能有效避开两个模糊区：一是普通 AI 邮件客户端，二是泛化 agent 平台。

优势：

- `docs/product-narrative.md` 把 mailbox address 定义成 role workspace and authorization boundary。
- README 已经把 email、attachments、mailboxes 分别映射成 session layer、artifacts、agent workspaces。
- 架构文档用 mailbox-first isolation、capability contract、MCP same ACL 支撑类别可信度。

缺口：

- “agent-native mailbox platform” 对技术用户清楚，但对 finance/support 用户仍需要一个更具象的入口。
- 当前最强的一句话还在解释“这是什么”，而不是立即展示“它帮我处理了哪一封邮件”。

建议：保留当前类别定义，但在用户入口前置一句更场景化的副标题，例如：

> Turn `finance@` into a reviewable invoice intake workflow: emails become sessions, attachments become artifacts, and agents prepare structured records for human approval.

### 2. 用户痛点清晰度：62 / 100

当前文档准确识别了共享角色邮箱、附件、异步线程、人工复核这些基础事实，但痛点还没有被写成用户能立刻共情的故事。

finance 用户真实痛点应该被显式写出来：

- 发票邮件来自不同供应商、平台和税务系统。
- 附件格式不统一：XML、OFD、PDF、ZIP、正文外链混杂。
- 邮件线程是事实来源，但结构化台账在另一个系统里。
- 人工下载、解包、录入、复核和对账会制造重复劳动。
- 外链可能过期，附件来源需要保留，字段需要能追溯。
- Agent 如果直接“猜字段”或自动发邮件，会带来审计风险。

这些能力在 `docs/PROGRESS.md` 里其实已经被工程验证过，但还没有上升为用户叙事。

### 3. Finance 工作流清晰度：68 / 100

`docs/product-narrative.md` 的 finance mailbox 已经包含关键步骤：vendor invoice arrives、attachments stored in R2、invoice skill triggers extraction、invoice agent creates structured records、owner approves/export、fields link to source ids。

这条链路方向正确，但颗粒度偏概念化。新用户仍然很难回答：

- 第一封发票邮件长什么样？
- Agentic Inbox 自动做了什么，什么需要人确认？
- 如果只有 PDF、OFD、ZIP 或外链怎么办？
- 提取后的发票记录在哪里看？
- 错误、低置信度、需要复核时如何处理？
- 最终输出是什么：草稿邮件、发票列表、报销包、导出文件，还是 MCP 查询结果？

最好的叙事资产已经存在于 `docs/PROGRESS.md`：真实邮件测试、ZIP/OFD 解包、外链下载、PDF OCR 兜底、人工上传、发票徽章、列表/详情页、MCP 工具。下一步不是重新设计能力，而是把这些工程成果改写为用户旅程。

### 4. Before / After 对比：46 / 100

这是当前最大短板。

当前文档强调了新范式：email 是 durable workflow substrate，attachments 是 artifacts，agent 通过 scoped capabilities 工作。但缺少直接对比，因此用户不容易形成“我现在为什么需要它”的判断。

建议新增一个 finance before/after 模块：

| 传统 `finance@` | Agentic Inbox `finance@` |
| --- | --- |
| 发票散在邮件和附件里 | 每封邮件成为可追溯 workflow session |
| 人手下载 XML/OFD/PDF/ZIP | 附件和派生文件持久化到 R2，并保留来源树 |
| 人工录入字段 | 确定性解析和 OCR 生成结构化记录 |
| 不确定字段靠记忆或截图 | 字段链接回源邮件和附件，低置信度标记复核 |
| 回复供应商靠复制粘贴 | Agent 起草澄清/补件邮件，人类审批后发送 |
| 对账依赖临时表格 | 发票列表、详情、筛选和 MCP 查询共享同一数据 |

这个对比应该进入 README 顶部和产品叙事文档的 finance 章节。

### 5. 信任与控制：84 / 100

这是当前强项。产品已经清楚表达：agent 默认准备草稿，人类保留敏感动作控制权；外部邮件和附件是不可信输入；内部 DO 身份使用 signed auth-context；MCP 不绕过 ACL；capabilities 是执行边界。

需要补强的是用户语言：

- “Agent 不会直接付款、发送、删除或调用外部系统，除非 owner 明确授权。”
- “每个字段都有来源：邮件、附件、派生文件或 OCR 结果。”
- “低置信度和 OCR 风险会进入复核状态，而不是静默写入。”
- “外部 MCP client 和网页端看到同一套 mailbox 权限。”

这能把工程安全设计转化成用户可理解的信任承诺。

### 6. 第一步行动清晰度：59 / 100

README 目前从介绍很快进入 setup/deploy。对开源项目这是合理的，但与 deep-interview spec 的目标不完全一致：用户第一步不是部署，而是看懂典型 finance workflow。

推荐 README 顶部的信息层级改为：

1. 一句话定位。
2. `finance@` 90 秒故事。
3. 三步 loop：receive -> extract/prepare -> human review。
4. 一张 finance workflow 图或 GIF。
5. “Then deploy to Cloudflare” setup。

这样不会削弱 deploy CTA，反而能让部署行为建立在更明确的动机上。

### 7. 差异化：80 / 100

当前差异化已经不错：不是 AI email client，不是 Zapier/no-code，不是泛 agent swarm；核心是 mailbox-scoped agents + durable email sessions + artifacts + capability policy + MCP。

仍需用 finance 场景证明差异：

- AI email client 的价值是“帮你写邮件”。
- Automation tool 的价值是“触发动作”。
- Agentic Inbox 的价值是“把 role mailbox 变成可审计、可复核、可扩展的工作流运行时”。

如果 finance 例子讲透，差异化会更自然，不需要解释太多抽象术语。

### 8. 视觉叙事支持：72 / 100

`docs/assets/agentic-inbox-product-narrative-en.png` 和 `docs/assets/agentic-inbox-product-narrative-zh.png` 已经可以帮助投资人和用户理解产品结构，特别是 mailbox、agent、skills、MCP、human review 的关系。

当前不足：

- 图更像产品架构概念图，不是 finance 用户旅程图。
- 缺少“发票邮件 -> 附件树 -> 结构化记录 -> 人工复核 -> 草稿/导出”的 sequential storyboard。

建议新增一张 finance workflow 专用图，作为 README 第一屏的用户理解入口；现有产品叙事图保留为第二层解释。

### 9. 技术用户架构可信度：89 / 100

`docs/foundation-architecture.md`、`docs/cloudflare-agentic-cloud-2026-guide.md`、`docs/agent-tool-extension-architecture.md` 已经形成了较完整的架构证明：

- Worker 是 trust boundary。
- D1 是 identity/control plane。
- MailboxDO 是 per-mailbox data plane。
- R2 是 artifact plane。
- Agent DO / MCP 是 agent plane。
- Queues/Workflows 是 background plane。
- Capabilities 是统一执行契约。
- Skills 改变行为但不授予权限。

这足以支撑技术用户相信该项目不是 demo，而是可演进的 Cloudflare-native agent infrastructure。

主要风险是信息过载：用户入口不应先读 Cloudflare guide 或 extension architecture。它们应该作为“想深入理解时的证据链”，而不是第一层叙事。

### 10. 开源自托管信心：83 / 100

README 已经具备开源部署信心：Cloudflare Workers、Email Routing、R2、Durable Objects、Workers AI、native auth、API keys、MCP、Cloudflare Access fallback 等都被明确列出。

需要补的是 demo-driven confidence：

- “部署后如何创建 `finance@`？”
- “如何转发一封含发票附件的邮件？”
- “在哪里看到提取结果？”
- “如何确认 agent 只是起草而不是发送？”
- “如何用 MCP 查询这张发票？”

这些问题如果变成 README 的 quick demo 或 `docs/finance-workflow-demo.md`，用户信心会明显提升。

## Finance 场景叙事缺口

### 最大转化阻塞

当前 finance 场景的问题不是能力不够，而是**产品故事没有把能力串成一个用户能复述的旅程**。

新用户看完当前文档，可能理解：

> 这是一个 Cloudflare 上的 agent-native 邮件平台。

但不一定能立刻复述：

> 当供应商把发票发到 `finance@`，Agentic Inbox 会把邮件线程当作 session，保存附件和派生文件，解析 XML/OFD/PDF/ZIP/外链，生成可复核的发票记录，把低置信度字段标出来，并让 agent 起草需要人工审批的跟进邮件；所有字段都能回到原始邮件和附件。

后者才是 spec 里的目标转化动作。

### 具体缺口

1. 缺少 finance landing story。

   README 顶部没有用 `finance@` 讲一个完整例子，而是直接进入通用产品和部署。

2. 缺少 before/after。

   文档没有把传统 finance mailbox 的混乱状态与 Agentic Inbox 的结构化、可复核状态并排展示。

3. 缺少真实 demo 脚本。

   `docs/PROGRESS.md` 证明已经处理过真实邮件和多格式发票，但这些内容没有变成“5 分钟演示路径”。

4. 缺少用户可见产物说明。

   需要明确产物包括：持久化附件、派生附件树、invoice records、items、needs_review、发票徽章、发票列表/详情、agent draft、MCP 查询。

5. 缺少人工复核细节。

   当前强调 human review，但 finance 场景里需要更明确：哪些动作自动执行，哪些动作只准备草稿，哪些动作 owner 才能批准。

6. 缺少异常路径。

   Finance 的可信度来自异常处理：没有 XML、只有 PDF、ZIP 中包含 OFD、正文外链、下载失败、OCR 低置信度、重复发票、历史邮件重跑。

7. 缺少 CTA。

   用户看懂故事后下一步应该是什么：看 demo、部署、导入示例邮件、创建 finance mailbox、启用 invoice skill，还是配置 MCP key。当前没有明确排序。

## 推荐文档重构

### 目标信息架构

建议把文档分成四层，而不是让所有文档承担同样的解释任务：

| 层级 | 文档 | 目标读者 | 作用 |
| --- | --- | --- | --- |
| L1 用户入口 | `README.md` | 新用户、评估者 | 用 `finance@` 让用户在 90 秒内看懂产品价值 |
| L2 产品叙事 | `docs/product-narrative.md` | 产品/技术评估者 | 定义类别、角色、JTBD、核心 loop、trust contract |
| L3 场景演示 | 建议新增 `docs/finance-workflow-demo.md` | 新用户、demo 用户 | 用一封发票邮件讲完整 before/after 和操作路径 |
| L4 技术证明 | `docs/foundation-architecture.md`、`docs/cloudflare-agentic-cloud-2026-guide.md`、`docs/agent-tool-extension-architecture.md` | 技术用户、贡献者 | 解释为什么架构可信、可扩展、符合 Cloudflare agent infra |

### README 重构建议

README 应该从“部署说明入口”调整为“用户先看懂，再部署”：

1. Hero：保留 open-source agent-native mailboxes。
2. Finance story：新增 `finance@` 故事卡片。
3. Core loop：email arrives -> artifacts persisted -> agent prepares -> human reviews -> provenance recorded。
4. What makes it different：mailbox-scoped agents、attachments as artifacts、capability boundary、MCP same ACL。
5. Demo image/GIF：优先使用 finance workflow 图。
6. Setup/deploy：保留现有 deploy 按钮和 After deploying 警告。
7. Architecture links：放到后半部分。

### `docs/product-narrative.md` 重构建议

当前文档方向正确，建议做两处结构调整：

1. 把 Finance Mailbox 从 Golden Workflows 中提到更靠前的位置，作为 primary narrative anchor。
2. 增加 “Finance Narrative Spine” 小节：pain -> incoming invoice -> extraction -> human review -> follow-up -> audit/provenance。

Support、ops、MCP 保留为 expansion examples，避免多角色叙事稀释第一转化路径。

### `docs/finance-workflow-demo.md` 新增建议

建议新增一份专门的场景文档，结构如下：

1. Scenario: vendor sends invoice to `finance@`。
2. Before: how teams handle this in a normal shared mailbox。
3. After: how Agentic Inbox handles it。
4. Step-by-step demo:
   - receive email
   - persist attachments to R2
   - detect XML/OFD/PDF/ZIP/external link
   - extract invoice fields
   - show invoice badge
   - open invoice detail
   - review `needs_review`
   - draft supplier follow-up
   - query via MCP
5. Trust model: what agent can and cannot do。
6. Try it: deploy, create mailbox, send sample invoice, inspect result。

### `docs/foundation-architecture.md` 重构建议

保持当前深度，不要承担用户第一眼转化任务。建议在开头加一行：

> If you are new to the product, start with `README.md` and `docs/finance-workflow-demo.md`; this document explains why that workflow is durable and safe.

这样可以把架构文档变成证据链，而不是入口页。

### `docs/cloudflare-agentic-cloud-2026-guide.md` 重构建议

这份文档应定位为 Cloudflare agent infrastructure mapping，不应该出现在 README 第一屏。建议在 README 中用一句话链接：

> Built on Cloudflare's agentic cloud primitives: Workers, Durable Objects, R2, Email Routing, Agents SDK, Workers AI, and MCP.

详细 Cloudflare 指南留给技术评估者和贡献者。

### `docs/agent-tool-extension-architecture.md` 重构建议

这份文档对“agent 如何扩展工具、支持 MCP skills”很关键，但它不是 finance 第一故事的入口。建议在 finance demo 末尾放一个“Why this can extend beyond invoices”链接，导向该文档。

## 推荐下一批 Docs / PR

### PR-A：README finance-first narrative

目标：让 README 第一屏完成用户理解，而不是只解释架构。

改动：

- 新增 `finance@` 90 秒故事。
- 新增 before/after 表。
- 新增 core loop 迷你图或链接到 finance workflow 图。
- 把 deploy/setup 下移但保留清晰 CTA。

验收：新用户看 README 顶部 2 分钟后，可以说清楚一封发票邮件如何变成可复核记录和草稿。

### PR-B：新增 finance workflow demo 文档

目标：把 `docs/PROGRESS.md` 的工程成果转成用户旅程。

改动：

- 新增 `docs/finance-workflow-demo.md`。
- 纳入多格式发票、外链、OCR、人工上传、badge、列表/详情、MCP 查询。
- 明确自动动作、人类复核、异常路径和来源追溯。

验收：贡献者或用户能按文档做一次端到端 demo。

### PR-C：新增 finance workflow 视觉图

目标：用一张图解释 finance 场景。

改动：

- 新增 `docs/assets/agentic-inbox-finance-workflow-zh.png` 和英文版。
- 图中体现 `finance@`、thread/session、R2 artifacts、invoice extraction、human review、draft/export/MCP。

验收：图单独出现时，非代码用户也能理解产品价值。

### PR-D：产品叙事文档重排

目标：让 `docs/product-narrative.md` 与 spec 对齐。

改动：

- 新增 primary narrative anchor。
- Finance workflow 提前。
- Support/ops/MCP 调整为 secondary expansion。
- 增加 trust/control 的用户语言版本。

验收：产品叙事不再平均分配给多个角色，而是先讲透 `finance@`。

### PR-E：Demo CTA 和 sample data

目标：把理解转化为可执行试用。

改动：

- 增加 sample invoice email 或本地 demo 指引。
- 增加“创建 finance mailbox -> 发送测试邮件 -> 查看 invoice badge -> 用 MCP 查询”的 checklist。

验收：部署后的第一条成功路径清楚可跑。

## 结论

Agentic Inbox 的核心定位已经可行，而且与 Cloudflare agent infrastructure 的契合度很高。当前完成度的主要瓶颈不在架构、不在能力，也不在开源部署，而在用户入口叙事：需要把 `finance@` 从“多个示例之一”提升为第一条清晰、可演示、可复述的产品故事。

建议下一步不要先扩展更多场景，而是先用文档和视觉材料把 finance 故事讲透：

> 发票进入邮箱，邮件成为 session，附件成为 artifacts，agent 生成可复核的结构化工作，人类批准敏感输出，系统保留来源和审计证据。

当这条故事成立后，support、ops、legal、external MCP、skills marketplace 都会更容易被理解为自然扩展，而不是一组分散功能。
