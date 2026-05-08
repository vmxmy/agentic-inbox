# add-user-owned-ai-inbox-creation

Refine the existing arbitrary mailbox creation flow into product-facing
user-owned AI inbox creation.

Current baseline already has:

- home-page mailbox creation
- `POST /api/v1/mailboxes`
- R2 mailbox settings at `mailboxes/<email>.json`
- InboxProfile metadata
- MailboxDO storage keyed by full email address
- centralized inbound resolution

This change adds the missing product constraints:

- verified Cloudflare Access identity -> stable username
- user enters only `displayName` + `subname`
- server derives `username.subname@root-domain`
- R2 stores user-owned inbox metadata additively
- frontend says AI Inbox, not arbitrary mailbox
