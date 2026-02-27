import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Loader2, MessageSquare, Send } from "lucide-react";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function ChatGPTWidget() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  
  const createConversation = trpc.conversations.create.useMutation({
    onSuccess: (data) => {
      setConversationId(data.id);
    },
  });
  
  const chat = trpc.openai.chat.useMutation({
    onSuccess: (data) => {
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    },
    onError: (error) => {
      toast.error(`Chat error: ${error.message}`);
    },
  });

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const handleSend = () => {
    if (!message.trim()) return;
    
    const userMessage = message;
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setMessage("");
    
    if (!conversationId) {
      // Create a new conversation first
      const title = userMessage.slice(0, 50);
      createConversation.mutate({ title }, {
        onSuccess: (data) => {
          chat.mutate({ conversationId: data.id, message: userMessage });
        },
      });
    } else {
      chat.mutate({ conversationId, message: userMessage });
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-100 text-green-600">
              <MessageSquare className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">ChatGPT Assistant</h1>
              <p className="text-sm text-slate-600">AI-powered productivity assistant</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container max-w-4xl mx-auto px-4 py-8 h-[calc(100vh-200px)] flex flex-col">
        <div className="flex-1 overflow-y-auto mb-4 space-y-4">
          {messages.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <MessageSquare className="w-12 h-12 text-slate-400 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-slate-900 mb-2">Start a conversation</h3>
                <p className="text-slate-600">
                  Ask me anything about productivity, task management, or get help organizing your schedule.
                </p>
              </CardContent>
            </Card>
          ) : (
            messages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] rounded-lg p-4 ${msg.role === "user" ? "bg-blue-600 text-white" : "bg-white border border-slate-200"}`}>
                  <div className={`text-sm break-words prose prose-sm max-w-none ${msg.role === "user" ? "prose-invert" : ""}`}>
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                </div>
              </div>
            ))
          )}
          {chat.isPending && (
            <div className="flex justify-start">
              <Card className="bg-white">
                <CardHeader className="p-4">
                  <Loader2 className="w-4 h-4 animate-spin text-slate-600" />
                </CardHeader>
              </Card>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="Type your message..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            disabled={chat.isPending}
          />
          <Button onClick={handleSend} disabled={chat.isPending || !message.trim()}>
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </main>
    </div>
  );
}

