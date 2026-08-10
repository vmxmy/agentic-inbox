## Why

当前架构使用全局用户空间 + per-mailbox ACL 模型，缺乏顶层租户边界。已有的 `team` 模型仅用于 admin 分配邮箱地址，一个用户只能属于一个 team，无法实现真正的 SaaS 式多租户隔离。为了支持用户自助创建组织、多组织成员身份、以及组织级数据隔离，需要引入 Organization 作为顶层租户边界。

## What Changes

- **新增 Organization 控制平面**：`orgs`、`org_members`、`org_invites`、`org_mailboxes` 表，支持用户属于多个 org，org 内支持 owner/admin/member 角色
- **新增 Org API**：自助创建 org、成员邀请/接受/移除、角色管理、org 切换、org 内 mailbox 管理
- **扩展 Auth 层**：`AuthUser` 增加 `orgId` 和 `orgRole`，identity middleware 解析活跃 org 上下文
- **增强 Mailbox ACL**：`assertMailboxAccess` 增加 org 维度检查 — org 成员可访问 org mailbox，org owner/admin 自动获得访问权
- **现有 Team 模型迁移为 Org**：`teams` / `teamUsers` / `address_registry` 数据自动迁移到 org 表，team 表冻结为只读
- **前端 Org UI**：Header 增加 Org Switcher、新增 org 创建/设置/成员管理页面、home 页面按 org 分组显示 mailbox
- **功能开关**：`ORG_MODE_ENABLED` 环境变量控制 org 逻辑启用，支持渐进式 rollout

## Capabilities

### New Capabilities
- `org-management`: Org 生命周期管理（创建、更新、禁用、删除）及基本信息维护
- `org-membership`: Org 成员管理（邀请、接受、移除、角色变更）及权限控制
- `org-mailbox-association`: Mailbox 与 Org 的关联管理，org 内 mailbox 的创建和列举
- `org-context`: 活跃 Org 上下文解析、切换、以及在请求生命周期中的传递

### Modified Capabilities
- `admin-console`: Admin 控制台增加 org 管理视角，现有 team 管理标记为 deprecated
- `multi-inbox-runtime`: Inbox 列表和加载增加 org 过滤维度，用户只能看到所属 org 的 mailbox

## Impact

- **D1 Schema**: 新增 4 张表，2 张现有表增加 nullable 列
- **Backend API**: 新增 `workers/routes/orgs.ts`（~13 个端点），修改 `whoami`、`mailboxes` 等现有端点
- **Auth Layer**: `workers/lib/auth.ts`、`workers/app.ts` 增加 org 解析逻辑
- **Frontend**: 新增 4 个路由页面、1 个组件、1 个 query hooks 文件
- **Migration**: 现有 team 数据需一次性迁移到 org 模型
- **Backward Compatibility**: 所有 schema 变更 additive，team 表不删除，功能开关可回退
