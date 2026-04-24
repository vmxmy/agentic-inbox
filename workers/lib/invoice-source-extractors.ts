// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Recursive extraction of a {@link ParsedInvoice} from a single "unit" — an
 * attachment row plus its bytes. Handles three container kinds:
 *
 *  - XML  → parse directly (already the authoritative source).
 *  - ZIP  → unpack; for each inner file, persist as a derived attachment and
 *           recurse.
 *  - OFD  → treated as ZIP, with a preference for `Doc_N/Attachs/*.xml`
 *           which is where the XBRL invoice metadata lives.
 *
 * Unknown formats (PDF, images, non-XML binary) return null. The caller keeps
 * their R2 bytes + attachment row regardless — they are legal-document copies
 * even when the parser cannot extract structured fields.
 *
 * {@link extractFromUnit} returns the parsed invoice plus the `attachment_id`
 * of the row that carried the authoritative XML (which may be a *descendant*
 * of the entry unit, e.g. `rai_issuer.xml` inside `*.ofd` inside `*.zip`).
 */

import { unzipSync } from "fflate";
import { parseChinaEInvoiceXml, type ParsedInvoice } from "./invoice-parser";

export type UnitOrigin = "email" | "unpacked" | "external-url";

export interface ExtractionUnit {
	/** The attachment_id row this unit corresponds to. */
	attachmentId: string;
	filename: string;
	mimetype: string;
	bytes: Uint8Array;
	origin: UnitOrigin;
}

export interface ExtractedInvoice {
	parsed: ParsedInvoice;
	authoritativeAttachmentId: string;
}

/**
 * Callback that the source extractor uses to register a newly-discovered
 * inner file as a derived attachment. The callee must persist the bytes to R2
 * AND insert an attachment row, then return the new attachment_id.
 *
 * The registrar is awaited, so persistence is synchronous with the walk —
 * when extractFromUnit returns a {@link ExtractedInvoice}, every ancestor row
 * is already in the DB with correct parent_attachment_id pointers.
 */
export type ChildRegistrar = (args: {
	filename: string;
	bytes: Uint8Array;
	parentAttachmentId: string;
}) => Promise<string>;

/**
 * Format detection. Magic bytes win over filename extension because some
 * endpoints (notably 广东税务局 dppt) deliver ZIP-wrapped invoice payloads
 * under a `.xml` filename. We still honour the filename afterwards so an
 * XML file named foo.txt parses.
 */
function detectKind(filename: string, bytes: Uint8Array): "xml" | "zip" | "ofd" | "other" {
	const lower = filename.toLowerCase();

	// Magic bytes first: PK\x03\x04 is always a ZIP container.
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		bytes[2] === 0x03 &&
		bytes[3] === 0x04
	) {
		return lower.endsWith(".ofd") ? "ofd" : "zip";
	}

	// Filename extensions (for when magic bytes are unavailable / ambiguous).
	if (lower.endsWith(".ofd")) return "ofd";
	if (lower.endsWith(".zip")) return "zip";
	if (lower.endsWith(".xml")) return "xml";

	// XML detection by content: skip optional BOM, then look for `<?` or `<Tag`.
	const start =
		bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	if (
		bytes.length > start + 5 &&
		bytes[start] === 0x3c /* '<' */ &&
		(bytes[start + 1] === 0x3f /* '?' */ ||
			/[A-Za-z_]/.test(String.fromCharCode(bytes[start + 1])))
	) {
		return "xml";
	}
	return "other";
}

function fileBasename(path: string): string {
	const i = path.lastIndexOf("/");
	return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Sort inner files of a ZIP/OFD so we try the most likely XBRL invoice
 * metadata first. This matters for OFD where Attachs/*.xml is the XBRL and
 * Doc_0/Document.xml is the shell manifest.
 */
function rankInnerFile(name: string): number {
	if (/\/Attachs\/.+\.xml$/i.test(name)) return 0; // XBRL attach — highest
	if (/\.xml$/i.test(name)) return 1; // other XML
	if (/\.ofd$/i.test(name)) return 2; // nested OFD
	if (/\.zip$/i.test(name)) return 3; // nested ZIP
	return 4; // PDF / images / other
}

async function extractFromContainer(
	unit: ExtractionUnit,
	registerChild: ChildRegistrar,
): Promise<ExtractedInvoice | null> {
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(unit.bytes);
	} catch (e) {
		console.error(`Failed to unzip ${unit.filename}:`, (e as Error).message);
		return null;
	}

	const ranked = Object.entries(entries)
		.filter(([, bytes]) => bytes && bytes.length > 0)
		.sort(([a], [b]) => rankInnerFile(a) - rankInnerFile(b));

	for (const [innerPath, innerBytes] of ranked) {
		// Persist every inner file as a derived attachment — even PDFs — so the
		// user has the full provenance chain in R2.
		const childFilename = fileBasename(innerPath);
		const childAttachmentId = await registerChild({
			filename: childFilename,
			bytes: innerBytes,
			parentAttachmentId: unit.attachmentId,
		});

		const kind = detectKind(childFilename, innerBytes);
		if (kind === "other") continue;

		const childUnit: ExtractionUnit = {
			attachmentId: childAttachmentId,
			filename: childFilename,
			mimetype: mimetypeFor(kind),
			bytes: innerBytes,
			origin: "unpacked",
		};
		const found = await extractFromUnit(childUnit, registerChild);
		if (found) return found;
	}
	return null;
}

function mimetypeFor(kind: "xml" | "zip" | "ofd"): string {
	switch (kind) {
		case "xml":
			return "application/xml";
		case "zip":
			return "application/zip";
		case "ofd":
			return "application/ofd";
	}
}

/**
 * Try to extract a {@link ParsedInvoice} from this unit, recursing through
 * container formats. Returns null when no authoritative XML is found anywhere
 * in the tree (e.g. a PDF-only ZIP).
 */
export async function extractFromUnit(
	unit: ExtractionUnit,
	registerChild: ChildRegistrar,
): Promise<ExtractedInvoice | null> {
	const kind = detectKind(unit.filename, unit.bytes);

	if (kind === "xml") {
		const parsed = parseChinaEInvoiceXml(unit.bytes);
		if (parsed) {
			return { parsed, authoritativeAttachmentId: unit.attachmentId };
		}
		return null;
	}

	if (kind === "zip" || kind === "ofd") {
		return extractFromContainer(unit, registerChild);
	}

	return null;
}
