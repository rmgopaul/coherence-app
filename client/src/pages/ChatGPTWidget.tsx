import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { Loader2, MessageSquare, Plus, Send, Trash2 } from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

type ConversationMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string | Date | null;
  pending?: boolean;
};

type ResponseMetric = {
  at: number;
  durationMs: number;
};

const RESPONSE_METRIC_STORAGE_KEY = "chatgpt-widget-response-metrics-v1";

function formatTimestamp(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function loadResponseMetrics(): ResponseMetric[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RESPONSE_METRIC_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        const at = Number((entry as any)?.at);
        const durationMs = Number((entry as any)?.durationMs);
        if (!Number.isFinite(at) || !Number.isFinite(durationMs)) return null;
        return { at, durationMs };
      })
      .filter((entry): entry is ResponseMetric => Boolean(entry))
      .slice(-300);
  } catch {
    return [];
  }
}

export default function ChatGPTWidget() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const [messageInput, setMessageInput] = useState("");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [pendingUserMessage, setPendingUserMessage] = useState<ConversationMessage | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [responseMetrics, setResponseMetrics] = useState<ResponseMetric[]>(() => loadResponseMetrics());

  const sendLockRef = useRef(false);
  const shouldAutoScrollRef = useRef(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  const conversationsQuery = trpc.conversations.list.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    staleTime: 20_000,
  });

  const messagesQuery = trpc.conversations.getMessages.useQuery(
    { conversationId: selectedConversationId || "" },
    {
      enabled: !!selectedConversationId,
      retry: false,
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    }
  );

  const createConversation = trpc.conversations.create.useMutation({
    onError: (error) => {
      toast.error(`Failed to create conversation: ${error.message}`);
    },
  });

  const deleteConversation = trpc.conversations.delete.useMutation({
    onError: (error) => {
      toast.error(`Failed to delete conversation: ${error.message}`);
    },
  });

  const chat = trpc.openai.chat.useMutation({
    onError: (error) => {
      toast.error(`Chat error: ${error.message}`);
      setSendError(error.message);
    },
  });

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RESPONSE_METRIC_STORAGE_KEY, JSON.stringify(responseMetrics.slice(-300)));
  }, [responseMetrics]);

  const conversations = useMemo(() => {
    const rows = [...(conversationsQuery.data || [])];
    rows.sort((a, b) => {
      const aMs = new Date(String(a.updatedAt || a.createdAt || "")).getTime();
      const bMs = new Date(String(b.updatedAt || b.createdAt || "")).getTime();
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
    });

    const query = conversationSearch.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((conversation) => String(conversation.title || "").toLowerCase().includes(query));
  }, [conversationsQuery.data, conversationSearch]);

  useEffect(() => {
    if (!conversationsQuery.data) return;
    if (selectedConversationId && conversationsQuery.data.some((row) => row.id === selectedConversationId)) {
      return;
    }
    const firstConversation = conversationsQuery.data[0];
    setSelectedConversationId(firstConversation?.id || null);
  }, [conversationsQuery.data, selectedConversationId]);

  const currentMessages = useMemo<ConversationMessage[]>(() => {
    const rows = (messagesQuery.data || []) as ConversationMessage[];
    if (!pendingUserMessage) return rows;
    return [...rows, pendingUserMessage];
  }, [messagesQuery.data, pendingUserMessage]);

  const todayStart = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }, []);

  const messagesToday = useMemo(() => {
    return currentMessages.filter((message) => {
      const ts = new Date(String(message.createdAt || "")).getTime();
      return Number.isFinite(ts) && ts >= todayStart;
    }).length;
  }, [currentMessages, todayStart]);

  const avgResponseMs = useMemo(() => {
    if (responseMetrics.length === 0) return null;
    const windowed = responseMetrics.slice(-30);
    const total = windowed.reduce((sum, entry) => sum + entry.durationMs, 0);
    return total / windowed.length;
  }, [responseMetrics]);

  const todayResponseCount = useMemo(() => {
    return responseMetrics.filter((entry) => entry.at >= todayStart).length;
  }, [responseMetrics, todayStart]);

  const scrollStorageKey = selectedConversationId ? `chat-widget-scroll:${selectedConversationId}` : "chat-widget-scroll:none";

  useEffect(() => {
    const container = messageListRef.current;
    if (!container || typeof window === "undefined") return;

    const saved = window.sessionStorage.getItem(scrollStorageKey);
    if (saved !== null) {
      const parsed = Number(saved);
      if (Number.isFinite(parsed)) {
        container.scrollTop = parsed;
      }
    } else {
      container.scrollTop = container.scrollHeight;
    }

    const onScroll = () => {
      window.sessionStorage.setItem(scrollStorageKey, String(container.scrollTop));
    };

    container.addEventListener("scroll", onScroll);
    return () => {
      container.removeEventListener("scroll", onScroll);
    };
  }, [scrollStorageKey]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    const container = messageListRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    shouldAutoScrollRef.current = false;
  }, [currentMessages.length, chat.isPending]);

  const ensureConversation = async (seedMessage: string): Promise<string | null> => {
    if (selectedConversationId) return selectedConversationId;

    const title = seedMessage.slice(0, 80).trim() || "New conversation";
    const created = await createConversation.mutateAsync({ title });
    setSelectedConversationId(created.id);
    await trpcUtils.conversations.list.invalidate();
    return created.id;
  };

  const handleCreateConversation = async () => {
    const title = `New conversation ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    const created = await createConversation.mutateAsync({ title });
    setSelectedConversationId(created.id);
    setMessageInput("");
    setSendError(null);
    setPendingUserMessage(null);
    await trpcUtils.conversations.list.invalidate();
    shouldAutoScrollRef.current = true;
  };

  const handleDeleteConversation = async (conversationId: string) => {
    if (!window.confirm("Delete this conversation?")) return;
    await deleteConversation.mutateAsync({ conversationId });

    if (selectedConversationId === conversationId) {
      setSelectedConversationId(null);
      setPendingUserMessage(null);
      setSendError(null);
    }

    await trpcUtils.conversations.list.invalidate();
    if (selectedConversationId === conversationId) {
      await trpcUtils.conversations.getMessages.invalidate({ conversationId });
    }
  };

  const handleSend = async () => {
    const trimmed = messageInput.trim();
    if (!trimmed) return;
    if (sendLockRef.current || chat.isPending) return;

    setSendError(null);
    setMessageInput("");
    const startedAt = performance.now();
    const optimisticMessage: ConversationMessage = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
      pending: true,
    };

    setPendingUserMessage(optimisticMessage);
    shouldAutoScrollRef.current = true;

    sendLockRef.current = true;
    try {
      const conversationId = await ensureConversation(trimmed);
      if (!conversationId) {
        throw new Error("Conversation could not be created.");
      }

      await chat.mutateAsync({ conversationId, message: trimmed });

      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      setResponseMetrics((previous) => [...previous, { at: Date.now(), durationMs }].slice(-300));

      setPendingUserMessage(null);
      await Promise.all([
        trpcUtils.conversations.list.invalidate(),
        trpcUtils.conversations.getMessages.invalidate({ conversationId }),
      ]);
      shouldAutoScrollRef.current = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to send message";
      setSendError(message);
      setMessageInput(trimmed);
      setPendingUserMessage(null);
    } finally {
      sendLockRef.current = false;
    }
  };

  if (authLoading || (conversationsQuery.isLoading && !conversationsQuery.data)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <main className="container max-w-6xl mx-auto px-4 py-6 space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Conversations</p>
            <p className="text-2xl font-semibold text-foreground">{(conversationsQuery.data || []).length.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Messages Today</p>
            <p className="text-2xl font-semibold text-foreground">{messagesToday.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Avg Reply Time</p>
            <p className="text-2xl font-semibold text-foreground">
              {avgResponseMs === null ? "-" : `${(avgResponseMs / 1000).toFixed(1)}s`}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{todayResponseCount} replies measured today</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-4">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Conversations</CardTitle>
              <Button size="sm" onClick={handleCreateConversation} disabled={createConversation.isPending}>
                <Plus className="w-4 h-4 mr-1" />
                New
              </Button>
            </div>
            <Input
              value={conversationSearch}
              onChange={(event) => setConversationSearch(event.target.value)}
              placeholder="Search conversations..."
            />
          </CardHeader>
          <CardContent className="space-y-2 max-h-[560px] overflow-y-auto">
            {conversations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No conversations yet.</p>
            ) : (
              conversations.map((conversation) => {
                const isSelected = selectedConversationId === conversation.id;
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => {
                      setSelectedConversationId(conversation.id);
                      setSendError(null);
                      shouldAutoScrollRef.current = false;
                    }}
                    className={`w-full text-left rounded-md border px-3 py-2 transition cursor-pointer ${
                      isSelected
                        ? "border-primary bg-primary/5"
                        : "border-border bg-card hover:bg-accent"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{conversation.title || "Untitled"}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatTimestamp(conversation.updatedAt || conversation.createdAt)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteConversation(conversation.id);
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </button>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-8 flex flex-col min-h-[560px]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {selectedConversationId
                ? conversationsQuery.data?.find((conversation) => conversation.id === selectedConversationId)?.title || "Conversation"
                : "Select or create a conversation"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-3">
            <div ref={messageListRef} className="flex-1 overflow-y-auto rounded-md border bg-muted/30 p-3 space-y-3">
              {!selectedConversationId ? (
                <div className="h-full flex items-center justify-center text-center text-muted-foreground text-sm">
                  Start a new conversation to chat.
                </div>
              ) : messagesQuery.isLoading && !messagesQuery.data ? (
                <div className="h-full flex items-center justify-center">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : currentMessages.length === 0 && !chat.isPending ? (
                <div className="h-full flex items-center justify-center text-center text-muted-foreground text-sm">
                  Send a message to begin this conversation.
                </div>
              ) : (
                currentMessages.map((message, index) => (
                  <div key={message.id || `${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-lg px-3 py-2 ${
                        message.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-card border text-foreground"
                      }`}
                    >
                      <div className={`text-sm break-words prose prose-sm max-w-none ${message.role === "user" ? "prose-invert" : ""}`}>
                        <ReactMarkdown>{message.content}</ReactMarkdown>
                      </div>
                      <p className={`text-xs mt-1 ${message.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                        {formatTimestamp(message.createdAt)} {message.pending ? "• sending" : ""}
                      </p>
                    </div>
                  </div>
                ))
              )}

              {chat.isPending && (
                <div className="flex justify-start">
                  <div className="rounded-lg bg-card border px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating response...
                  </div>
                </div>
              )}
            </div>

            {sendError ? (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {sendError}
              </div>
            ) : null}

            <div className="flex gap-2">
              <Input
                placeholder={selectedConversationId ? "Type your message..." : "Type your first message to start a conversation..."}
                value={messageInput}
                onChange={(event) => setMessageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                disabled={chat.isPending || createConversation.isPending}
              />
              <Button
                onClick={() => void handleSend()}
                disabled={chat.isPending || createConversation.isPending || !messageInput.trim()}
              >
                {chat.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
