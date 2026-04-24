// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, useKumoToastManager } from "@cloudflare/kumo";
import { ReceiptIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useUploadInvoiceFile } from "~/queries/invoices";

interface InvoiceUploaderProps {
	mailboxId: string | undefined;
	emailId: string;
	className?: string;
}

/**
 * Upload an invoice file (XML / OFD / PDF / ZIP) to an email. Used for
 * emails whose body is only a short-link to a SPA preview page with no
 * downloadable attachment (e.g. 百望 u.baiwang.com). The user downloads
 * the real invoice file in a browser, then drops it here.
 */
export default function InvoiceUploader({
	mailboxId,
	emailId,
	className,
}: InvoiceUploaderProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const upload = useUploadInvoiceFile(mailboxId, emailId);
	const [lastResult, setLastResult] = useState<string | null>(null);
	const toast = useKumoToastManager();

	const handlePick = () => {
		fileInputRef.current?.click();
	};

	const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		// Reset the input so selecting the same file twice still fires onChange.
		e.target.value = "";
		if (!file) return;

		setLastResult(null);
		try {
			const result = await upload.mutateAsync(file);
			if (result.invoiceId) {
				setLastResult(
					`已提取发票 ${result.invoice_number}`,
				);
				toast.add({ title: `发票已入库：${result.invoice_number}` });
			} else if (result.reason) {
				setLastResult(`文件已保存，但未入库：${result.reason}`);
				toast.add({ title: result.reason });
			} else {
				setLastResult("已上传");
			}
		} catch (err) {
			const message = (err as Error).message || "上传失败";
			setLastResult(`上传失败：${message}`);
			toast.add({ title: message });
		}
	};

	return (
		<div className={className}>
			<div className="flex items-center gap-3 rounded border border-dashed border-kumo-default bg-kumo-raised px-3 py-2 text-xs">
				<ReceiptIcon size={16} className="shrink-0 text-kumo-subtle" />
				<div className="flex-1">
					<div className="font-medium text-kumo-default">手动上传发票文件</div>
					<div className="text-kumo-subtle">
						当邮件只给短链没带附件时用。支持 XML / OFD / PDF / ZIP，自动解包 + 入库。
					</div>
				</div>
				<Button
					size="sm"
					variant="secondary"
					onClick={handlePick}
					disabled={upload.isPending || !mailboxId}
				>
					<UploadSimpleIcon size={14} />
					{upload.isPending ? "处理中…" : "选择文件"}
				</Button>
				<input
					ref={fileInputRef}
					type="file"
					accept=".xml,.ofd,.pdf,.zip,application/xml,application/pdf,application/ofd,application/zip"
					onChange={handleFile}
					className="hidden"
				/>
			</div>
			{lastResult ? (
				<div className="mt-1 text-xs text-kumo-subtle">{lastResult}</div>
			) : null}
		</div>
	);
}
