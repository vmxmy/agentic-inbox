// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	ArrowCounterClockwiseIcon,
	CodeIcon,
	LinkBreakIcon,
	LinkSimpleIcon,
	ListBulletsIcon,
	ListNumbersIcon,
	MinusIcon,
	QuotesIcon,
	TextBIcon,
	TextItalicIcon,
	TextStrikethroughIcon,
	TextUnderlineIcon,
} from "@phosphor-icons/react";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useState } from "react";

interface RichTextEditorProps {
	value: string;
	onChange: (value: string) => void;
}

export default function RichTextEditor({
	value,
	onChange,
}: RichTextEditorProps) {
	const [isSourceMode, setIsSourceMode] = useState(false);

	const editor = useEditor({
		extensions: [
			StarterKit,
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			LinkExtension.configure({ openOnClick: false }),
			TiptapImage,
			TextStyle,
			Color,
			Highlight.configure({ multicolor: true }),
		],
		content: value,
		editorProps: {
			attributes: {
				class:
					"prose prose-sm max-w-none focus:outline-none min-h-[180px] p-3 text-sm [&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle [&_blockquote]:bg-kumo-tint [&_blockquote]:py-1 [&_blockquote]:my-2 [&_blockquote]:text-xs [&_blockquote]:rounded-r-sm",
			},
		},
		onUpdate: ({ editor }) => {
			onChange(editor.getHTML());
		},
	});

	useEffect(() => {
		if (editor && !editor.isDestroyed && value !== editor.getHTML()) {
			editor.commands.setContent(value);
			const rafId = requestAnimationFrame(() => {
				if (!editor.isDestroyed) {
					editor.commands.focus('start');
				}
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [value, editor]);

	const setLink = useCallback(() => {
		if (!editor) return;
		const previousUrl = editor.getAttributes("link").href;
		const url = window.prompt("URL", previousUrl);
		if (url === null) return;
		if (url === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
	}, [editor]);

	const toggleSourceMode = useCallback(() => {
		setIsSourceMode((prev) => {
			const next = !prev;
			if (next && editor) {
				// Switching to source: sync editor HTML to parent
				const html = editor.getHTML();
				if (html !== value) onChange(html);
			} else if (!next && editor) {
				// Switching to visual: sync current HTML into editor
				editor.commands.setContent(value);
			}
			return next;
		});
	}, [editor, value, onChange]);

	if (!editor) return null;

	return (
		<div className="rounded-lg border border-kumo-line overflow-hidden flex flex-col h-full">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-0.5 bg-kumo-recessed px-2 py-1.5 border-b border-kumo-line shrink-0">
				{/* Text formatting */}
				<Tooltip content="Bold" side="bottom" asChild>
					<Button
						variant={editor.isActive("bold") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextBIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBold().run()}
						disabled={isSourceMode}
						aria-label="Bold"
					/>
				</Tooltip>
				<Tooltip content="Italic" side="bottom" asChild>
					<Button
						variant={editor.isActive("italic") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextItalicIcon size={16} />}
						onClick={() => editor.chain().focus().toggleItalic().run()}
						disabled={isSourceMode}
						aria-label="Italic"
					/>
				</Tooltip>
				<Tooltip content="Underline" side="bottom" asChild>
					<Button
						variant={editor.isActive("underline") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextUnderlineIcon size={16} />}
						onClick={() => editor.chain().focus().toggleUnderline().run()}
						disabled={isSourceMode}
						aria-label="Underline"
					/>
				</Tooltip>
				<Tooltip content="Strikethrough" side="bottom" asChild>
					<Button
						variant={editor.isActive("strike") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextStrikethroughIcon size={16} />}
						onClick={() => editor.chain().focus().toggleStrike().run()}
						disabled={isSourceMode}
						aria-label="Strikethrough"
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Lists */}
				<Tooltip content="Bullet list" side="bottom" asChild>
					<Button
						variant={editor.isActive("bulletList") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<ListBulletsIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBulletList().run()}
						disabled={isSourceMode}
						aria-label="Bullet list"
					/>
				</Tooltip>
				<Tooltip content="Numbered list" side="bottom" asChild>
					<Button
						variant={editor.isActive("orderedList") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<ListNumbersIcon size={16} />}
						onClick={() => editor.chain().focus().toggleOrderedList().run()}
						disabled={isSourceMode}
						aria-label="Numbered list"
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Block formatting */}
				<Tooltip content="Blockquote" side="bottom" asChild>
					<Button
						variant={editor.isActive("blockquote") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<QuotesIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBlockquote().run()}
						disabled={isSourceMode}
						aria-label="Blockquote"
					/>
				</Tooltip>
				<Tooltip content="Link" side="bottom" asChild>
					<Button
						variant={editor.isActive("link") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<LinkSimpleIcon size={16} />}
						onClick={setLink}
						disabled={isSourceMode}
						aria-label="Link"
					/>
				</Tooltip>
				{editor.isActive("link") && (
					<Tooltip content="Remove link" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<LinkBreakIcon size={16} />}
							onClick={() => editor.chain().focus().unsetLink().run()}
							disabled={isSourceMode}
							aria-label="Remove link"
						/>
					</Tooltip>
				)}
				<Tooltip content="Horizontal rule" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<MinusIcon size={16} />}
						onClick={() => editor.chain().focus().setHorizontalRule().run()}
						disabled={isSourceMode}
						aria-label="Horizontal rule"
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Undo/Redo */}
				<Tooltip content="Undo" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArrowCounterClockwiseIcon size={16} />}
						onClick={() => editor.chain().focus().undo().run()}
						disabled={isSourceMode || !editor.can().undo()}
						aria-label="Undo"
					/>
				</Tooltip>
				<Tooltip content="Redo" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArrowClockwiseIcon size={16} />}
						onClick={() => editor.chain().focus().redo().run()}
						disabled={isSourceMode || !editor.can().redo()}
						aria-label="Redo"
					/>
				</Tooltip>

				<div className="flex-1" />

				{/* Source toggle */}
				<Tooltip content={isSourceMode ? "Visual" : "Source"} side="bottom" asChild>
					<Button
						variant={isSourceMode ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<CodeIcon size={16} />}
						onClick={toggleSourceMode}
						aria-label={isSourceMode ? "Visual" : "Source"}
					/>
				</Tooltip>
			</div>

			{/* Editor content */}
			<div className="flex-1 overflow-y-auto">
				{isSourceMode ? (
					<textarea
						value={value}
						onChange={(e) => onChange(e.target.value)}
						className="w-full h-full min-h-[180px] p-3 text-xs font-mono bg-kumo-base text-kumo-default resize-none focus:outline-none"
						spellCheck={false}
					/>
				) : (
					<EditorContent editor={editor} />
				)}
			</div>
		</div>
	);
}
