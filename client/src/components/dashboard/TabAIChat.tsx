import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronUp, Loader2, MessageSquare, Send, Trash2 } from "lucide-react";

type Message = { role: "user" | "assistant"; content: string };

interface TabAIChatProps {
  tabId: string;
  dataContext: string;
  isActive: boolean;
}

export function TabAIChat({ tabId, dataContext, isActive }: TabAIChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevTabId = useRef(tabId);

  const askMutation = trpc.solarRecDashboard.askTabQuestion.useMutation();

  // Reset conversation on tab change
  useEffect(() => {
    if (prevTabId.current !== tabId) {
      setMessages([]);
      setError(null);
      prevTabId.current = tabId;
    }
  }, [tabId]);

  // Auto-scroll to bottom on new messages
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
    setIsLoading(true);

    try {
      const result = await askMutation.mutateAsync({
        tabId,
        question,
        dataContext,
        conversationHistory: messages,
      });

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.answer },
      ]);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to get response";
      setError(msg);
    } finally {
      setIsLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, isLoading, tabId, dataContext, messages, askMutation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  if (!isActive) return null;

  return (
    <Card className="border-primary/15">
      <CardHeader
        className="cursor-pointer select-none py-3 px-4"
        onClick={() => setIsOpen((o) => !o)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm">
              Ask AI about this data
            </CardTitle>
            {messages.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({messages.length} messages)
              </span>
            )}
          </div>
          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="pt-0 px-4 pb-4">
          {/* Messages */}
          <div
            ref={scrollRef}
            className="max-h-80 overflow-y-auto space-y-3 mb-3"
          >
            {messages.length === 0 && !isLoading && (
              <p className="text-xs text-muted-foreground text-center py-4">
                Ask a question about the data on this tab.
                Claude has full context of the visible metrics.
              </p>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-md px-3 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {msg.role === "assistant" ? (
                    <div className="prose prose-sm dark:prose-invert max-w-none [&_table]:text-xs [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_td]:border [&_td]:border-border [&_th]:bg-muted/50">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <span>{msg.content}</span>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-md px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Analyzing...
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>

          {/* Input */}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this data..."
              disabled={isLoading}
              className="flex-1 rounded-sm border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            <Button
              size="sm"
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
            >
              <Send className="h-3 w-3" />
            </Button>
            {messages.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMessages([]);
                  setError(null);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

