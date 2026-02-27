import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Calendar, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useLocation } from "wouter";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function GoogleCalendarWidget() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { data: events, isLoading, error, refetch } = trpc.google.getCalendarEvents.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refetch();
      toast.success("Calendar refreshed!");
    } catch (err) {
      toast.error(`Failed to refresh: ${(err as Error).message}`);
    } finally {
      setIsRefreshing(false);
    }
  };

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

  const formatDate = (dateTime?: string, date?: string) => {
    const d = new Date(dateTime || date || "");
    if (date && !dateTime) {
      return d.toLocaleDateString();
    }
    return d.toLocaleString();
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
            <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
              <Calendar className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Google Calendar</h1>
              <p className="text-sm text-slate-600">View your upcoming events</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container max-w-4xl mx-auto px-4 py-8">
        {error && (
          <Card className="mb-4 border-red-200 bg-red-50">
            <CardContent className="py-4">
              <p className="text-red-800 font-medium">Error loading calendar events:</p>
              <p className="text-red-600 text-sm mt-1">{error.message}</p>
              <Button variant="outline" onClick={handleRefresh} className="mt-3" size="sm">
                <RefreshCw className="w-4 h-4 mr-2" />
                Try Again
              </Button>
            </CardContent>
          </Card>
        )}
        {!events || events.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Calendar className="w-12 h-12 text-slate-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-900 mb-2">No upcoming events</h3>
              <p className="text-slate-600">You don't have any upcoming events in your calendar.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                {events.length} upcoming {events.length === 1 ? "event" : "events"}
              </h2>
              <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
                <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>

            {events.map((event) => (
              <Card key={event.id} className="hover:shadow-md transition-shadow">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-base">{event.summary || "Untitled Event"}</CardTitle>
                      {event.description && <CardDescription className="mt-1">{event.description}</CardDescription>}
                      <div className="flex flex-col gap-1 mt-2 text-sm text-slate-600">
                        <div>
                          <span className="font-medium">Start:</span>{" "}
                          {formatDate(event.start.dateTime, event.start.date)}
                        </div>
                        <div>
                          <span className="font-medium">End:</span> {formatDate(event.end.dateTime, event.end.date)}
                        </div>
                        {event.location && (
                          <div>
                            <span className="font-medium">Location:</span> {event.location}
                          </div>
                        )}
                      </div>
                    </div>
                    <a
                      href={event.htmlLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-700"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

