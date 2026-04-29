# Finance Workflow Demo

Updated: 2026-04-29

This guide is the user-facing demo path for the canonical Agentic Inbox
workflow: turn `finance@` from a shared email address into a durable,
reviewable invoice intake workspace.

Use it before reading the deeper architecture docs. The goal is comprehension:
a new user should understand how one invoice email moves through the system and
why the mailbox is the right place to run the workflow.

![Agentic Inbox finance workflow](assets/agentic-inbox-finance-workflow.svg)

## The 90-Second Story

A vendor sends an invoice to `finance@`.

In a normal shared inbox, the work immediately fragments: someone downloads the
attachment, maybe unzips an archive, copies fields into a spreadsheet, asks a
teammate to verify the total, and later searches the original thread when audit
or payment questions appear.

In Agentic Inbox, the email thread stays the durable workflow session. The
mailbox stores the original message, persists attachments and derived files as
artifacts, extracts structured invoice records, prepares follow-up drafts, and
keeps humans in control of sensitive outputs.

The product promise is not "the agent sends finance email for you." It is:

> The agent prepares invoice work; humans approve sensitive outputs; the system
> keeps source evidence attached to the mailbox workflow.

## Before And After

| Normal `finance@` inbox | Agentic Inbox `finance@` |
| --- | --- |
| Invoice context is split across emails, downloads, spreadsheets, and chat | The email thread is the durable workflow session |
| XML, OFD, PDF, ZIP, and vendor portal links are handled manually | Source files and derived artifacts are persisted in R2 and referenced from mailbox state |
| People copy invoice fields into separate tools | Deterministic parsers and OCR fallback create structured records |
| Low-confidence fields are easy to miss | OCR or uncertain results can be flagged for human review |
| Follow-up emails are copied from templates | The agent drafts clarification or missing-document replies for approval |
| Audit requires reconstructing what happened | Extracted fields link back to source email and attachment ids |
| External agents need broad mailbox credentials | MCP clients use scoped API keys and the same mailbox ACL |

## Demo Flow

### 1. Create Or Assign The Mailbox

Provision a mailbox such as `finance@yourdomain.com` and assign a mailbox owner.
The owner controls membership, skills, rules, and sensitive integrations for
that mailbox.

Fixed shared-mailbox deployments should configure addresses such as `finance@`,
`support@`, or `ops@` through the admin panel instead of letting each user claim
random addresses.

### 2. Send A Sample Invoice Email

Use a non-sensitive test invoice, or start from the sample files in this repo:

- sample email template: `docs/samples/finance-demo-email.md`
- demo XML attachment: `docs/samples/finance-demo-invoice.xml`

The sample XML is demo-only data, not a legal tax invoice. It exists to make the
narrative and parser path easier to test in local or staging environments.

A useful first email looks like this:

```text
To: finance@yourdomain.com
From: billing@example-vendor.test
Subject: Invoice DEMO-2026-0001 for April services
Attachment: finance-demo-invoice.xml
```

### 3. Let The Mailbox Persist The Session

When the message arrives through Cloudflare Email Routing, Agentic Inbox stores
it in the mailbox Durable Object. The thread becomes the durable session for
this piece of finance work.

The mailbox owns:

- message and thread metadata
- folders, labels, and read/star state
- draft replies
- invoice records and invoice items
- references to R2 attachment artifacts
- local workflow state

### 4. Persist Attachments As Artifacts

Invoice files are not throwaway model context. They are business artifacts.

Agentic Inbox persists source files and derived files so the workflow can be
replayed, audited, or manually inspected later. The invoice pipeline is designed
for real-world finance mail, including:

- direct XML invoice attachments
- OFD or PDF attachments
- ZIP files that contain invoice files
- external download links in email body HTML
- manual upload fallback when vendor portals require a browser

### 5. Extract Structured Invoice Records

The finance workflow prefers deterministic extraction before LLM interpretation.
For machine-readable invoices, parser code reads stable fields and writes
structured records. For PDF-only cases, OCR can be used as a fallback and risky
fields can require review.

The key product idea:

> The agent should query and explain invoice data; it should not hallucinate the
> invoice source of truth.

Expected records include:

- invoice number and type
- issue date
- seller and buyer identity
- amount before tax, tax, and total amount
- line items
- source attachment id
- review flags where needed

### 6. Review In The Inbox

The human-facing inbox remains the control room.

A finance member should be able to see which emails have extracted invoices,
open the invoice details, compare fields against the source attachment, and
review any flagged OCR or parser edge case.

The expected interaction model is conservative:

- extraction may run automatically after persistence
- uncertain outputs are visible instead of hidden
- replies are drafts by default
- sending, deletion, export, or external side effects need explicit authority

### 7. Ask The Agent For Prepared Work

Once the invoice record exists, the agent can help with mailbox-scoped tasks:

- summarize the invoice and thread history
- find related invoices from the same vendor
- draft a clarification email if a purchase order is missing
- prepare an approval checklist for the mailbox owner
- explain which source attachment produced a field

The agent operates through capabilities, not ambient database or integration
access.

### 8. Query Through MCP When Needed

External agent clients can connect to `/mcp` with a user-bound API key. They see
the same mailbox ACL and capability policy as the web app.

A finance-friendly MCP flow might be:

1. list visible mailboxes
2. select `finance@`
3. list invoices by date, seller, amount, or review state
4. fetch one invoice record with source links
5. draft a follow-up email for human review

MCP is not a bypass. It is the external facade for the same mailbox-scoped tool
layer.

## What To Verify In A Demo

Use this checklist when demoing a fresh deployment:

- [ ] `finance@` exists and has an owner.
- [ ] A sample invoice email arrives in the mailbox.
- [ ] The email detail view shows the original message and attachment.
- [ ] The attachment is persisted as an artifact.
- [ ] Invoice extraction creates a structured record.
- [ ] The email list or detail view indicates that an invoice was extracted.
- [ ] Invoice detail links back to the source email and attachment.
- [ ] Any uncertain OCR result is visible for human review.
- [ ] The agent can summarize the invoice and draft a follow-up.
- [ ] MCP can query invoice data without broader mailbox access.

## Trust Contract

Finance workflows need conservative authority.

Agentic Inbox should make these promises clear:

- The agent prepares work; humans approve sensitive outputs.
- External email content and attachments are untrusted inputs.
- Invoice fields should come from source files, not model guesses.
- Every extracted field should preserve provenance.
- Mailbox membership grants mailbox access, not unlimited integration power.
- MCP clients inherit mailbox ACL and capability policy.

## Where To Go Next

- Product framing: `docs/product-narrative.md`
- Technical foundation: `docs/foundation-architecture.md`
- Cloudflare agent infrastructure mapping: `docs/cloudflare-agentic-cloud-2026-guide.md`
- Skills, capabilities, and MCP extension model: `docs/agent-tool-extension-architecture.md`
- Current narrative assessment: `docs/product-narrative-completeness-report.md`
