// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useUIStore } from "~/hooks/useUIStore";

interface EmailPanelHeaderProps {
	subject: string;
	messageCount: number;
	showThreadCount: boolean;
}

export default function EmailPanelHeader({
	subject,
	messageCount,
	showThreadCount,
}: EmailPanelHeaderProps) {
	const { closePanel } = useUIStore();
	return (
		<div className="px-4 py-3 border-b border-kumo-line shrink-0 md:px-6">
			<div className="flex items-center gap-2 min-w-0">
				{/* Back button — mobile only. The list pane is hidden when an email
				    is open on mobile (MailboxSplitView), so this is the only way
				    back to the list without closing/reopening the mailbox. */}
				<div className="md:hidden shrink-0">
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArrowLeftIcon size={18} />}
						onClick={closePanel}
						aria-label="Back to email list"
					/>
				</div>
				<h2 className="text-base font-semibold text-kumo-default truncate min-w-0">
					{subject}
				</h2>
			</div>
			{showThreadCount && (
				<span className="text-xs text-kumo-subtle mt-0.5 block">
					{messageCount} messages in this thread
				</span>
			)}
		</div>
	);
}
