import { ExternalLink } from "lucide-react";
import { Link } from "wouter";

import type { DashboardData } from "../useDashboardData";

type CommandCenterState = DashboardData["commandCenter"];
type CommandCenterData = NonNullable<CommandCenterState["data"]>;
type IntegrationHealth = CommandCenterData["integrations"][number];
type SourceFreshness = CommandCenterData["sourceFreshness"][number];

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "not seen";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not seen";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatSavedTimestamp(value: string | null | undefined): string {
  return value ? formatTimestamp(value) : "not saved";
}

function formatCommitmentProgress(
  commitments: CommandCenterData["dailyProgress"]["commitments"]
): string {
  if (commitments.total === 0) return "none tracked";
  const suffix =
    commitments.blocked > 0 ? ` - ${commitments.blocked} blocked` : "";
  return `${commitments.done}/${commitments.total} done${suffix}`;
}

function formatOutcomeProgress(
  outcomes: CommandCenterData["dailyProgress"]["outcomes"]
): string {
  if (outcomes.total === 0) return "none tracked";
  const suffix = outcomes.missed > 0 ? ` - ${outcomes.missed} missed` : "";
  return `${outcomes.won}/${outcomes.total} won${suffix}`;
}

function statusTone(status: string): string {
  switch (status) {
    case "connected":
    case "ready":
    case "server_ready":
    case "complete":
      return "ok";
    case "stale":
    case "local_only":
    case "not_started":
    case "empty":
    case "planned":
      return "warn";
    case "attention":
      return "bad";
    default:
      return "bad";
  }
}

function IntegrationRow({ item }: { item: IntegrationHealth }) {
  return (
    <li className="fp-command-integration" data-tone={statusTone(item.status)}>
      <span className="fp-command-integration__dot" aria-hidden="true" />
      <span className="fp-command-integration__label">{item.label}</span>
      <span className="mono-label">{item.status.replace("_", " ")}</span>
      {item.actionHref ? (
        <IntegrationActionLink href={item.actionHref} label={item.label} />
      ) : null}
    </li>
  );
}

function IntegrationActionLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  const content = <ExternalLink aria-hidden="true" />;
  const title = `Open ${label} action`;
  if (/^https?:\/\//i.test(href)) {
    return (
      <a
        className="fp-command-integration__action"
        href={href}
        target="_blank"
        rel="noreferrer"
        title={title}
        aria-label={title}
      >
        {content}
      </a>
    );
  }

  return (
    <Link
      className="fp-command-integration__action"
      href={href}
      title={title}
      aria-label={title}
    >
      {content}
    </Link>
  );
}

function SourceRow({ item }: { item: SourceFreshness }) {
  return (
    <li className="fp-command-source" data-tone={statusTone(item.status)}>
      <span className="fp-command-source__name">{String(item.source)}</span>
      <span className="mono-label">{formatTimestamp(item.fetchedAt)}</span>
    </li>
  );
}

export function CommandCenterPanel({ state }: { state: CommandCenterState }) {
  if (state.isLoading && !state.data) {
    return (
      <section className="fp-command" aria-label="Personal command center">
        <header className="fp-command__head">
          <h2 className="fp-command__title">COMMAND CENTER</h2>
          <span className="mono-label">LOADING</span>
        </header>
      </section>
    );
  }

  if (state.isError && !state.data) {
    return (
      <section
        className="fp-command fp-command--error"
        aria-label="Personal command center"
      >
        <header className="fp-command__head">
          <h2 className="fp-command__title">COMMAND CENTER</h2>
          <span className="mono-label">OFFLINE</span>
        </header>
        <p className="fp-command__error">
          {state.errorMessage ?? "Command center unavailable."}
        </p>
      </section>
    );
  }

  const commandCenter = state.data;
  if (!commandCenter) return null;

  const metrics = [
    ["Tasks", commandCenter.metrics.tasksDueToday],
    ["Done", commandCenter.metrics.tasksCompletedToday],
    ["Meetings", commandCenter.metrics.meetingsRemaining],
    ["Inbox", commandCenter.metrics.inboxToTriage],
    ["Waiting", commandCenter.metrics.waitingOnCount],
    ["Dock", commandCenter.metrics.dockReminderCount],
  ] as const;
  const progress = commandCenter.dailyProgress;
  const progressTitle =
    progress.topPriority ?? progress.headline ?? "No workflow saved";

  return (
    <section className="fp-command" aria-label="Personal command center">
      <header className="fp-command__head">
        <div>
          <span className="mono-label">PERSONAL OPS</span>
          <h2 className="fp-command__title">COMMAND CENTER</h2>
        </div>
        <span className="mono-label">
          UPDATED {formatTimestamp(commandCenter.generatedAt)}
        </span>
      </header>

      <div className="fp-command__grid">
        <div className="fp-command-priority">
          <span className="mono-label">RIGHT NOW</span>
          {commandCenter.rightNow ? (
            <>
              <h3 className="fp-command-priority__title">
                {commandCenter.rightNow.sourceUrl ? (
                  <a
                    href={commandCenter.rightNow.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {commandCenter.rightNow.title}
                  </a>
                ) : (
                  commandCenter.rightNow.title
                )}
              </h3>
              <p>{commandCenter.rightNow.reason}</p>
            </>
          ) : (
            <p className="fp-empty">no priority signal.</p>
          )}
        </div>

        <dl className="fp-command-metrics">
          {metrics.map(([label, value]) => (
            <div key={label} className="fp-command-metric">
              <dt className="mono-label">{label}</dt>
              <dd>{formatCount(value)}</dd>
            </div>
          ))}
        </dl>

        <div
          className="fp-command-workflow"
          data-tone={statusTone(progress.tone)}
        >
          <div className="fp-command-block__head">
            <span className="mono-label">DAILY WORKFLOW</span>
            <span className="mono-label">{progress.tone}</span>
          </div>
          <h3 className="fp-command-workflow__title">{progressTitle}</h3>
          <dl className="fp-command-workflow__statuses">
            <div>
              <dt className="mono-label">Brief</dt>
              <dd>{progress.dailyBriefStatus.replace("_", " ")}</dd>
            </div>
            <div>
              <dt className="mono-label">Plan</dt>
              <dd>{progress.todayPlanStatus.replace("_", " ")}</dd>
            </div>
            <div>
              <dt className="mono-label">Updated</dt>
              <dd>{formatSavedTimestamp(progress.updatedAt)}</dd>
            </div>
          </dl>
          <dl className="fp-command-workflow__counts">
            <div>
              <dt className="mono-label">Commitments</dt>
              <dd>{formatCommitmentProgress(progress.commitments)}</dd>
            </div>
            <div>
              <dt className="mono-label">Outcomes</dt>
              <dd>{formatOutcomeProgress(progress.outcomes)}</dd>
            </div>
          </dl>
        </div>

        <div className="fp-command-sources">
          <div className="fp-command-block__head">
            <span className="mono-label">SOURCE FRESHNESS</span>
          </div>
          <ol>
            {commandCenter.sourceFreshness.slice(0, 5).map(item => (
              <SourceRow key={String(item.source)} item={item} />
            ))}
          </ol>
        </div>

        <div className="fp-command-integrations">
          <div className="fp-command-block__head">
            <span className="mono-label">INTEGRATIONS</span>
            <span className="mono-label">
              {commandCenter.integrations.filter(i => i.connected).length}/
              {commandCenter.integrations.length}
            </span>
          </div>
          <ol>
            {commandCenter.integrations.map(item => (
              <IntegrationRow key={item.key} item={item} />
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
