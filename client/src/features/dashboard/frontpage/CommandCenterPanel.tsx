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

function statusTone(status: string): string {
  switch (status) {
    case "connected":
    case "ready":
    case "server_ready":
      return "ok";
    case "stale":
    case "local_only":
    case "not_started":
      return "warn";
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
    </li>
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
