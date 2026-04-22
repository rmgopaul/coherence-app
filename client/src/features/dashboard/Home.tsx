import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { APP_LOGO, APP_TITLE, getLoginUrl } from "@/const";
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function Home() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!loading && user) {
      setLocation("/dashboard");
    }
  }, [loading, setLocation, user]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-secondary via-background to-accent dark:from-background dark:via-background dark:to-accent/20">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto text-center">
          <div className="mb-8">
            <img
              src={APP_LOGO}
              alt={`${APP_TITLE} logo`}
              className="mx-auto mb-6 size-16 rounded-xl object-cover shadow-md ring-1 ring-primary/20"
            />
            <h1 className="text-5xl font-bold text-foreground mb-4">
              Welcome to {APP_TITLE}
            </h1>
            <p className="text-xl text-muted-foreground mb-8">
              Your operations dashboard for daily workflows and portfolio analytics.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
            <Button size="lg" onClick={() => window.location.href = getLoginUrl()}>
              Get Started
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16 text-left">
            <div className="bg-card/80 backdrop-blur-sm rounded-lg p-6 shadow-sm border">
              <h3 className="text-lg font-semibold text-foreground mb-1">Portfolio Analytics</h3>
              <p className="text-muted-foreground text-sm">Solar REC, ownership, delivery, and reporting status.</p>
            </div>
            <div className="bg-card/80 backdrop-blur-sm rounded-lg p-6 shadow-sm border">
              <h3 className="text-lg font-semibold text-foreground mb-1">Daily Operations</h3>
              <p className="text-muted-foreground text-sm">Email, calendar, tasks, notes, and daily decision support.</p>
            </div>
            <div className="bg-card/80 backdrop-blur-sm rounded-lg p-6 shadow-sm border">
              <h3 className="text-lg font-semibold text-foreground mb-1">Automation + Exports</h3>
              <p className="text-muted-foreground text-sm">Deep-update synthesis, CSV export, and integration tooling.</p>
            </div>
          </div>

          <div className="bg-card/80 backdrop-blur-sm rounded-lg p-8 shadow-sm border">
            <h2 className="text-2xl font-bold text-foreground mb-4">Supported Integrations</h2>
            <div className="flex flex-wrap justify-center gap-3">
              <span className="px-4 py-2 bg-destructive/10 text-destructive rounded-full text-sm font-medium">Todoist</span>
              <span className="px-4 py-2 bg-primary/10 text-primary rounded-full text-sm font-medium">Google Calendar</span>
              <span className="px-4 py-2 bg-destructive/10 text-destructive rounded-full text-sm font-medium">Gmail</span>
              <span className="px-4 py-2 bg-health/10 text-health rounded-full text-sm font-medium">ChatGPT</span>
              <span className="px-4 py-2 bg-health/10 text-health rounded-full text-sm font-medium">WHOOP</span>
              <span className="px-4 py-2 bg-health/10 text-health rounded-full text-sm font-medium">Samsung Health</span>
              <span className="px-4 py-2 bg-energy/10 text-energy rounded-full text-sm font-medium">Enphase</span>
              <span className="px-4 py-2 bg-energy/10 text-energy rounded-full text-sm font-medium">SolarEdge</span>
              <span className="px-4 py-2 bg-energy/10 text-energy rounded-full text-sm font-medium">Tesla Solar</span>
              <span className="px-4 py-2 bg-ai/10 text-ai rounded-full text-sm font-medium">Zendesk</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
