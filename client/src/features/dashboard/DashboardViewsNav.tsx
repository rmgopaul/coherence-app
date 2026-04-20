/**
 * DashboardViewsNav — visible tab strip for the 5 dashboard "vibes".
 *
 * Renders on every /dashboard* route. Mirrors the wireframe's
 * "pick a vibe ↴" header. Each tab labels its keyboard shortcut so
 * the 1-5 digit switcher in KeyboardShortcuts.tsx is discoverable
 * without reading the help dialog.
 *
 * Mount at the very top of each dashboard page (after the Masthead
 * on Front Page, at the top of the others).
 */
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";

interface View {
  path: string;
  label: string;
  kbd: string;
}

const VIEWS: View[] = [
  { path: "/dashboard", label: "Front Page", kbd: "1" },
  { path: "/dashboard/one-thing", label: "One Thing", kbd: "2" },
  { path: "/dashboard/river", label: "River", kbd: "3" },
  { path: "/dashboard/canvas", label: "Canvas", kbd: "4" },
  { path: "/dashboard/command", label: "Command Deck", kbd: "5" },
];

export function DashboardViewsNav() {
  const [location] = useLocation();

  return (
    <nav className="fp-views-nav" aria-label="Dashboard views">
      <span className="fp-views-nav__lbl">pick a vibe ↴</span>
      {VIEWS.map((v) => {
        const active = location === v.path;
        return (
          <Link
            key={v.path}
            href={v.path}
            className={cn("fp-views-nav__tab", active && "fp-views-nav__tab--on")}
            aria-current={active ? "page" : undefined}
          >
            <kbd className="fp-views-nav__kbd">{v.kbd}</kbd>
            <span className="fp-views-nav__label">{v.label}</span>
          </Link>
        );
      })}
      <span className="fp-views-nav__hint mono-label">PRESS 1–5</span>
    </nav>
  );
}

export default DashboardViewsNav;
