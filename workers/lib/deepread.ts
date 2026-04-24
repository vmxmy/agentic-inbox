// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Thin client for the DeepRead document-extraction API
 * (https://api.deepread.tech). Two call sites are needed for our use case:
 *
 *   - submitOcr  → POST /v1/process with the PDF + a JSON Schema describing
 *                   the fields we want extracted. Returns a `job_id`.
 *   - getJob     → GET /v1/jobs/:id, returning `status` + `result` when done.
 *
 * `submitAndWait` wraps both with polling so callers who don't need
 * asynchronous behaviour (our invoice MCP tool) can treat it as synchronous.
 *
 * No dependency on our existing HTTP helpers because this is an outbound call
 * with a different auth scheme (`X-API-Key`) and because we want to stream
 * the PDF body as multipart without re-buffering.
 */

const API_BASE = "https://api.deepread.tech";
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 90_000;

export class DeepReadError extends Error {
	constructor(
		public readonly code:
			| "auth"
			| "http"
			| "network"
			| "timeout"
			| "job-failed"
			| "bad-response",
		message: string,
		public readonly statusCode?: number,
	) {
		super(message);
		this.name = "DeepReadError";
	}
}

/**
 * Per-field metadata DeepRead attaches to every extracted value. `hil_flag`
 * signals the field needs human review.
 */
export interface OcrFieldMeta {
	value: unknown;
	hil_flag?: boolean;
	reason?: string;
	found_on_page?: number;
}

export interface OcrJobResult {
	status:
		| "pending"
		| "queued"
		| "processing"
		| "completed"
		| "failed"
		| "cancelled"
		| string;
	result?: {
		data?: Record<string, OcrFieldMeta | unknown>;
	};
	metadata?: {
		page_count?: number;
		pipeline?: string;
		review_percentage?: number;
		fields_requiring_review?: number;
		total_fields?: number;
	};
	preview_url?: string;
	error?: string;
}

/** Submit a PDF + schema for OCR. Returns the job id. */
export async function submitOcr(
	apiKey: string,
	args: {
		bytes: Uint8Array;
		filename: string;
		schema: Record<string, unknown>;
		webhookUrl?: string;
	},
): Promise<string> {
	const form = new FormData();
	// Blob wants ArrayBuffer | ArrayBufferView; convert the Uint8Array view.
	const ab = args.bytes.buffer.slice(
		args.bytes.byteOffset,
		args.bytes.byteOffset + args.bytes.byteLength,
	) as ArrayBuffer;
	const blob = new Blob([ab], { type: "application/pdf" });
	form.append("file", blob, args.filename);
	form.append("schema", JSON.stringify(args.schema));
	if (args.webhookUrl) {
		form.append("webhook_url", args.webhookUrl);
	}

	const res = await fetch(`${API_BASE}/v1/process`, {
		method: "POST",
		headers: { "X-API-Key": apiKey },
		body: form,
	}).catch((e) => {
		throw new DeepReadError("network", `Network error: ${(e as Error).message}`);
	});

	if (res.status === 401 || res.status === 403) {
		throw new DeepReadError(
			"auth",
			`DeepRead rejected the API key (${res.status})`,
			res.status,
		);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new DeepReadError(
			"http",
			`DeepRead submit failed ${res.status}: ${body.slice(0, 500)}`,
			res.status,
		);
	}

	let json: unknown;
	try {
		json = await res.json();
	} catch {
		throw new DeepReadError("bad-response", "DeepRead submit returned non-JSON");
	}
	const jobId = (json as { job_id?: unknown }).job_id;
	if (typeof jobId !== "string" || !jobId) {
		throw new DeepReadError(
			"bad-response",
			`DeepRead submit missing job_id: ${JSON.stringify(json).slice(0, 300)}`,
		);
	}
	return jobId;
}

/** Poll a job. Returns the current status + result envelope. */
export async function getJob(
	apiKey: string,
	jobId: string,
): Promise<OcrJobResult> {
	const res = await fetch(`${API_BASE}/v1/jobs/${encodeURIComponent(jobId)}`, {
		headers: { "X-API-Key": apiKey },
	}).catch((e) => {
		throw new DeepReadError("network", `Network error: ${(e as Error).message}`);
	});

	if (res.status === 401 || res.status === 403) {
		throw new DeepReadError("auth", `DeepRead rejected the API key`, res.status);
	}
	if (res.status === 404) {
		throw new DeepReadError("http", `Job not found: ${jobId}`, 404);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new DeepReadError(
			"http",
			`DeepRead getJob failed ${res.status}: ${body.slice(0, 500)}`,
			res.status,
		);
	}
	try {
		return (await res.json()) as OcrJobResult;
	} catch {
		throw new DeepReadError("bad-response", "DeepRead getJob returned non-JSON");
	}
}

/**
 * Submit + poll until the job terminates. Throws on timeout or job-failed.
 * Caller gets back the successful OcrJobResult.
 */
export async function submitAndWait(
	apiKey: string,
	args: {
		bytes: Uint8Array;
		filename: string;
		schema: Record<string, unknown>;
		pollIntervalMs?: number;
		timeoutMs?: number;
	},
): Promise<{ jobId: string; result: OcrJobResult }> {
	const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_MS;
	const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const jobId = await submitOcr(apiKey, {
		bytes: args.bytes,
		filename: args.filename,
		schema: args.schema,
	});

	const deadline = Date.now() + timeoutMs;
	let lastResult: OcrJobResult | null = null;
	while (Date.now() < deadline) {
		// Brief initial wait to let the job start processing.
		await new Promise((r) => setTimeout(r, pollIntervalMs));
		lastResult = await getJob(apiKey, jobId);
		if (lastResult.status === "completed") {
			return { jobId, result: lastResult };
		}
		if (lastResult.status === "failed" || lastResult.status === "cancelled") {
			throw new DeepReadError(
				"job-failed",
				`DeepRead job ${jobId} ended in ${lastResult.status}: ${lastResult.error ?? "(no error message)"}`,
			);
		}
	}
	throw new DeepReadError(
		"timeout",
		`DeepRead job ${jobId} did not complete within ${timeoutMs}ms (last status: ${lastResult?.status ?? "unknown"})`,
	);
}
