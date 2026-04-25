# Agentic Inbox — 开发进度记录

> 最后更新：2026-04-24
> 当前分支：`main`
> 最新生产版本：`2d010d4b-7e38-455c-83ff-3c9791fc3e9b`（`a540841`）

---

## 一、项目定位

Cloudflare Workers 上自托管的 AI 邮件客户端 —— 每个 mailbox 是一个独立 Durable Object（自带 SQLite + R2），邮件由 `EmailAgent` 驱动阅读 / 回复 / 编排，并通过 MCP 对外暴露给其它 agent/CLI。

**栈**：Cloudflare Workers · Hono · Durable Objects (drizzle + SQLite) · R2 · Workers AI · React Router v7 SSR · TanStack Query · Zustand · Kumo 设计系统 · MCP (`agents/mcp` + `@modelcontextprotocol/sdk`)。

---

## 二、阶段性成果一览

| 阶段 | 主题 | 状态 | 关键 Commit |
|------|------|------|-------------|
| Phase 0 | 后端能力 ↔ MCP 工具对齐（19 个新工具） | ✅ 部署 | `b04f882` |
| Phase 0.5 | Cloudflare Access Service Token 认证（生产 MCP 可用） | ✅ 部署 | `ec4a95e` |
| Phase 1 | 中国数电票结构化提取 + 持久化（XML） | ✅ 部署 | `93f0cdd` |
| Phase 1b | 数电票 schema 补丁 + `reprocess_invoices_for_email` 工具 | ✅ 部署 | `3b19533` |
| Phase 2 | 多源适配：ZIP/OFD 解包 + 正文外链下载 | ✅ 部署 | `3b715a3` |
| Phase 3 | PDF OCR 兜底（DeepRead） | ✅ 部署 | `cfa58de` · `edd21fe` |
| Phase 4a | 发票管理 UI（列表 / 详情 / 筛选 / 分页） | ✅ 部署 | `6b76f71` |
| Phase 4b | 百望 SPA 场景 — 人工上传兜底 | ✅ 部署 | `6b76f71` |
| Phase 4c | "已提取发票"徽章（列表 + 详情） | ✅ 部署 | `a540841` |

累计 6 个 invoice 相关 commit，**+3216 / −628 行**；30 个文件受影响，其中 9 个为新建 worker 库、2 个新建前端路由、1 个新建共享组件。

---

## 三、硬性约束（贯穿 Phase 1–4）

1. **发票字段的唯一真源是发票文件本身**。正文 HTML 的 label-value 不作为字段源，即使结构完整。
2. **每张入库发票必须关联至少一个原始发票文件**（XML / OFD / PDF），且文件持久化到 R2。
3. **没有真实发票文件就不入库**。下载失败 → `skipped` + reason，不写降级假数据。
4. **去重键**：`invoice_number` + mailbox（业务键），同 email 内重跑 idempotent。
5. **提取归代码，查询归 agent**：确定性解析器写库，agent 通过 MCP 工具查询/分析。

---

## 四、Phase 0 — MCP 工具对齐

`b04f882` — 把此前只能通过 HTTP 直调的后端能力全部映射到 MCP，让外部 agent 可以脚本化操作收件箱。

新增 19 个工具，分五组：

| 组 | 工具 |
|----|------|
| Identity | `whoami` |
| Members | `list_members` · `add_member` · `remove_member` |
| Invites | `create_invite` · `accept_invite` |
| Settings | `get_mailbox_settings` · `update_mailbox_settings` · `get_agent_config` · `update_agent_config` |
| Rules | `list_rules` · `set_rules` |
| Folders | `list_folders` · `create_folder` · `rename_folder` · `delete_folder` |
| Email ops | `forward_email` · `mark_thread_read` · `star_email` · `draft_reply` |

所有工具沿用既有 `verifyMailbox` + `mcpResult` 模式，错误分支用 `mcpError` 明确返回（避免 `mcpResult` 联合类型与 `Record<string, unknown>` 不兼容）。

---

## 五、Phase 0.5 — Service Token 生产路径

`ec4a95e` — Cloudflare Access 的 JWT 对 service token 不带 email claim，只带 `common_name` / `sub`。原 `getUserFromRequest` 失败。

**改动**：`workers/lib/auth.ts` 在没拿到 email 时，从 `common_name` 合成伪邮箱 `<sanitized>@service.cloudflareaccess.local` 作为 subject。由此服务账户可被正常 `add_member` 挂到 mailbox 上，MCP 调用走通。

---

## 六、Phase 1 — 数电票结构化提取（XML）

### 架构决策

**代码解析器 > LLM agent 提取**。理由：

| 维度 | 代码解析 | LLM 解析 |
|------|---------|---------|
| 准确率 | 100%（XML 字段名固定） | 可能漏字段 / 幻觉发票号 |
| 成本 | 0 LLM 调用 | 每封 1+ 次 Workers AI |
| 延迟 | < 50ms | 2–10 秒 |
| 可重放 | 同 XML 同结果 | 不保证 |
| 可审计 | 解析失败 → null + 原 XML 留底 | 难追责 |

中国全电发票 XML 有固定税务总局 XSD，字段名稳定，属于"该用代码不该用 LLM"的教科书场景。Agent 不消失 —— 它通过 `list_invoices` / `get_invoice` MCP 工具查询结构化数据。

### 数据模型（Migration 9）

`workers/durableObject/migrations.ts` — `9_add_invoices_tables`：

```
invoices(
  id, email_id (FK cascade), attachment_id (FK cascade),
  invoice_number, invoice_code, invoice_type,
  issue_date, seller_name, seller_tax_id, buyer_name, buyer_tax_id,
  amount_excl_tax, tax_amount, amount_incl_tax,
  currency DEFAULT 'CNY', remark, raw_xml, created_at
)
invoice_items(
  id, invoice_id (FK cascade), ord,
  item_name, spec, unit, quantity, unit_price, amount, tax_rate, tax_amount
)
```

索引：`email_id`、`issue_date DESC`、`invoice_id`。

### 解析器

`workers/lib/invoice-parser.ts` — 零依赖正则 tokeniser（Workers 没有 DOMParser）。核心设计：

- 每个字段提供**多个候选 tag 名**（不同 ERP / 数电票版本命名不一）
- 数字字段用 `Number()` + `Number.isFinite()` 校验，失败 null
- 行项目定位 `<Spxx>` / `<DetailList>` / `<XmInfo>` 容器，循环子节点
- 找不到 `Fphm` / `invoice_number` → 返回 null（非发票）
- 保留 `raw_xml` 做审计

### DO RPC 方法

`workers/durableObject/index.ts`：

- `saveInvoice(emailId, attachmentId, parsed, opts?)` — `transactionSync` 批量写 invoices + items
- `getInvoice(invoiceId)` — header + items
- `listInvoices(filters?)` — 支持 `dateFrom/dateTo/sellerContains/buyerContains/minAmount/maxAmount/invoiceNumber/page/limit`
- `deleteInvoice(invoiceId)`

### Pipeline 接入

`workers/index.ts:receiveEmail` 在附件持久化 **之后**、`shouldDraft` 早返回 **之前** 调用 pipeline。`workers/lib/rules.ts` 的 `RuleActionSchema` 新增 `extractInvoice: boolean`。

### MCP 工具

`list_invoices` / `get_invoice` / `delete_invoice` / `reprocess_invoices_for_email`。

---

## 七、Phase 1b — 数电票 schema 补丁

`3b19533` — 首封真发票邮件解析返回 null。诊断：原候选名单覆盖的是增值税旧 schema（Fphm / Kprq），数电票用 `InvoiceNumber` / `IssueTime` / `SellerIdNum` 等。

**改动**：HEADER_FIELDS 每个字段追加数电票候选名。并新增 `reprocess_invoices_for_email` MCP 工具，用于历史邮件补提取。

---

## 八、Phase 2 — 多源适配（ZIP / OFD / 外链）

### 背景：4 封真实邮件实测

| 邮件 | 来源 | 附件 | Phase 1 结果 |
|------|-----|------|--------------|
| 御灶苍灵 707.20 | 票通 | png + pdf + ofd + **xml** | ✅ |
| 麦当劳 95.00 | 票通系列 | + xml | ✅ |
| 12306 D663 228.00 | rails.com.cn | **`.zip`**（含 ofd + pdf，**无 xml**） | ❌ |
| 花和尚 546.50 | 广东税务局 gdfapiao.com | **空**（正文 3 个外链） | ❌ |

成功率 2/4。两个新阻塞模式 → **B1 ZIP 容器** / **B2 外链下载**。

### 架构：统一 attachments 表 + 多源提取链

`attachments` 表加三列（Migration 10）：

```sql
origin TEXT NOT NULL DEFAULT 'email'     -- 'email' | 'unpacked' | 'external-url' | 'manual-upload'
source_url TEXT
parent_attachment_id TEXT                -- 自引用 FK
```

这让同一张发票相关的所有文件（原附件 → 解包产物 → 外链下载）组成一棵树。

### 新建模块

| 文件 | 职责 |
|------|------|
| `workers/lib/invoice-link-scanner.ts` | 扫正文 HTML 找下载链接 + 启发式判 kind（XML/PDF/OFD） + 域名白名单过滤 |
| `workers/lib/invoice-fetch.ts` | 白名单域 HTTP 下载：10s 超时 · 5MB 上限 · content-type 白名单 · 最多 3 跳重定向 · 防 SSRF |
| `workers/lib/invoice-source-extractors.ts` | `extractFromUnit` 递归处理 ZIP/OFD/XML；**`detectKind` 先看 magic bytes 再看扩展名**（广东 dppt 会把 ZIP 塞 `.xml` 后缀） |
| `workers/lib/invoice-pipeline.ts` | `processEmailForInvoices` 共享编排：entry units + body link scan + 递归 childRegistrar + dedup by invoice_number |

### 解析器扩展

`invoice-parser.ts` 加 XBRL `rai:*` 候选：

```
rai:electronicinvoicerailwayeticketnumber / rai:dateofissue / rai:issueparty
rai:totalamountexcludingtax / rai:taxamount / rai:fare / ...
```

`ITEM_CONTAINERS` 加 `issuiteminformation`（12306 行项目容器）。

### DO + Pipeline 解耦

`saveDerivedAttachment(emailId, args)` 新方法，由 pipeline 先把 bytes 写 R2（`attachments/<emailId>/<attId>/<filename>`），再登记行。

引入 `PipelineStub` 接口 —— DO 侧的 `reprocessInvoicesForEmail` 走 self-adapter，绕开 DO input-gate 自调用死锁：

```ts
const selfAdapter: PipelineStub = {
  listInvoices: (f) => this.listInvoices(f),
  saveInvoice: (...args) => this.saveInvoice(...args),
  saveDerivedAttachment: (...args) => this.saveDerivedAttachment(...args),
  findAttachmentById: (id) => this.findAttachmentById(id),
  listEmailAttachments: (id) => this.listEmailAttachments(id),
};
```

### 关键 bug 修复

1. **`detectKind` 扩展名优先导致 ZIP 被当 XML 解析** → magic bytes (`PK\x03\x04`) 优先
2. **`Doc_*/Attachs` 在 JSDoc 里撞 comment-close** → 改写为 `Doc_N/Attachs`
3. **`@ts-expect-error` stale** → 删掉 `workers/lib/ai.ts` 里的过期 directive

---

## 九、Phase 3 — PDF OCR 兜底

`cfa58de` · `edd21fe` — 当邮件只拿到 PDF（外链 XML 过期 / sender 只发 PDF）时，走 DeepRead 异步 OCR。

### 新建

- `workers/lib/deepread.ts` — DeepRead API client：`submitOcr(pdfBytes, schema)` → `getJob(id)` → `submitAndWait`
- `workers/lib/invoice-ocr.ts` — `CHINA_INVOICE_OCR_SCHEMA`（JSON Schema + 字段描述） + `ocrResultToParsedInvoice` 把 DeepRead 带 `hil_flag` 的结果摊平成 `ParsedInvoice`，并把"任一字段 hil_flag=true" 汇总到 `needs_review` 上

### Schema 扩展（Migration 11）

```sql
ALTER TABLE invoices ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'xml';
ALTER TABLE invoices ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
```

`source_kind ∈ { 'xml', 'pdf-ocr', 'manual-upload' }`；UI 列表 / 详情对 `pdf-ocr` 显示橙色 badge，`needs_review=true` 显示 ⚠️ "待复核"。

### MCP 工具

`extract_invoice_from_pdf` —— 外部 agent 显式点名让某封邮件的 PDF 附件走 OCR，用于 pipeline 跳过（没 XML / OFD 时）的手动兜底。

### 修复

- DeepRead 返回字段是 `id` 不是 `job_id` → 兼容两者
- Free-tier 排队抖动 → poll 超时 90s → **180s**
- OCR 对长数字偶发少位（实测 19 位发票号首次少 1 位，二次正确） → 入库后标 `needs_review`，用户可在 UI 看到警告

---

## 十、Phase 4 — 前端 UI + 人工上传兜底 + 徽章

### 4a · 管理 UI（`6b76f71`）

**新路由**：

| 路由 | 文件 | 功能 |
|------|------|------|
| `/mailbox/:mailboxId/invoices` | `app/routes/invoices.tsx` | 列表 + 筛选（date / seller / buyer / amount / needs_review toggle） + Kumo Pagination |
| `/mailbox/:mailboxId/invoices/:invoiceId` | `app/routes/invoice-detail.tsx` | 头字段 + 明细行 + 附件树（递归展开 `parent_attachment_id`） |

**新查询层**：`app/queries/invoices.ts` — `useInvoices` · `useInvoice` · `useDeleteInvoice` · `useUploadInvoiceFile` · `useInvoicesIndexByEmail` · `useInvoicesForEmail` + `fileToBase64` 工具函数。

**导航**：`Sidebar.tsx` 新增"发票" 入口（ReceiptIcon）。

### 4b · 人工上传兜底（`6b76f71`）

百望 u.baiwang.com 场景 —— 邮件正文只是 SPA 预览短链，文件既不在附件也无法从链接下载（TTL token + SPA render）。属于"基础设施打死解不了"。

**方案**：在 email 详情加 `<InvoiceUploader>`，用户在浏览器里打开预览页、手动下载 XML/OFD/PDF/ZIP，然后拖到 inbox 里，走 `/mailbox/:id/emails/:emailId/invoice-file` POST 路由，走和 auto-pipeline 完全一致的入库链路，只是 `origin='manual-upload'`。

`workers/lib/invoice-manual-upload.ts` · `workers/mcp` `upload_invoice_file` 工具 · `app/components/email-panel/InvoiceUploader.tsx`。

### 4c · "已提取发票"徽章（`a540841`）

**`app/components/InvoiceBadge.tsx`** 两个导出：

- `InvoiceBadgeCompact` — 邮件列表行用的小徽章：`📄 发票` 或 `📄 发票 ×N`，任一 `needs_review` 时变 `warning`；点击跳详情（N=1）或过滤列表（N>1），`stopPropagation` 阻止行点击劫持
- `InvoiceBadgeCard` — 邮件详情顶部的大卡片：stack 每张发票，展示 number / issue_date / seller_name / ¥amount_incl_tax + PDF OCR / 待复核 badge

**接入点**：
- `app/routes/email-list.tsx` — `useInvoicesIndexByEmail` 拿索引，每行 `invoiceIndex.get(email.id)` 传给 Compact
- `app/components/email-panel/SingleMessageView.tsx` — `useInvoicesForEmail` 拿当前邮件发票，渲染 Card

---

## 十一、文件清单

### Workers 侧（共 9 个新文件）

```
workers/lib/
  invoice-parser.ts              — 零依赖 XML walker（数电票 + 增值税 + rai:* XBRL）
  invoice-link-scanner.ts        — 正文 HTML 扫下载链接
  invoice-fetch.ts               — 白名单 HTTP 下载（SSRF 防护）
  invoice-source-extractors.ts   — ZIP/OFD 递归解包（fflate）
  invoice-pipeline.ts            — 共享编排 + dedup
  invoice-ocr.ts                 — DeepRead OCR schema + 结果映射
  invoice-manual-upload.ts       — 人工上传入库
  deepread.ts                    — DeepRead API client
  tools.ts                       — MCP tool helpers（含所有 invoice 工具）
```

### Migrations

```
9_add_invoices_tables            — invoices + invoice_items
10_extend_attachments_origin     — origin / source_url / parent_attachment_id
11_add_invoice_source_kind       — source_kind + needs_review
```

### 前端侧

```
app/routes/
  invoices.tsx                   — 列表
  invoice-detail.tsx             — 详情
app/components/
  InvoiceBadge.tsx               — 徽章 + 详情卡片（共享）
  email-panel/InvoiceUploader.tsx — 人工上传
  Sidebar.tsx                    — +发票导航
app/queries/invoices.ts          — hooks + helpers
app/services/api.ts              — invoice HTTP client
app/types/index.ts               — Invoice / Item / Filters / Response
```

---

## 十二、MCP 工具清单（invoice 相关）

| 工具 | 用途 |
|------|-----|
| `list_invoices` | 按筛选列发票，agent 做对账 / 查询 |
| `get_invoice` | 拿单张发票 header + items |
| `delete_invoice` | 删除（cascade items） |
| `reprocess_invoices_for_email` | 对已存邮件重跑 pipeline（历史补提取 / schema 变更后回填） |
| `extract_invoice_from_pdf` | 显式对某封邮件的 PDF 跑 OCR |
| `upload_invoice_file` | 人工上传 XML/OFD/PDF/ZIP 入库 |

---

## 十三、实测验证

| 邮件 | 场景 | 结果 |
|------|------|------|
| 御灶苍灵 707.20 | XML 附件 | ✅ Phase 1 自动入库 |
| 麦当劳 95.00 | XML 附件 | ✅ Phase 1 自动入库 |
| 12306 D663 228.00 | ZIP > OFD > XBRL XML（`rai:*`） | ✅ Phase 2 reprocess 入库 |
| 花和尚 546.50 | 正文外链 → 广东 dppt ZIP-as-.xml | ✅ Phase 2 reprocess 入库 |
| 百望 SPA 预览 | 无附件 + SPA 短链（TTL） | ✅ Phase 4b 人工上传入库 |
| 某 PDF-only 邮件 | 无 XML/OFD，仅 PDF | ✅ Phase 3 OCR 入库（`needs_review=true`，首次长数字少 1 位） |

---

## 十四、已知风险 / 技术债

1. **OCR 长数字不稳**：DeepRead 对 19 位发票号偶发截断，已靠 `needs_review` 在 UI 告警，但没做字段级重跑。
2. **域名白名单硬编码**：`INVOICE_SOURCE_DOMAINS` 写在代码常量，新增税务 / 票务域要发版。后续搬到 mailbox settings。
3. **外链过期**：百望 / 广东 dppt 的下载 URL 含时间戳 token；邮件到达即下载（已做），过期后没有自动请求 sender 重发的回路。
4. **无跨 mailbox 聚合**：目前每个 DO 各管各的发票；全组织对账需要 D1 镜像 + admin MCP 工具（未做）。
5. **无 CSV/Excel 导出**：做账场景最常被问，UI 上还没有 export 按钮。
6. **AI slop 验证盲区**：`ai.ts` 里删掉的 stale `@ts-expect-error` 是巡检出来的 —— 现在没有定期回扫 stale suppression 的自动化。

---

## 十五、候选下一步

（等用户拍板）

- **CSV / Excel 导出** —— 对账高频诉求
- **邮件列表筛选"有未入库发票但邮件无附件/外链"** —— 提示需要手动上传的邮件
- **Agent 新增触发器** —— 发票邮件如果最终没入库任何 invoice，起草一封"需要手动处理"的自我提醒邮件（`skipDraft: true` 可被这条特殊规则覆盖）
- **多 mailbox 聚合（D1）** —— 跨收件箱对账
- **DeepRead Blueprint 优化** —— 用 4+ 样本喂 DeepRead optimizer，做个发票专用 blueprint，替代当前 schema，降低 OCR 误差
- **PDF/OFD 浏览器预览** —— 发票详情里直接看原件

---

## 附录 A · Phase 1–4 Commit 时间线

```
a540841 feat(invoices): "已提取发票" badge on email list + detail
6b76f71 feat(invoices): management UI + manual-upload fallback
edd21fe fix(deepread): accept `id` field + bump poll timeout to 180s
cfa58de feat(invoices): PDF OCR via DeepRead as last-resort field source
3b715a3 feat(invoices): multi-source extraction — ZIP/OFD + external URL download
3b19533 fix(invoices): support 数电票 (fully-digital e-invoice) schema + add reprocess tool
93f0cdd feat(invoices): structured Chinese e-invoice extraction + persistence
ec4a95e feat(auth): accept Cloudflare Access service tokens
b04f882 feat(mcp): expose new backend capabilities as MCP tools
```
