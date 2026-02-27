import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Loader2, BookOpen, FileText } from "lucide-react";
import { useLocation } from "wouter";
import { useEffect } from "react";

export default function OneNoteWidget() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  const { data: integrations, isLoading: integrationsLoading } = trpc.integrations.list.useQuery(undefined, {
    enabled: !!user,
  });

  const hasMicrosoft = integrations?.some((i) => i.provider === "microsoft");

  const { data: notebooks, isLoading: notebooksLoading } = trpc.microsoft.getNotebooks.useQuery(undefined, {
    enabled: !!user && hasMicrosoft,
    retry: false,
  });

  const { data: pages, isLoading: pagesLoading } = trpc.microsoft.getPages.useQuery(undefined, {
    enabled: !!user && hasMicrosoft,
    retry: false,
  });

  useEffect(() => {
    if (!loading && !user) {
      setLocation("/");
    }
  }, [loading, user, setLocation]);

  if (loading || integrationsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (!hasMicrosoft) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 p-8">
        <div className="max-w-4xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle>Microsoft OneNote Not Connected</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">
                Please connect your Microsoft account in Settings to access OneNote.
              </p>
              <Button onClick={() => setLocation("/settings")}>Go to Settings</Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <Button variant="outline" onClick={() => setLocation("/dashboard")}>
            ← Back to Dashboard
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Notebooks */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                Notebooks
              </CardTitle>
            </CardHeader>
            <CardContent>
              {notebooksLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                </div>
              ) : notebooks && notebooks.length > 0 ? (
                <div className="space-y-2">
                  {notebooks.map((notebook: any) => (
                    <a
                      key={notebook.id}
                      href={notebook.links?.oneNoteWebUrl?.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block p-3 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <div className="font-medium text-gray-900">{notebook.displayName}</div>
                      <div className="text-sm text-gray-500">
                        Modified: {new Date(notebook.lastModifiedDateTime).toLocaleDateString()}
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">No notebooks found</p>
              )}
            </CardContent>
          </Card>

          {/* Recent Pages */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Recent Pages
              </CardTitle>
            </CardHeader>
            <CardContent>
              {pagesLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                </div>
              ) : pages && pages.length > 0 ? (
                <div className="space-y-2">
                  {pages.map((page: any) => (
                    <a
                      key={page.id}
                      href={page.links?.oneNoteWebUrl?.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block p-3 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <div className="font-medium text-gray-900">{page.title}</div>
                      <div className="text-sm text-gray-500">
                        Modified: {new Date(page.lastModifiedDateTime).toLocaleDateString()}
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">No pages found</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

