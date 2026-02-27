import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { useLocation } from "wouter";
import { useEffect } from "react";

export default function GmailWidget() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { data: messages, isLoading, isFetching, refetch } = trpc.google.getGmailMessages.useQuery({ maxResults: 200 }, {
    enabled: !!user,
    retry: false,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const getHeader = (message: any, headerName: string) => {
    const header = message.payload?.headers?.find((h: any) => h.name === headerName);
    return header?.value || "";
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
            <div className="p-2 rounded-lg bg-red-100 text-red-600">
              <Mail className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Gmail</h1>
              <p className="text-sm text-slate-600">View Important &amp; Unread emails</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container max-w-4xl mx-auto px-4 py-8">
        {!messages || messages.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Mail className="w-12 h-12 text-slate-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-900 mb-2">No messages</h3>
              <p className="text-slate-600">Your inbox is empty or couldn't be loaded.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                {messages.length} important unread {messages.length === 1 ? "message" : "messages"}
              </h2>
              <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
                Refresh
              </Button>
            </div>

            {messages.map((message) => {
              const from = getHeader(message, "From");
              const subject = getHeader(message, "Subject");
              const date = getHeader(message, "Date");

              return (
                <Card key={message.id} className="hover:shadow-md transition-shadow">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-base">{subject || "(No Subject)"}</CardTitle>
                        <CardDescription className="mt-1">
                          <div className="flex flex-col gap-1">
                            <div>
                              <span className="font-medium">From:</span> {from}
                            </div>
                            {date && (
                              <div>
                                <span className="font-medium">Date:</span> {new Date(date).toLocaleString()}
                              </div>
                            )}
                          </div>
                        </CardDescription>
                        {message.snippet && (
                          <p className="mt-2 text-sm text-slate-600 line-clamp-2">{message.snippet}</p>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
