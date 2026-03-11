import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Italic,
  Link2,
  List,
  ListOrdered,
  Redo2,
  Underline as UnderlineIcon,
  Undo2,
  Unlink,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";

type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSaveShortcut?: () => void;
  className?: string;
};

function ToolbarButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "h-8 w-8",
        active ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200" : "text-slate-700 hover:bg-slate-100"
      )}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      {children}
    </Button>
  );
}

export default function RichTextEditor({ value, onChange, onSaveShortcut, className }: RichTextEditorProps) {
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
    ],
    content: value || "<p></p>",
    editorProps: {
      attributes: {
        class:
          "ProseMirror min-h-[320px] w-full px-5 py-4 font-[ui-serif] text-[15px] leading-7 text-slate-900 outline-none",
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSaveShortcut?.();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      onChange(currentEditor.getHTML());
    },
  });

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

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <ToolbarButton
          title="Bold"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Italic"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Underline"
          active={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Bullet list"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Numbered list"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="h-4 w-4" />
        </ToolbarButton>
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
        <div className="mx-1 h-5 w-px bg-slate-300" />
        <ToolbarButton title="Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
          <Undo2 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
          <Redo2 className="h-4 w-4" />
        </ToolbarButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-white">
        <EditorContent
          editor={editor}
          className="h-full min-h-[320px] [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-slate-400 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]"
        />
      </div>
    </div>
  );
}
