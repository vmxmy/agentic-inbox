// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import * as React from "react";
import type { Attachment } from "~/types";
import { getAttachmentUrl } from "~/lib/utils";

function prettyPrintXml(s: string): string {
	let indent = 0;
	return s
		.replace(/>\s*</g, "><")
		.replace(/(<\/?[^>]+>)/g, (tag) => {
			if (tag.startsWith("</")) {
				indent = Math.max(0, indent - 1);
				return `\n${"  ".repeat(indent)}${tag}`;
			}
			const line = `\n${"  ".repeat(indent)}${tag}`;
			if (!tag.endsWith("/>") && !tag.startsWith("</")) indent++;
			return line;
		})
		.trim();
}

function isPdf(att: Attachment): boolean {
	return (
		att.mimetype === "application/pdf" ||
		att.filename.toLowerCase().endsWith(".pdf")
	);
}

function isXml(att: Attachment): boolean {
	return (
		att.mimetype === "application/xml" ||
		att.mimetype === "text/xml" ||
		att.filename.toLowerCase().endsWith(".xml")
	);
}

function isOfd(att: Attachment): boolean {
	return (
		att.mimetype.includes("ofd") ||
		att.filename.toLowerCase().endsWith(".ofd")
	);
}

export function InvoicePreview({
	related,
	mailboxId,
	emailId,
	rawXml,
}: {
	related: Attachment[];
	mailboxId: string;
	emailId: string;
	rawXml?: string | null;
}) {
	const pdfs = related.filter(isPdf);
	const xmlAtts = related.filter(isXml);
	const ofds = related.filter(isOfd);

	const hasContent = pdfs.length > 0 || xmlAtts.length > 0 || ofds.length > 0 ||
		(rawXml && rawXml.trim().startsWith("<"));

	if (!hasContent) return null;

	return (
		<section>
			<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-kumo-subtle">
				文件预览
			</h2>
			<div className="space-y-4">
				{pdfs.map((att) => (
					<div key={att.id}>
						<p className="mb-1 text-xs text-kumo-subtle font-mono">{att.filename}</p>
						<embed
							src={getAttachmentUrl(mailboxId, emailId, att.id)}
							type="application/pdf"
							className="w-full h-[600px] border border-kumo-default rounded"
						/>
					</div>
				))}

				{xmlAtts.map((att) => (
					<div key={att.id}>
						<p className="mb-1 text-xs text-kumo-subtle font-mono">{att.filename}</p>
						<XmlFetchPreview
							url={getAttachmentUrl(mailboxId, emailId, att.id)}
						/>
					</div>
				))}

				{!xmlAtts.length && rawXml && rawXml.trim().startsWith("<") && (
					<div>
						<p className="mb-1 text-xs text-kumo-subtle">原始 XML</p>
						<pre className="overflow-auto rounded border border-kumo-default bg-kumo-muted p-3 text-xs font-mono whitespace-pre max-h-[400px]">
							{prettyPrintXml(rawXml)}
						</pre>
					</div>
				)}

				{ofds.map((att) => (
					<div key={att.id} className="rounded border border-kumo-default bg-kumo-muted p-3 text-sm text-kumo-subtle">
						<span className="font-mono text-xs">{att.filename}</span>
						{" — "}OFD 暂不支持浏览器预览，请下载查看。
					</div>
				))}
			</div>
		</section>
	);
}

function XmlFetchPreview({ url }: { url: string }) {
	const [content, setContent] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string | null>(null);

	React.useEffect(() => {
		let cancelled = false;
		fetch(url)
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.text();
			})
			.then((text) => {
				if (!cancelled) setContent(prettyPrintXml(text));
			})
			.catch((e) => {
				if (!cancelled) setError((e as Error).message);
			});
		return () => { cancelled = true; };
	}, [url]);

	if (error) {
		return (
			<div className="rounded border border-kumo-default bg-kumo-muted p-3 text-xs text-kumo-subtle">
				加载失败：{error}
			</div>
		);
	}
	if (content === null) {
		return (
			<div className="rounded border border-kumo-default bg-kumo-muted p-3 text-xs text-kumo-subtle">
				加载中…
			</div>
		);
	}
	return (
		<pre className="overflow-auto rounded border border-kumo-default bg-kumo-muted p-3 text-xs font-mono whitespace-pre max-h-[400px]">
			{content}
		</pre>
	);
}
