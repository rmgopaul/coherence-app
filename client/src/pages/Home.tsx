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
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-sm text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-emerald-50 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto text-center">
          <div className="mb-8">
            <h1 className="text-5xl font-bold text-slate-900 dark:text-slate-100 mb-4">
              Welcome to {APP_TITLE}
            </h1>
            <p className="text-xl text-slate-600 dark:text-slate-300 mb-8">
              Your operations dashboard for daily workflows and portfolio analytics.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
            <Button size="lg" onClick={() => window.location.href = getLoginUrl()}>
              Get Started
            </Button>
            <Button size="lg" variant="outline" onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })}>
              Learn More
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16 text-left">
            <div className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm rounded-lg p-6 shadow-sm border border-transparent dark:border-slate-700/70">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Portfolio Analytics</h3>
              <p className="text-slate-600 dark:text-slate-300 text-sm">Solar REC, ownership, delivery, and reporting status.</p>
            </div>
            <div className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm rounded-lg p-6 shadow-sm border border-transparent dark:border-slate-700/70">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Daily Operations</h3>
              <p className="text-slate-600 dark:text-slate-300 text-sm">Email, calendar, tasks, notes, and daily decision support.</p>
            </div>
            <div className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm rounded-lg p-6 shadow-sm border border-transparent dark:border-slate-700/70">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Automation + Exports</h3>
              <p className="text-slate-600 dark:text-slate-300 text-sm">Deep-update synthesis, CSV export, and integration tooling.</p>
            </div>
          </div>

          <div className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm rounded-lg p-8 shadow-sm border border-transparent dark:border-slate-700/70">
            <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100 mb-4">Supported Integrations</h2>
            <div className="flex flex-wrap justify-center gap-4">
              <span className="px-4 py-2 bg-red-100 text-red-700 rounded-full font-medium">Todoist</span>
              <span className="px-4 py-2 bg-emerald-100 text-emerald-800 rounded-full font-medium">Google Calendar</span>
              <span className="px-4 py-2 bg-red-100 text-red-700 rounded-full font-medium">Gmail</span>
              <span className="px-4 py-2 bg-green-100 text-green-700 rounded-full font-medium">ChatGPT</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
