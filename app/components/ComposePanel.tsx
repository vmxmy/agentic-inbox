// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Input } from "@cloudflare/kumo";
import { FloppyDiskIcon, PaperclipIcon, PaperPlaneTiltIcon, XCircleIcon, XIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import RichTextEditor from "./RichTextEditor";

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ComposePanel() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();

	const fileInputRef = useRef<HTMLInputElement>(null);
	const {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		error,
		isSavingDraft,
		isSending,
		attachments,
		addAttachments,
		removeAttachment,
		formTitle,
		handleSaveDraft,
		handleSend,
		closeCompose,
		closePanel,
	} = useComposeForm(mailboxId, folder);

	return (
		<div className="flex flex-col h-full bg-kumo-base">
			<div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line shrink-0 md:px-6">
				<h2 className="text-base font-semibold text-kumo-default">
					{formTitle}
				</h2>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={closeCompose}
						disabled={isSending}
						aria-label="Close compose"
					/>
				</div>
			</div>

			<form
				onSubmit={(e) => handleSend(e, closePanel)}
				className="flex flex-col flex-1 min-h-0 overflow-y-auto"
			>
				<div className="p-4 md:p-6 space-y-4">
					{error && <Banner variant="error" text={error} />}

					<div className="space-y-3">
						<div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-2">
							<label className="text-xs md:text-sm font-medium text-kumo-subtle md:w-14 md:shrink-0">
								To
							</label>
							<div className="flex-1 flex items-center gap-2 min-w-0">
								<Input
									type="text"
									placeholder="recipient@example.com"
									size="sm"
									value={to}
									onChange={(e) => setTo(e.target.value)}
									required
									inputMode="email"
									autoComplete="email"
								/>
								{!showCcBcc && (
									<button
										type="button"
										onClick={() => setShowCcBcc(true)}
										className="shrink-0 text-xs text-kumo-link hover:text-kumo-link-hover font-medium"
									>
										CC / BCC
									</button>
								)}
							</div>
						</div>

						{showCcBcc && (
							<div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-2">
								<label className="text-xs md:text-sm font-medium text-kumo-subtle md:w-14 md:shrink-0">
									CC
								</label>
								<div className="flex-1">
									<Input
										type="text"
										size="sm"
										value={cc}
										onChange={(e) => setCc(e.target.value)}
										placeholder="Separate multiple addresses with commas"
										inputMode="email"
										autoComplete="email"
									/>
								</div>
							</div>
						)}

						{showCcBcc && (
							<div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-2">
								<label className="text-xs md:text-sm font-medium text-kumo-subtle md:w-14 md:shrink-0">
									BCC
								</label>
								<div className="flex-1">
									<Input
										type="text"
										size="sm"
										value={bcc}
										onChange={(e) => setBcc(e.target.value)}
										placeholder="Separate multiple addresses with commas"
										inputMode="email"
										autoComplete="email"
									/>
								</div>
							</div>
						)}

						<div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-2">
							<label className="text-xs md:text-sm font-medium text-kumo-subtle md:w-14 md:shrink-0">
								Subject
							</label>
							<div className="flex-1">
								<Input
									type="text"
									placeholder="Email subject"
									size="sm"
									value={subject}
									onChange={(e) => setSubject(e.target.value)}
									required
									autoComplete="off"
								/>
							</div>
						</div>
					</div>

					<div className="border border-kumo-line rounded-md overflow-hidden bg-kumo-base">
						<RichTextEditor
							value={body}
							onChange={setBody}
						/>
					</div>
				</div>

				<input
					ref={fileInputRef}
					type="file"
					multiple
					className="hidden"
					onChange={(e) => e.target.files && addAttachments(e.target.files)}
				/>

				{attachments.length > 0 && (
					<div className="px-4 md:px-6 pb-3 flex flex-wrap gap-2">
						{attachments.map((f, i) => (
							<div
								key={i}
								className="flex items-center gap-1.5 rounded border border-kumo-line bg-kumo-recessed px-2 py-1 text-xs text-kumo-default"
							>
								<PaperclipIcon size={12} className="shrink-0 text-kumo-subtle" />
								<span className="max-w-[160px] truncate">{f.name}</span>
								<span className="text-kumo-subtle shrink-0">({formatFileSize(f.size)})</span>
								<button
									type="button"
									onClick={() => removeAttachment(i)}
									aria-label={`Remove ${f.name}`}
									className="shrink-0 ml-0.5"
								>
									<XCircleIcon size={14} className="text-kumo-subtle hover:text-kumo-default" />
								</button>
							</div>
						))}
					</div>
				)}

				{/* Footer actions */}
				<div className="mt-auto px-4 py-3 border-t border-kumo-line bg-kumo-fill/30 shrink-0 md:px-6">
					<div className="flex items-center justify-between gap-2 flex-wrap">
						<div className="flex items-center gap-1">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={isSending}
								icon={<PaperclipIcon size={14} />}
								onClick={() => fileInputRef.current?.click()}
							>
								Attach
							</Button>
							<Button type="button" variant="ghost" size="sm" onClick={closeCompose} disabled={isSending}>
								Discard
							</Button>
						</div>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								loading={isSavingDraft}
								disabled={isSending}
								icon={<FloppyDiskIcon size={14} />}
								onClick={handleSaveDraft}
							>
								{isSavingDraft ? "Saving..." : "Save as Draft"}
							</Button>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isSending}
								disabled={isSavingDraft || isSending}
								icon={<PaperPlaneTiltIcon size={14} />}
							>
								{isSending ? "Sending..." : "Send"}
							</Button>
						</div>
					</div>
				</div>
			</form>
		</div>
	);
}
