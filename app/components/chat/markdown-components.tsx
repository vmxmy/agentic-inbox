// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Custom ReactMarkdown component renderers shared by the agent chat panels.
 *
 * The set covers everything a domain agent realistically emits — links,
 * paragraphs, lists, headings, inline code, GFM tables. Tables get explicit
 * overflow-x + border-collapse handling so wide invoice/email tables stay
 * readable inside the bubble's max-w-[85%] container.
 *
 * Imported via `<Markdown components={markdownComponents}>`.
 */

import type { Components } from "react-markdown";

export const markdownComponents: Components = {
	a: ({ href, children }) => (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			style={{
				color: "var(--color-link)",
				textDecoration: "underline",
			}}
		>
			{children}
		</a>
	),
	p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
	strong: ({ children }) => (
		<strong className="font-semibold">{children}</strong>
	),
	ul: ({ children }) => (
		<ul className="list-disc pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ul>
	),
	ol: ({ children }) => (
		<ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ol>
	),
	li: ({ children }) => <li>{children}</li>,
	h1: ({ children }) => (
		<h3 className="font-semibold text-sm mb-1">{children}</h3>
	),
	h2: ({ children }) => (
		<h4 className="font-semibold text-[13px] mb-1">{children}</h4>
	),
	h3: ({ children }) => (
		<h5 className="font-semibold text-[13px] mb-0.5">{children}</h5>
	),
	code: ({ children }) => (
		<code className="bg-kumo-fill px-1 py-0.5 rounded text-[12px]">
			{children}
		</code>
	),
	table: ({ children }) => (
		<div className="overflow-x-auto my-2">
			<table className="w-full text-xs border-collapse">{children}</table>
		</div>
	),
	thead: ({ children }) => (
		<thead className="border-b border-kumo-line bg-kumo-fill/30">
			{children}
		</thead>
	),
	th: ({ children }) => (
		<th className="text-left px-2 py-1 font-semibold text-kumo-strong">
			{children}
		</th>
	),
	td: ({ children }) => (
		<td className="px-2 py-1 border-b border-kumo-line/50">{children}</td>
	),
};
