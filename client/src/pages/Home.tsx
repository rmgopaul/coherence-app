import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { APP_LOGO, APP_TITLE, getLoginUrl } from "@/const";
import { useLocation } from "wouter";

export default function Home() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  // Redirect to dashboard if already logged in
  if (user && !loading) {
    setLocation("/dashboard");
    return null;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto text-center">
          <div className="mb-8">
            <h1 className="text-5xl font-bold text-slate-900 mb-4">
              Welcome to {APP_TITLE}
            </h1>
            <p className="text-xl text-slate-600 mb-8">
              Your unified productivity dashboard - bringing together Todoist, Google Calendar, Gmail, OneNote, and ChatGPT in one seamless experience
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
            <div className="bg-white/80 backdrop-blur-sm rounded-lg p-6 shadow-sm">
              <div className="text-4xl mb-4">📋</div>
              <h3 className="text-lg font-semibold text-slate-900 mb-2">Task Management</h3>
              <p className="text-slate-600">Sync and manage your Todoist tasks alongside your calendar and emails</p>
            </div>
            <div className="bg-white/80 backdrop-blur-sm rounded-lg p-6 shadow-sm">
              <div className="text-4xl mb-4">📅</div>
              <h3 className="text-lg font-semibold text-slate-900 mb-2">Calendar Integration</h3>
              <p className="text-slate-600">View and manage Google Calendar events in one unified interface</p>
            </div>
            <div className="bg-white/80 backdrop-blur-sm rounded-lg p-6 shadow-sm">
              <div className="text-4xl mb-4">🤖</div>
              <h3 className="text-lg font-semibold text-slate-900 mb-2">AI Assistant</h3>
              <p className="text-slate-600">Get help from ChatGPT to organize your tasks and schedule</p>
            </div>
          </div>

          <div className="bg-white/80 backdrop-blur-sm rounded-lg p-8 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900 mb-4">Supported Integrations</h2>
            <div className="flex flex-wrap justify-center gap-4">
              <span className="px-4 py-2 bg-red-100 text-red-700 rounded-full font-medium">Todoist</span>
              <span className="px-4 py-2 bg-blue-100 text-blue-700 rounded-full font-medium">Google Calendar</span>
              <span className="px-4 py-2 bg-red-100 text-red-700 rounded-full font-medium">Gmail</span>
              <span className="px-4 py-2 bg-purple-100 text-purple-700 rounded-full font-medium">OneNote</span>
              <span className="px-4 py-2 bg-green-100 text-green-700 rounded-full font-medium">ChatGPT</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
