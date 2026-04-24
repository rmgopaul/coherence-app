import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Redo2,
  Strikethrough,
  Table2,
  TextQuote,
  Underline as UnderlineIcon,
  Undo2,
  Unlink,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSaveShortcut?: () => void;
  /**
   * Fires on Cmd+Alt+T (Mac) / Ctrl+Alt+T (Win/Linux) with a non-empty
   * selection. Chrome reserves plain Cmd+T for "new tab" at the browser
   * level — pages cannot intercept it — so we add Alt/Option to the
   * combo. The selected text is passed so a task-creation modal can
   * pre-fill it.
   */
  onCreateTodoistTask?: (selectedText: string) => void;
  onUploadImage?: (file: File) => Promise<string | null>;
  className?: string;
};

function ToolbarButton({
  active,
  disabled,
  onClick,
  title,
  shortcut,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  shortcut?: string;
  children: ReactNode;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "h-7 w-7",
        active ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200" : "text-slate-700 hover:bg-slate-100"
      )}
      disabled={disabled}
      onClick={onClick}
      aria-label={title}
    >
      {children}
    </Button>
  );

  if (!shortcut) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-1.5 text-xs">
        <span>{title}</span>
        <kbd className="rounded border border-slate-600 bg-slate-700 px-1 py-0.5 text-xs font-mono text-slate-300">
          {shortcut}
        </kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function ToolbarSep() {
  return <div className="mx-0.5 h-5 w-px bg-slate-300" />;
}

export default function RichTextEditor({
  value,
  onChange,
  onSaveShortcut,
  onCreateTodoistTask,
  onUploadImage,
  className,
}: RichTextEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageUpload = useCallback(
    async (file: File) => {
      if (!onUploadImage) return;
      if (!file.type.startsWith("image/")) {
        toast.error("Only image files are supported");
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        toast.error("Image must be under 5 MB");
        return;
      }

      const url = await onUploadImage(file);
      if (url && editor) {
        editor.chain().focus().setImage({ src: url, alt: file.name }).run();
      }
    },
    [onUploadImage]
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ["http", "https", "mailto"],
      }),
      Placeholder.configure({
        placeholder: "Start typing your notes...",
      }),
      Image.configure({
        inline: false,
        allowBase64: false,
        HTMLAttributes: {
          class: "note-image",
        },
      }),
      Table.configure({
        resizable: true,
        HTMLAttributes: {
          class: "note-table",
        },
      }),
      TableRow,
      TableCell,
      TableHeader,
    ],
    content: value || "<p></p>",
    editorProps: {
      attributes: {
        class:
          "ProseMirror min-h-[320px] w-full px-5 py-4 font-[ui-serif] text-[15px] leading-7 text-slate-900 outline-none",
      },
      handleKeyDown: (view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSaveShortcut?.();
          return true;
        }
        // Cmd+Alt+T (Mac) / Ctrl+Alt+T (Win/Linux). Plain Cmd+T opens
        // a new tab at the Chrome level and is not preventDefault'able
        // from page code — see commit history for the original bug.
        // event.code === "KeyT" because Option+T on Mac produces "†"
        // in event.key, not "t".
        if (
          (event.metaKey || event.ctrlKey) &&
          event.altKey &&
          event.code === "KeyT" &&
          onCreateTodoistTask
        ) {
          const { from, to } = view.state.selection;
          if (from === to) return false; // empty selection — let the browser handle
          event.preventDefault();
          const selectedText = view.state.doc.textBetween(from, to, " ", " ");
          onCreateTodoistTask(selectedText);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const file = event.dataTransfer?.files?.[0];
        if (file?.type.startsWith("image/")) {
          event.preventDefault();
          void handleImageUpload(file);
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const file = event.clipboardData?.files?.[0];
        if (file?.type.startsWith("image/")) {
          event.preventDefault();
          void handleImageUpload(file);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      onChange(currentEditor.getHTML());
    },
  });

  // Force re-render after external content sync so word count updates
  const [, setRenderTick] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const nextValue = value || "<p></p>";
    if (editor.getHTML() === nextValue) return;

    const selection = editor.state.selection;
    editor.commands.setContent(nextValue, { emitUpdate: false });

    const size = editor.state.doc.content.size;
    const nextFrom = Math.max(0, Math.min(selection.from, size));
    const nextTo = Math.max(0, Math.min(selection.to, size));
    editor.commands.setTextSelection({ from: nextFrom, to: nextTo });

    setRenderTick((c) => c + 1);
  }, [editor, value]);

  if (!editor) {
    return (
      <div className="flex min-h-[340px] items-center justify-center rounded-md border border-slate-200 bg-white text-sm text-slate-500">
        Loading editor...
      </div>
    );
  }

  const setLink = () => {
    const existing = editor.getAttributes("link").href as string | undefined;
    const valueFromPrompt = window.prompt("Enter URL", existing || "https://");
    if (valueFromPrompt === null) return;

    const trimmed = valueFromPrompt.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
  };

  const text = editor.state.doc.textContent;
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const charCount = text.length;

  return (
    <TooltipProvider delayDuration={400}>
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
          {/* Headings */}
          <ToolbarButton
            title="Heading 1"
            shortcut="⌘⌥1"
            active={editor.isActive("heading", { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Heading 2"
            shortcut="⌘⌥2"
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Heading 3"
            shortcut="⌘⌥3"
            active={editor.isActive("heading", { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 className="h-4 w-4" />
          </ToolbarButton>

          <ToolbarSep />

          {/* Inline formatting */}
          <ToolbarButton
            title="Bold"
            shortcut="⌘B"
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Italic"
            shortcut="⌘I"
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Underline"
            shortcut="⌘U"
            active={editor.isActive("underline")}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <UnderlineIcon className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Strikethrough"
            shortcut="⌘⇧S"
            active={editor.isActive("strike")}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough className="h-4 w-4" />
          </ToolbarButton>

          <ToolbarSep />

          {/* Lists & blocks */}
          <ToolbarButton
            title="Bullet list"
            shortcut="⌘⇧8"
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Numbered list"
            shortcut="⌘⇧7"
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Blockquote"
            shortcut="⌘⇧B"
            active={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <TextQuote className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Code block"
            shortcut="⌘⌥C"
            active={editor.isActive("codeBlock")}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          >
            <Code className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Horizontal rule"
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          >
            <Minus className="h-4 w-4" />
          </ToolbarButton>

          <ToolbarSep />

          {/* Links, image, table */}
          <ToolbarButton title="Add link" active={editor.isActive("link")} onClick={setLink}>
            <Link2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Remove link"
            disabled={!editor.isActive("link")}
            onClick={() => editor.chain().focus().unsetLink().run()}
          >
            <Unlink className="h-4 w-4" />
          </ToolbarButton>

          {onUploadImage && (
            <ToolbarButton
              title="Insert image"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon className="h-4 w-4" />
            </ToolbarButton>
          )}

          {/* Table dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7",
                  editor.isActive("table")
                    ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                    : "text-slate-700 hover:bg-slate-100"
                )}
                aria-label="Table"
              >
                <Table2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem
                onClick={() =>
                  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
                }
              >
                Insert 3×3 table
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!editor.can().addColumnAfter()}
                onClick={() => editor.chain().focus().addColumnAfter().run()}
              >
                Add column after
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!editor.can().addRowAfter()}
                onClick={() => editor.chain().focus().addRowAfter().run()}
              >
                Add row after
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!editor.can().deleteColumn()}
                onClick={() => editor.chain().focus().deleteColumn().run()}
              >
                Delete column
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!editor.can().deleteRow()}
                onClick={() => editor.chain().focus().deleteRow().run()}
              >
                Delete row
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!editor.can().deleteTable()}
                onClick={() => editor.chain().focus().deleteTable().run()}
                className="text-red-600"
              >
                Delete table
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ToolbarSep />

          {/* Undo/Redo */}
          <ToolbarButton title="Undo" shortcut="⌘Z" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
            <Undo2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton title="Redo" shortcut="⌘⇧Z" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
            <Redo2 className="h-4 w-4" />
          </ToolbarButton>
        </div>

        {/* Editor content */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-white">
          <EditorContent
            editor={editor}
            className="h-full min-h-[320px] [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-slate-400 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]"
          />
        </div>

        {/* Word/character count footer */}
        <div className="flex items-center justify-end border-t border-slate-200 bg-slate-50/60 px-4 py-1 text-xs text-slate-400">
          {wordCount} word{wordCount !== 1 ? "s" : ""} &middot; {charCount} char{charCount !== 1 ? "s" : ""}
        </div>

        {/* Hidden file input for image uploads */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImageUpload(file);
            e.target.value = "";
          }}
        />
      </div>
    </TooltipProvider>
  );
}
