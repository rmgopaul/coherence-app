import React from "react";
import ReactMarkdown from "react-markdown";
import { MessageSquare, Plus, Trash2, Send, Loader2 } from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ChatPanelProps {
  // Data
  hasOpenAI: boolean;
  conversations: any[] | undefined;
  selectedConversationId: string | null;
  messages: any[] | undefined;
  chatMessage: string;
  isSectionVisible: (key: any) => boolean;
  chatExpanded: boolean;

  // Handlers
  setSelectedConversationId: (id: string | null) => void;
  setChatMessage: (msg: string) => void;
  setChatExpanded: (expanded: boolean) => void;
  handleNewConversation: () => void;
  handleDeleteConversation: (id: string) => void;
  handleSendMessage: () => void;

  // Mutation state
  sendMessagePending: boolean;

  // Ref
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export function ChatPanel({
  hasOpenAI,
  conversations,
  selectedConversationId,
  messages,
  chatMessage,
  isSectionVisible,
  chatExpanded,
  setSelectedConversationId,
  setChatMessage,
  setChatExpanded,
  handleNewConversation,
  handleDeleteConversation,
  handleSendMessage,
  sendMessagePending,
  messagesEndRef,
}: ChatPanelProps) {
  // Hidden: render nothing
  if (!isSectionVisible("chat")) {
    return null;
  }

  // Visible + collapsed: "Chat Hidden" card
  if (!chatExpanded) {
    return (
      <div id="section-chat" className="container mx-auto px-4 pb-6 scroll-mt-40">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Chat Hidden</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Chat queries are paused while this section is collapsed.
            </p>
            <Button onClick={() => setChatExpanded(true)}>Show Chat</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Visible + expanded: full chat panel
  return (
    <div id="section-chat" className="border-t bg-card dark:bg-slate-900 scroll-mt-40">
      <div className="container mx-auto px-4 py-4">
        <div className="grid grid-cols-12 gap-4 h-80">
          {/* Conversation List */}
          <div className="col-span-3 border-r pr-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Conversations
              </h3>
              <Button size="sm" variant="ghost" onClick={handleNewConversation}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {!hasOpenAI ? (
              <div className="text-center py-8 text-muted-foreground text-xs">
                <p>Connect OpenAI in Settings to use chat</p>
              </div>
            ) : conversations && conversations.length > 0 ? (
              <div className="space-y-2">
                {conversations.map((conv) => (
                  <div
                    key={conv.id}
                    className={`p-2 rounded cursor-pointer text-sm flex items-center justify-between group ${
                      selectedConversationId === conv.id
                        ? "bg-emerald-100 dark:bg-emerald-900/40"
                        : "hover:bg-gray-100 dark:hover:bg-slate-800"
                    }`}
                    onClick={() => setSelectedConversationId(conv.id)}
                  >
                    <span className="truncate flex-1">{conv.title}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="opacity-0 group-hover:opacity-100 h-6 w-6 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteConversation(conv.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground text-xs">
                <p>No conversations yet</p>
                <p className="mt-1">Click + to start</p>
              </div>
            )}
          </div>

          {/* Chat Messages */}
          <div className="col-span-9 flex flex-col">
            <div className="flex-1 overflow-y-auto mb-3 space-y-3">
              {!hasOpenAI ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <div className="text-center">
                    <MessageSquare className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                    <p className="text-sm">Connect OpenAI in Settings to start chatting</p>
                  </div>
                </div>
              ) : !selectedConversationId ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <div className="text-center">
                    <MessageSquare className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                    <p className="text-sm">Select a conversation or start a new one</p>
                  </div>
                </div>
              ) : messages && messages.length > 0 ? (
                <>
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[80%] p-3 rounded-lg ${
                          msg.role === "user"
                            ? "bg-emerald-700 text-white"
                            : "bg-gray-100 text-gray-900 dark:bg-slate-800 dark:text-slate-100"
                        }`}
                      >
                        {msg.role === "assistant" ? (
                          <div className="prose prose-sm max-w-none">
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                          </div>
                        ) : (
                          <p className="text-sm break-words">{msg.content}</p>
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <p className="text-sm">Start the conversation...</p>
                </div>
              )}
            </div>

            {/* Chat Input */}
            {hasOpenAI && (
              <div className="flex gap-2">
                <Input
                  value={chatMessage}
                  onChange={(e) => setChatMessage(e.target.value)}
                  placeholder="Type your message..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  disabled={sendMessagePending}
                />
                <Button
                  onClick={handleSendMessage}
                  disabled={!chatMessage.trim() || sendMessagePending}
                >
                  {sendMessagePending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
