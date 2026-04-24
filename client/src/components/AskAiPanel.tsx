/**
 * Shared "Ask AI about this data" panel (Task 4.5).
 *
 * Collapsible card that lets the user ask Claude questions grounded
 * in the on-screen data of the current module. The hosting page
 * supplies a `contextGetter` that returns the relevant slice (rows,
 * selected record, current filters) on demand — the data is
 * serialized only when a question is sent, so panels that sit on
 * heavy pages don't pay the cost unless the user opens them.
 *
 * Backend: trpc.anthropic.ask — takes moduleKey, question, context,
 * conversationHistory, modelOverride. The Anthropic API key comes
 * from the user's existing integration (settable in Settings).
 *
 * Deferred to follow-up PRs:
 * - Persist conversation history to the `conversations` / `messages`
 *   tables with `source: "ask-ai:${moduleKey}"` so the Notebook's
 *   linked-conversations panel surfaces them.
 * - Per-module default model stored in `userPreferences` so different
 *   modules can default to different cost/quality points.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  MessageSquare,
  Send,
  Trash2,
} from "lucide-react";

export type AskAiModelOption = {
  /** Model id sent to the Anthropic API (e.g. `claude-sonnet-4-6`). */
  id: string;
  /** User-visible label in the dropdown. */
  label: string;
};

export type AskAiPanelProps = {
  /** Unique, stable key per module — used in the system prompt and
   * (in a follow-up) as the conversations.source suffix. */
  moduleKey: string;
  /** Card title. Defaults to "Ask AI about this data". */
  title?: string;
  /**
   * Called when the user sends a question. Returns a string
   * (already-stringified) or an object that will be JSON-stringified.
   * Called lazily — only when the user submits.
   */
  contextGetter: () => string | object | null | undefined;
  /**
   * Models offered in the dropdown. If omitted, the default list is
   * shown: Sonnet (balanced default), Haiku (fastest), Opus (deepest).
   * The user's stored default (from the Anthropic connect flow) is
   * still honored when the dropdown is set to "Default".
   */
  availableModels?: AskAiModelOption[];
  /** Start collapsed (default) or open. */
  defaultOpen?: boolean;
  className?: string;
};

const DEFAULT_MODELS: AskAiModelOption[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 (balanced)" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (fastest)" },
  { id: "claude-opus-4-7", label: "Opus 4.7 (deepest analysis)" },
];

const DEFAULT_MODEL_VALUE = "__default__";

type Message = { role: "user" | "assistant"; content: string };

function serializeContext(value: string | object | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function AskAiPanel({
  moduleKey,
  title = "Ask AI about this data",
  contextGetter,
  availableModels = DEFAULT_MODELS,
  defaultOpen = false,
  className,
}: AskAiPanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<string>(DEFAULT_MODEL_VALUE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const askMutation = trpc.anthropic.ask.useMutation();
  const isLoading = askMutation.isPending;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSend = useCallback(async () => {
    const question = input.trim();
    if (!question || isLoading) return;

    setInput("");
    setError(null);
    const userMessage: Message = { role: "user", content: question };
    setMessages((prev) => [...prev, userMessage]);

    try {
      const contextText = serializeContext(contextGetter());
      const result = await askMutation.mutateAsync({
        moduleKey,
        question,
        contextText,
        conversationHistory: messages,
        modelOverride:
          modelSelection === DEFAULT_MODEL_VALUE ? undefined : modelSelection,
      });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.answer },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to get response";
      setError(msg);
    } finally {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [
    askMutation,
    contextGetter,
    input,
    isLoading,
    messages,
    modelSelection,
    moduleKey,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <Card className={cn("border-primary/15", className)}>
      <CardHeader
        className="cursor-pointer select-none py-3 px-4"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm">{title}</CardTitle>
            {messages.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                ({messages.length} messages)
              </span>
            ) : null}
          </div>
          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </CardHeader>

      {isOpen ? (
        <CardContent className="pt-0 px-4 pb-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Model:</span>
            <Select value={modelSelection} onValueChange={setModelSelection}>
              <SelectTrigger className="h-7 w-auto min-w-[180px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_MODEL_VALUE}>
                  Default (from Settings)
                </SelectItem>
                {availableModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div
            ref={scrollRef}
            className="mb-3 max-h-80 space-y-3 overflow-y-auto"
          >
            {messages.length === 0 && !isLoading ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                Ask a question about the data on this page. Claude has full
                context of the visible content.
              </p>
            ) : null}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={cn(
                  "flex",
                  msg.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-md px-3 py-2 text-sm whitespace-pre-wrap",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground",
                  )}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {isLoading ? (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Analyzing…
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
          </div>

          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this data…"
              disabled={isLoading}
              className="flex-1 rounded-sm border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            <Button
              size="sm"
              onClick={() => void handleSend()}
              disabled={isLoading || !input.trim()}
            >
              <Send className="h-3 w-3" />
            </Button>
            {messages.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMessages([]);
                  setError(null);
                }}
                title="Clear conversation"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            ) : null}
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

export default AskAiPanel;
