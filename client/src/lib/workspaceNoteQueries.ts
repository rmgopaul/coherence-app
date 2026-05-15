import { trpc } from "@/lib/trpc";

export function invalidateWorkspaceNoteQueries(
  utils: ReturnType<typeof trpc.useUtils>
) {
  void utils.notes.list.invalidate();
  void utils.notes.listForExternal.invalidate();
  void utils.notes.countLinksByExternalIds.invalidate();
}
