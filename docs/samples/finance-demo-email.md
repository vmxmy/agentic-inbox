# Demo Finance Email

Use this as a safe template for a local or staging `finance@` demo. The XML file
is demo-only sample data and is not a legal tax invoice.

- To: `finance@yourdomain.com`
- From: `billing@example-vendor.test`
- Subject: `Invoice DEMO-2026-0001 for April services`
- Attachment: `docs/samples/finance-demo-invoice.xml`

Body:

```text
Hi finance team,

Please find attached invoice DEMO-2026-0001 for April services.
Let us know if you need a purchase order reference or a different billing
contact on the invoice.

Thanks,
Example Vendor Billing
```

Expected Agentic Inbox result:

1. The email thread is stored under the `finance@` mailbox.
2. The XML attachment is persisted as a mailbox artifact.
3. The invoice parser creates a structured invoice record.
4. The email row and detail panel can show an invoice badge.
5. A human can review the extracted fields and approve any follow-up draft.
