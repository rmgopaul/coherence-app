import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BellRing, CheckCircle2, Clock3 } from "lucide-react";

type DecisionItem = {
  id: string;
  title: string;
  detail?: string;
};

type WaitingOnItem = {
  id: string;
  title: string;
  detail?: string;
};

type DecisionsWidgetProps = {
  decisions: DecisionItem[];
  waitingOn: WaitingOnItem[];
  onSendNudge?: (item: WaitingOnItem) => void;
};

export function DecisionsWidget({ decisions, waitingOn, onSendNudge }: DecisionsWidgetProps) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Decisions &amp; Waiting</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        <section className="min-w-0">
          <p className="mb-2 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Decisions to Make
          </p>
          {decisions.length === 0 ? (
            <p className="text-sm text-slate-500">No pending decisions right now.</p>
          ) : (
            <ul className="space-y-2">
              {decisions.map((item) => (
                <li key={item.id} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
                  <p className="text-sm font-medium text-slate-900 break-words">{item.title}</p>
                  {item.detail ? <p className="mt-0.5 text-xs text-slate-600 break-words">{item.detail}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-w-0">
          <p className="mb-2 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <Clock3 className="h-3.5 w-3.5" />
            Waiting On
          </p>
          {waitingOn.length === 0 ? (
            <p className="text-sm text-slate-500">No waiting items right now.</p>
          ) : (
            <ul className="space-y-2">
              {waitingOn.map((item) => (
                <li key={item.id} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
                  <p className="text-sm font-medium text-slate-900 break-words">{item.title}</p>
                  {item.detail ? <p className="mt-0.5 text-xs text-slate-600 break-all">{item.detail}</p> : null}
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => onSendNudge?.(item)}
                    >
                      <BellRing className="h-3.5 w-3.5" />
                      Send Nudge
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

export type { DecisionItem, WaitingOnItem };
