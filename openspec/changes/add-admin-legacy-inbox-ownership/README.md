# add-admin-legacy-inbox-ownership

Add an administrator-owned migration path that lets an admin assign owner
metadata to existing legacy inboxes. Once a legacy inbox has an explicit owner,
it enters the same user-owned configuration model as newly created AI inboxes,
including Agent / Tools / Safety settings.

This is a transition feature for the current R2-backed control plane. It should
not introduce non-Cloudflare infrastructure, and it should avoid destructive
mailbox or Durable Object migration.
