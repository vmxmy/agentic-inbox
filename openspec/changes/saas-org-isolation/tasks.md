## 1. Schema & Migration

- [ ] 1.1 Create `workers/db/org-schema.ts` with `orgs`, `org_members`, `org_invites`, `org_mailboxes` tables
- [ ] 1.2 Add `default_org_id` to `users` table in `workers/db/auth-schema.ts`
- [ ] 1.3 Add `org_id` to `mailboxes` table in `workers/db/mailbox-schema.ts` with index
- [ ] 1.4 Create D1 migration `migrations/0007_org_isolation.sql`
- [ ] 1.5 Run migration in local dev environment and verify schema

## 2. Org Auth Layer

- [ ] 2.1 Create `workers/lib/org-auth.ts` with `requireOrgAccess`, `requireOrgAdmin`, `requireOrgOwner`
- [ ] 2.2 Implement `getOrgMemberRole`, `listUserOrgs`, `resolveActiveOrg` in `workers/lib/org-auth.ts`
- [ ] 2.3 Extend `AuthUser` interface in `workers/lib/auth.ts` with `orgId` and `orgRole`
- [ ] 2.4 Extend `InternalAuthClaims` in `workers/lib/auth.ts` with org fields
- [ ] 2.5 Update `serializeInternalAuthContext` / `parseInternalAuthContext` to include org claims
- [ ] 2.6 Write unit tests for org-auth helpers

## 3. Identity Middleware & Auth Integration

- [ ] 3.1 Update `workers/app.ts` identity middleware to resolve active org after user auth
- [ ] 3.2 Add `ORG_MODE_ENABLED` feature flag check in auth layer
- [ ] 3.3 Update `assertMailboxAccess` in `workers/lib/auth.ts` to check org membership
- [ ] 3.4 Update `assertMailboxOwner` to grant org owner/admin automatic ownership
- [ ] 3.5 Update `listUserMailboxes` to include org-associated mailboxes
- [ ] 3.6 Update `whoami` endpoint to return `orgs`, `activeOrgId`, `activeOrgRole`

## 4. Org API Routes

- [ ] 4.1 Create `workers/routes/orgs.ts` with Hono sub-router
- [ ] 4.2 Implement `POST /api/v1/orgs` (create org)
- [ ] 4.3 Implement `GET /api/v1/orgs` (list user orgs)
- [ ] 4.4 Implement `GET /api/v1/orgs/:orgId` (get org details)
- [ ] 4.5 Implement `PUT /api/v1/orgs/:orgId` (update org)
- [ ] 4.6 Implement `DELETE /api/v1/orgs/:orgId` (disable org)
- [ ] 4.7 Implement `GET /api/v1/orgs/:orgId/members` (list members)
- [ ] 4.8 Implement `POST /api/v1/orgs/:orgId/members` (invite member)
- [ ] 4.9 Implement `DELETE /api/v1/orgs/:orgId/members/:userId` (remove member)
- [ ] 4.10 Implement `PUT /api/v1/orgs/:orgId/members/:userId/role` (change role)
- [ ] 4.11 Implement `POST /api/v1/orgs/switch` (switch active org)
- [ ] 4.12 Implement `POST /api/v1/org-invites/accept` (accept invite)
- [ ] 4.13 Mount org routes in `workers/index.ts`
- [ ] 4.14 Update `POST /api/v1/mailboxes` to allow org admin/owner creation

## 5. Data Migration

- [ ] 5.1 Write `scripts/migrate-to-orgs.sql` for team-to-org data migration
- [ ] 5.2 Write `scripts/migrate-to-orgs.ts` for application-layer migration (personal orgs for legacy users)
- [ ] 5.3 Test migration script on staging database
- [ ] 5.4 Verify all mailboxes have org_id, all users have default_org_id
- [ ] 5.5 Write migration rollback script

## 6. Frontend API & Types

- [ ] 6.1 Add `Org`, `OrgMember`, `OrgInvite` types to frontend
- [ ] 6.2 Add org API methods to `app/services/api.ts`
- [ ] 6.3 Update `whoami` return type in `app/services/api.ts`
- [ ] 6.4 Create `app/queries/orgs.ts` with `useOrgs`, `useOrg`, `useCreateOrg`, `useSwitchOrg`
- [ ] 6.5 Add org query keys to `app/queries/keys.ts`

## 7. Frontend UI Components

- [ ] 7.1 Create `app/components/OrgSwitcher.tsx` with dropdown and create-org link
- [ ] 7.2 Integrate `OrgSwitcher` into `app/components/Header.tsx`
- [ ] 7.3 Update `app/routes/home.tsx` for org-aware mailbox listing
- [ ] 7.4 Create `app/routes/orgs.new.tsx` for self-service org creation
- [ ] 7.5 Create `app/routes/org.detail.tsx` for org layout
- [ ] 7.6 Create `app/routes/org.members.tsx` for member management
- [ ] 7.7 Create `app/routes/org.settings.tsx` for org settings
- [ ] 7.8 Add org routes to `app/routes.ts`
- [ ] 7.9 Update `app/routes/settings.tsx` members tab with org context

## 8. Admin Console Updates

- [ ] 8.1 Add `/admin/orgs` route to admin console
- [ ] 8.2 Create admin org list page with disable action
- [ ] 8.3 Mark `/admin/teams` as deprecated with banner
- [ ] 8.4 Update admin overview metrics from teams to orgs
- [ ] 8.5 Add org management to admin sidebar

## 9. Integration & Testing

- [ ] 9.1 Write integration tests for org CRUD endpoints
- [ ] 9.2 Write tests for org invite/accept flow
- [ ] 9.3 Write tests for org-scoped mailbox access (cross-org access blocked)
- [ ] 9.4 Write tests for org role permissions (owner/admin/member)
- [ ] 9.5 Test `ORG_MODE_ENABLED=false` backward compatibility
- [ ] 9.6 Run full test suite and fix regressions

## 10. Rollout & Cleanup

- [ ] 10.1 Add `ORG_MODE_ENABLED` to `wrangler.jsonc`
- [ ] 10.2 Deploy to staging with `ORG_MODE_ENABLED=false`
- [ ] 10.3 Run data migration on staging
- [ ] 10.4 Enable `ORG_MODE_ENABLED=true` on staging for smoke testing
- [ ] 10.5 Deploy to production with `ORG_MODE_ENABLED=false`
- [ ] 10.6 Run data migration on production
- [ ] 10.7 Enable `ORG_MODE_ENABLED=true` on production
- [ ] 10.8 Monitor for 48 hours, ready to disable if issues
