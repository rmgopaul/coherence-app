/**
 * Personal Contacts overlay — Phase E (2026-04-28).
 *
 * Slide-in `Sheet` from the right of the screen. Lists every
 * personal contact grouped by staleness ("stale" → "never" → "this
 * month" → "this week" → "today"), with a search bar, an
 * Add-contact form, and a "Just talked" button per row that bumps
 * `lastContactedAt`. Editing a contact opens an inline edit panel
 * inside the same sheet — no nested dialog.
 *
 * Open with the `c` keyboard shortcut (skipped when typing in an
 * input) or via the sidebar link. Backed by the
 * `contacts.list` query and the `contacts.{create,update,
 * recordContact,archive,delete}` mutations.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  CONTACT_STALENESS,
  categorizeContactStaleness,
  filterContacts,
  formatLastContactedLabel,
  groupContactsByStaleness,
  type ContactRow,
  type ContactStaleness,
} from "@shared/contacts.helpers";

const STALENESS_LABEL: Record<ContactStaleness, string> = {
  stale: "Reach out — 30+ days",
  never: "Never logged",
  "this-month": "This month",
  "this-week": "This week",
  today: "Today",
};

const STALENESS_TONE: Record<ContactStaleness, string> = {
  stale: "border-rose-500/40 bg-rose-500/10 text-rose-700",
  never: "border-amber-500/40 bg-amber-500/10 text-amber-700",
  "this-month": "border-sky-500/40 bg-sky-500/10 text-sky-700",
  "this-week": "border-violet-500/40 bg-violet-500/10 text-violet-700",
  today: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700",
};

interface ContactsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Phase E (2026-04-28) — typed shape of a single contact row as it
 * arrives over the wire. tRPC superjson roundtrips Date instances,
 * so the front-end sees real Dates here. The `ContactRow` type
 * from shared/contacts.helpers.ts also accepts ISO strings — both
 * paths are valid.
 */
type WireContact = ContactRow;

export function ContactsOverlay({ open, onOpenChange }: ContactsOverlayProps) {
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const utils = trpc.useUtils();
  const listQuery = trpc.contacts.list.useQuery(
    { sort: "stale", limit: 500 },
    { enabled: open, staleTime: 60_000, refetchOnWindowFocus: false }
  );

  const recordContact = trpc.contacts.recordContact.useMutation({
    onSuccess: async (result) => {
      if (!result.updated) {
        toast.error("Contact vanished — refreshing.");
      } else {
        toast.success("Stamped 'Just talked.'");
      }
      await utils.contacts.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const archive = trpc.contacts.archive.useMutation({
    onSuccess: async () => {
      toast.success("Contact archived");
      await utils.contacts.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteContact = trpc.contacts.delete.useMutation({
    onSuccess: async () => {
      toast.success("Contact deleted");
      setEditingId(null);
      await utils.contacts.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const rows: WireContact[] = useMemo(
    () => (listQuery.data ?? []) as WireContact[],
    [listQuery.data]
  );
  const filtered = useMemo(
    () => filterContacts(rows, search),
    [rows, search]
  );
  const grouped = useMemo(
    () => groupContactsByStaleness(filtered),
    [filtered]
  );

  const editingRow = useMemo(
    () => rows.find((r) => r.id === editingId) ?? null,
    [rows, editingId]
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-lg w-full overflow-y-auto"
      >
        <SheetHeader className="space-y-2">
          <SheetTitle>Contacts</SheetTitle>
          <SheetDescription>
            People you want to stay in touch with — search, log a quick "just
            talked", or add someone new.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, company, notes…"
              autoFocus
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowAdd((prev) => !prev)}
            >
              {showAdd ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {showAdd ? "Close" : "Add"}
            </Button>
          </div>

          {showAdd && (
            <ContactAddForm
              onCreated={() => {
                setShowAdd(false);
                void utils.contacts.list.invalidate();
              }}
            />
          )}

          {editingRow && (
            <ContactEditForm
              contact={editingRow}
              onClose={() => setEditingId(null)}
              onArchive={() =>
                archive.mutate({ id: editingRow.id, archived: true })
              }
              onDelete={() => deleteContact.mutate({ id: editingRow.id })}
            />
          )}

          <div className="text-xs text-muted-foreground">
            {listQuery.isLoading
              ? "Loading…"
              : `${filtered.length} of ${rows.length} ${rows.length === 1 ? "contact" : "contacts"}`}
          </div>
        </div>

        <div className="mt-3 space-y-4">
          {CONTACT_STALENESS.map((bucket) => {
            const items = grouped[bucket];
            if (items.length === 0) return null;
            return (
              <div key={bucket} className="space-y-2">
                <div
                  className={`inline-flex items-center gap-2 rounded-full border px-2 py-0.5 text-xs ${STALENESS_TONE[bucket]}`}
                >
                  <span>{STALENESS_LABEL[bucket]}</span>
                  <span className="font-mono">{items.length}</span>
                </div>
                {items.map((row) => (
                  <ContactCard
                    key={row.id}
                    row={row}
                    bucket={bucket}
                    onMarkContacted={() =>
                      recordContact.mutate({ id: row.id })
                    }
                    onClearContact={() =>
                      recordContact.mutate({ id: row.id, clear: true })
                    }
                    onEdit={() => setEditingId(row.id)}
                  />
                ))}
              </div>
            );
          })}

          {!listQuery.isLoading && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">
              {rows.length === 0
                ? "No contacts yet. Click Add to start tracking someone."
                : "No contacts match your search."}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ContactCard({
  row,
  bucket,
  onMarkContacted,
  onClearContact,
  onEdit,
}: {
  row: WireContact;
  bucket: ContactStaleness;
  onMarkContacted: () => void;
  onClearContact: () => void;
  onEdit: () => void;
}) {
  const lastLabel = formatLastContactedLabel(row.lastContactedAt);
  const subline = [row.role, row.company].filter(Boolean).join(" · ");
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="flex-1 text-left"
        >
          <div className="font-medium">{row.name}</div>
          {subline ? (
            <div className="text-xs text-muted-foreground">{subline}</div>
          ) : null}
          {row.tags ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {row.tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
                .slice(0, 6)
                .map((t) => (
                  <Badge key={t} variant="outline" className="text-[10px]">
                    {t}
                  </Badge>
                ))}
            </div>
          ) : null}
        </button>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">{lastLabel}</div>
          <div className="mt-1 flex justify-end gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={onMarkContacted}
              title="Stamp lastContactedAt = now"
            >
              Just talked
            </Button>
            {bucket === "today" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={onClearContact}
                title="Undo today's stamp"
                className="px-2"
              >
                <RotateCcw className="h-3 w-3" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ContactAddForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [tags, setTags] = useState("");
  const create = trpc.contacts.create.useMutation({
    onSuccess: () => {
      toast.success("Contact added");
      setName("");
      setEmail("");
      setCompany("");
      setTags("");
      onCreated();
    },
    onError: (err) => toast.error(err.message),
  });
  const canSubmit = name.trim().length > 0 && !create.isPending;
  return (
    <form
      className="rounded-md border border-dashed border-border p-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        create.mutate({
          name: name.trim(),
          email: email.trim() || null,
          company: company.trim() || null,
          tags: tags.trim() || null,
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="contact-add-name" className="text-xs">
            Name *
          </Label>
          <Input
            id="contact-add-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="contact-add-email" className="text-xs">
            Email
          </Label>
          <Input
            id="contact-add-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
          />
        </div>
        <div>
          <Label htmlFor="contact-add-company" className="text-xs">
            Company
          </Label>
          <Input
            id="contact-add-company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="contact-add-tags" className="text-xs">
            Tags (comma-separated)
          </Label>
          <Input
            id="contact-add-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="client, vip"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {create.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
          ) : null}
          Add
        </Button>
      </div>
    </form>
  );
}

function ContactEditForm({
  contact,
  onClose,
  onArchive,
  onDelete,
}: {
  contact: WireContact;
  onClose: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState({
    name: contact.name,
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    role: contact.role ?? "",
    company: contact.company ?? "",
    tags: contact.tags ?? "",
    notes: contact.notes ?? "",
  });
  // Re-seed when the editing contact changes (e.g. user clicked
  // a different row). Without this, opening row B would keep
  // showing row A's draft.
  useEffect(() => {
    setDraft({
      name: contact.name,
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      role: contact.role ?? "",
      company: contact.company ?? "",
      tags: contact.tags ?? "",
      notes: contact.notes ?? "",
    });
  }, [contact]);
  const utils = trpc.useUtils();
  const update = trpc.contacts.update.useMutation({
    onSuccess: async () => {
      toast.success("Saved");
      await utils.contacts.list.invalidate();
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  const canSubmit = draft.name.trim().length > 0 && !update.isPending;
  return (
    <div className="rounded-md border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          Editing · {categorizeContactStaleness(contact.lastContactedAt)}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          aria-label="Close edit"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="contact-edit-name" className="text-xs">
            Name *
          </Label>
          <Input
            id="contact-edit-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="contact-edit-email" className="text-xs">
            Email
          </Label>
          <Input
            id="contact-edit-email"
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            type="email"
          />
        </div>
        <div>
          <Label htmlFor="contact-edit-phone" className="text-xs">
            Phone
          </Label>
          <Input
            id="contact-edit-phone"
            value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="contact-edit-role" className="text-xs">
            Role
          </Label>
          <Input
            id="contact-edit-role"
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="contact-edit-company" className="text-xs">
            Company
          </Label>
          <Input
            id="contact-edit-company"
            value={draft.company}
            onChange={(e) => setDraft({ ...draft, company: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="contact-edit-tags" className="text-xs">
            Tags
          </Label>
          <Input
            id="contact-edit-tags"
            value={draft.tags}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="contact-edit-notes" className="text-xs">
          Notes
        </Label>
        <Textarea
          id="contact-edit-notes"
          value={draft.notes}
          rows={3}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </div>
      <div className="flex justify-between">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onArchive}
            title="Hide from default view"
          >
            Archive
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-rose-700"
            onClick={() => {
              if (
                window.confirm(`Permanently delete ${contact.name}?`)
              ) {
                onDelete();
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            Delete
          </Button>
        </div>
        <Button
          size="sm"
          disabled={!canSubmit}
          onClick={() =>
            update.mutate({
              id: contact.id,
              name: draft.name.trim(),
              email: draft.email.trim() || null,
              phone: draft.phone.trim() || null,
              role: draft.role.trim() || null,
              company: draft.company.trim() || null,
              tags: draft.tags.trim() || null,
              notes: draft.notes.trim() || null,
            })
          }
        >
          {update.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
          ) : null}
          Save
        </Button>
      </div>
    </div>
  );
}

export default ContactsOverlay;
