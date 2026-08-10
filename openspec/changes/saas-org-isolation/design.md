## Context

当前架构使用全局用户空间 + per-mailbox ACL 模型。`users` 表在 D1 中是全局的，email 唯一。每个 mailbox 是一个独立的 Durable Object（DO），数据物理隔离。ACL 通过 D1 的 `mailboxes`（owner）和 `mailbox_members` 表维护。

存在一个 admin 管理的 `team` 模型（`teams`/`teamUsers`/`address_registry`），用于分配邮箱地址给团队。`teamUsers` 表有 unique index 在 `userId` 上，意味着一个用户只能属于一个 team。这不是真正的多租户隔离。

DO 级别的数据已经是完美隔离的——每个 mailbox 有自己的 SQLite 数据库，不需要改动。改造仅涉及 D1 控制平面。

## Goals / Non-Goals

**Goals:**
- 引入 Organization 作为顶层租户边界
- 用户可属于多个 org（M:N 关系）
- org 内支持 owner/admin/member 三级角色
- org 内保持 per-mailbox ACL（不改为全员共享）
- 现有 team 数据自动迁移为 org
- 自助创建 org（不再仅限 admin）
- 渐进式 rollout（功能开关控制）

**Non-Goals:**
- 不修改 Durable Object 内部代码（DO 数据已隔离）
- 不改 LLM Provider 管理模型（保持全局共享）
- 不删除 team 表（冻结为只读，未来清理）
- 不支持 org 之间的数据共享或跨 org 访问
- 不改 inbound email 路由逻辑（地址解析保持独立）

## Decisions

### Decision 1: Org 上下文存储在 session 中，而非独立 cookie
**选择**: 在 `AuthUser` 中动态注入 `orgId`/`orgRole`，通过 `POST /api/v1/orgs/switch` 端点切换。
**理由**: 
- 服务端权威——org 上下文在服务端解析，客户端无法伪造
- 无需改 session 表结构
- 切换后立即生效，无需等待 cookie 传播
**替代方案**: 独立 `aix_org` cookie。拒绝原因：cookie 可能被篡改，需要额外验证层。

### Decision 2: 保留 per-mailbox ACL，不在 org 级别做全员共享
**选择**: org 成员不自动访问所有 org mailbox，仍需通过 owner/member ACL 授权。org owner/admin 可以访问任何 org mailbox。
**理由**:
- 保持现有安全粒度，不扩大攻击面
- 与现有 `mailbox_members` 机制兼容，无需重构
- org 仅作为顶层容器和邀请边界
**替代方案**: 全员共享（任何 org member 自动访问所有 org mailbox）。拒绝原因：粒度太粗，不适合可能包含敏感邮件的场景。

### Decision 3: 迁移 team 数据为 org，而非废弃后重建
**选择**: 一次性 SQL 迁移脚本将 `teams`/`teamUsers`/`address_registry` 数据迁移到新的 `orgs`/`org_members`/`org_mailboxes` 表。
**理由**:
- 用户无感知过渡
- team 表的 `disabledAt` 软删除模式与 org 兼容
- 保留数据连续性
**替代方案**: 废弃 team，用户手动重建 org。拒绝原因：运营中断，用户体验差。

### Decision 4: `ORG_MODE_ENABLED` 功能开关控制 org 逻辑
**选择**: 在 auth 层和 API 路由层增加开关检查，关闭时完全走现有逻辑。
**理由**:
- 支持渐进式 rollout，出现问题可即时回退
- 测试环境可独立控制
- 降低部署风险

### Decision 5: 不在 sessions 表中增加 `active_org_id` 列
**选择**: 通过 `resolveActiveOrg()` 函数动态解析：优先从请求 header 读取，fallback 到 `users.default_org_id`。
**理由**:
- 避免改 session 表结构
- 支持用户在不同设备上选择不同活跃 org
- 减少 migration 复杂度
**替代方案**: sessions 表加列。拒绝原因：增加了 migration 和 rollback 复杂度，收益有限。

## Risks / Trade-offs

**[Risk] 数据迁移失败导致 mailbox 无法访问**
→ Mitigation: 所有迁移是 additive（新表 + nullable 列）。原 team 表保留。迁移脚本在 staging 环境预跑，生成校验报告。rollback 只需关闭 `ORG_MODE_ENABLED`。

**[Risk] 跨 org 数据泄露**
→ Mitigation: `assertMailboxAccess` 增加 org 维度检查。org 外的成员即使知道 mailboxId 也无法访问。集成测试覆盖跨 org 访问场景。

**[Risk] 前端 org 切换导致状态不一致**
→ Mitigation: 切换 org 后执行 `window.location.reload()`，强制所有 React Query cache 重新加载。不使用局部状态更新避免遗漏。

**[Risk] 用户属于多个 org 时的默认 org 选择困惑**
→ Mitigation: `resolveActiveOrg()` 使用最近访问的 org（从 UI 传递的 header）> `users.default_org_id` > 第一个 org。用户可通过 OrgSwitcher 显式切换。

**[Trade-off] Org owner/admin 自动访问所有 org mailbox**
→ 牺牲了部分粒度换取管理便利性。org owner 是可信角色，与 SaaS 平台管理员等同。

## Migration Plan

1. **Pre-migration** (Day 1):
   - 部署 Phase 1 schema migration（新表 + nullable 列）
   - 验证 `ORG_MODE_ENABLED=false` 时零影响

2. **Data Migration** (Day 2):
   - 运行 `scripts/migrate-to-orgs.sql` 将 team 数据迁移到 org
   - 运行 `scripts/migrate-to-orgs.ts` 处理需要 UUID 生成的逻辑（无主 mailbox 的个人 org）
   - 验证：所有 mailbox 都有 org_id，所有用户都有 default_org_id

3. **Feature Enable** (Day 3):
   - 部署 Phase 2-4 代码（后端 API + 前端 UI）
   - 开启 `ORG_MODE_ENABLED=true`
   - 监控错误率和 API 响应时间

4. **Rollback** (如需):
   - 设置 `ORG_MODE_ENABLED=false`
   - 回退代码到上一版本
   - 新表数据保留（不影响现有逻辑）

## Open Questions

1. **Org slug 是否需要全局唯一？** 建议全局唯一（像 GitHub org name），便于 URL 路由和标识。但需要考虑现有 team slug 冲突。
2. **个人用户（不属于任何 org）的体验？** 方案：为每个无主用户自动创建 "Personal" org，或者保持无 org 状态（home 页面显示创建 org CTA）。当前 plan 选择前者（迁移脚本自动创建）。
3. **Org 删除后 mailbox 怎么处理？** 方案：org 软删除（`disabledAt`），mailbox 保持可用但归属到 owner 个人。
