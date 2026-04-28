# Second-Wave Architecture Checklist

Updated: 2026-04-29

## Goal

Retire R2 as a control-plane store. After second-wave, the
`mailboxes/${id}.json` omnibus blob no longer participates in authorization,
agent configuration, or rules persistence. R2 keeps its architectural role —
attachment bytes, exports, and large artifacts only — per
[`foundation-architecture.md`](./foundation-architecture.md) Principle 5.

Spec: `.omc/specs/deep-interview-second-wave.md` (deep-interview ambiguity
score 16.55%, threshold 20%).

## Done

| PR | Title | Commit |
| --- | --- | --- |
| #20 | Rules R2 path retirement | `0736af8` |
| #21 | Agent settings R2 dual-write retirement | `b8f3493` |
| #22 | ACL R2 self-heal retirement | `08742fd` |
| #23 | Vitest infrastructure + initial pure-function suite | `30b4751` |

### PR #20 — Rules R2 path retirement

- Removed `RULES_SOURCE` flag and `getRulesSource` from `workers/lib/rules-store.ts`.
- Removed R2 read/write branches from `listRules`, `loadRulesForEvaluation`, `replaceRules`, `getRuleHistory`, `mirrorLegacyRulesToD1`.
- Kept `backfillFromR2IfEmpty` as a one-shot lazy backfill so deployments upgrading across the cutover do not drop pre-existing rules.
- Removed `RULES_SOURCE` from `wrangler.jsonc` vars and the comment in `workers/types.ts`.

### PR #21 — Agent settings R2 dual-write retirement

- `getAgentConfig` reads MailboxDO only. On a missing row it returns env defaults — no more R2 self-heal branch.
- Deleted dead helpers: `buildAgentConfigFromR2`, `r2SettingsToDoInput`, `stringArrayOrNull`, `setRules`, `readSettings`, `writeSettings`, `settingsKey`.
- MCP `set_rules` now routes through `replaceRules` from `rules-store` (D1 path) with actor sourced from the authenticated MCP user.

### PR #22 — ACL R2 self-heal retirement

- `getMailboxAcl` reads D1 only. Missing record → null. No more resurrection from R2.
- `claimMailbox`, `setMailboxOwner`, `addMailboxMember`, `removeMailboxMember` route exclusively through `mailbox-directory` helpers.
- `listUserMailboxes` privileged path drops the `BUCKET.list` stale-detection scan; D1 is authoritative.
- Pre-merge prerequisite documented: run `POST /api/v1/admin/mailbox-directory/backfill` and confirm `errors: []`.

### PR #23 — Vitest infrastructure + initial pure-function suite

- Added `vitest` devDependency, `vitest.config.ts`, `npm test` and `npm run test:watch` scripts.
- 11 passing pure-function tests in `tests/`:
  - `auth-context.test.ts` — envelope round-trip, cross-secret rejection, email casing normalization.
  - `agent-config-helpers.test.ts` — `AGENT_CONFIG_FIELDS` invariants, `agentSettingsPatchFromRaw` trimming and skill filtering, `mailboxSettingsRowToR2Shape` null-omission semantics.

## Out of scope (deferred to future waves)

- **Non-agent settings fields** (`fromName`, `forwarding`, `signature`, `autoReply`) continue to live in the R2 omnibus blob and are read/written by `workers/index.ts` and `workers/mcp/index.ts`. Not in the user-defined second-wave scope.
- **Vitest integration tests** requiring `@cloudflare/vitest-pool-workers` and miniflare bindings:
  - mailbox-directory dual-write strict-mode error propagation
  - rules-store D1 round-trip via MailboxDO RPC
  - agent-config DO read/write round-trip
  - `getMailboxAcl` returns null on missing D1 row
- **R2 omnibus blob cleanup**: an admin tool to delete the `mailboxes/${id}.json` blobs once non-agent fields move to MailboxDO.
- **Audit event writer** (Workstream E from `foundation-architecture.md`).
- **Capability scope enforcement / API-key restrictions** (Workstream C).
- **Skill packs** (Workstream F).
- **Background queues / workflows** (Workstream D).

## Open follow-ups

- Migrate the remaining non-agent settings fields (`fromName`, `forwarding`, `signature`, `autoReply`) into MailboxDO. After this lands, the R2 omnibus blob can be deleted entirely and `workers/index.ts` / `workers/mcp/index.ts` settings handlers can drop their R2 code paths.
- Layer `@cloudflare/vitest-pool-workers` on top of the existing config and add the four deferred integration tests listed above.
- Wire `npm test` into CI so subsequent PRs cannot regress the suite.
