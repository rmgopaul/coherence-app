import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { useLocation } from "wouter";
import { useEffect, useMemo, useState } from "react";

const GMAIL_PAGE_SIZE = 25;

export default function GmailWidget() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [senderDomainFilter, setSenderDomainFilter] = useState("all");
  const [page, setPage] = useState(1);
  const { data: messages, isLoading, isFetching, refetch } = trpc.google.getGmailMessages.useQuery({ maxResults: 100 }, {
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

  const getHeader = (message: any, headerName: string) => {
    const header = message.payload?.headers?.find((h: any) => h.name === headerName);
    return header?.value || "";
  };

  const messageRows = useMemo(() => {
    return (messages || []).map((message) => {
      const from = getHeader(message, "From");
      const subject = getHeader(message, "Subject");
      const date = getHeader(message, "Date");
      const fromDomainMatch = from.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
      const fromDomain = fromDomainMatch ? fromDomainMatch[1].toLowerCase() : "unknown";
      return { message, from, subject, date, fromDomain };
    });
  }, [messages]);

  const senderDomainOptions = useMemo(() => {
    return Array.from(new Set(messageRows.map((row) => row.fromDomain)))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [messageRows]);

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return messageRows.filter((row) => {
      if (senderDomainFilter !== "all" && row.fromDomain !== senderDomainFilter) return false;
      if (!query) return true;
      const haystack = `${row.from} ${row.subject} ${row.message.snippet || ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [messageRows, searchQuery, senderDomainFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / GMAIL_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStartIndex = (currentPage - 1) * GMAIL_PAGE_SIZE;
  const pageEndIndex = pageStartIndex + GMAIL_PAGE_SIZE;
  const visibleRows = filteredRows.slice(pageStartIndex, pageEndIndex);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, senderDomainFilter]);

  useEffect(() => {
    if (page <= totalPages) return;
    setPage(totalPages);
  }, [page, totalPages]);

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
        {filteredRows.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Mail className="w-12 h-12 text-slate-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-900 mb-2">
                {(messages?.length ?? 0) === 0 ? "No messages" : "No messages match these filters"}
              </h3>
              <p className="text-slate-600">
                {(messages?.length ?? 0) === 0
                  ? "Your inbox is empty or couldn't be loaded."
                  : "Try clearing your search or sender domain filter."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                {filteredRows.length} important unread {filteredRows.length === 1 ? "message" : "messages"}
              </h2>
              <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
                Refresh
              </Button>
            </div>

            <Card>
              <CardContent className="pt-4">
                <div className="grid gap-2 md:grid-cols-3">
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search subject, sender, snippet..."
                    className="md:col-span-2"
                  />
                  <select
                    value={senderDomainFilter}
                    onChange={(event) => setSenderDomainFilter(event.target.value)}
                    className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                  >
                    <option value="all">All sender domains</option>
                    {senderDomainOptions.map((domain) => (
                      <option key={domain} value={domain}>
                        {domain}
                      </option>
                    ))}
                  </select>
                </div>
              </CardContent>
            </Card>

            {visibleRows.map(({ message, from, subject, date }) => {

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

            <div className="flex items-center justify-between text-sm text-slate-600">
              <span>
                Showing {visibleRows.length} of {filteredRows.length}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={currentPage <= 1}
                >
                  Previous
                </Button>
                <span>
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={currentPage >= totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
