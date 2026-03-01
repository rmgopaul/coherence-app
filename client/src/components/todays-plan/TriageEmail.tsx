import { Button } from "@/components/ui/button";
import { Archive, Reply, SquareCheckBig } from "lucide-react";

type TriageEmailData = {
  id: string;
  sender: string;
  subject: string;
  preview: string;
};

type TriageEmailProps = {
  email: TriageEmailData;
  onReply?: (email: TriageEmailData) => void;
  onArchive?: (email: TriageEmailData) => void;
  onMakeTask?: (email: TriageEmailData) => void;
};

export function TriageEmail({ email, onReply, onArchive, onMakeTask }: TriageEmailProps) {
  return (
    <article className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <p className="line-clamp-2 break-all text-xs font-semibold uppercase tracking-wide text-slate-500">{email.sender}</p>
      <h4 className="mt-1 line-clamp-2 break-words text-sm font-semibold text-slate-900">{email.subject}</h4>
      <p className="mt-1 line-clamp-2 break-words text-xs text-slate-600">{email.preview}</p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => (onReply ? onReply(email) : console.log("[TriageEmail] Reply", email))}
        >
          <Reply className="h-3.5 w-3.5" />
          Reply
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => (onArchive ? onArchive(email) : console.log("[TriageEmail] Archive", email))}
        >
          <Archive className="h-3.5 w-3.5" />
          Archive
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => (onMakeTask ? onMakeTask(email) : console.log("[TriageEmail] Make Task", email))}
        >
          <SquareCheckBig className="h-3.5 w-3.5" />
          Make Task
        </Button>
      </div>
    </article>
  );
}

export type { TriageEmailData };
