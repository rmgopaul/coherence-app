import type { PlanItemData } from "./types";

const STORAGE_PREFIX = "todays-plan-overrides:v1:";

export type PersistedPlanOverrides = {
  addedItems: PlanItemData[];
  removedIds: string[];
  orderedIds: string[];
};

const defaultOverrides = (): PersistedPlanOverrides => ({
  addedItems: [],
  removedIds: [],
  orderedIds: [],
});

const keyForDate = (dateKey: string): string => `${STORAGE_PREFIX}${dateKey}`;

export const loadPlanOverrides = (
  dateKey: string,
  storage?: Pick<Storage, "getItem">
): PersistedPlanOverrides => {
  const targetStorage =
    storage ||
    (typeof window !== "undefined" && window.localStorage ? window.localStorage : undefined);
  if (!targetStorage) return defaultOverrides();

  try {
    const raw = targetStorage.getItem(keyForDate(dateKey));
    if (!raw) return defaultOverrides();
    const parsed = JSON.parse(raw) as Partial<PersistedPlanOverrides> | null;
    const addedItems = Array.isArray(parsed?.addedItems) ? (parsed?.addedItems as PlanItemData[]) : [];
    const removedIds = Array.isArray(parsed?.removedIds)
      ? parsed?.removedIds.filter((id): id is string => typeof id === "string")
      : [];
    const orderedIds = Array.isArray(parsed?.orderedIds)
      ? parsed?.orderedIds.filter((id): id is string => typeof id === "string")
      : [];
    return { addedItems, removedIds, orderedIds };
  } catch {
    return defaultOverrides();
  }
};

export const savePlanOverrides = (
  dateKey: string,
  overrides: PersistedPlanOverrides,
  storage?: Pick<Storage, "setItem">
): void => {
  const targetStorage =
    storage ||
    (typeof window !== "undefined" && window.localStorage ? window.localStorage : undefined);
  if (!targetStorage) return;

  try {
    targetStorage.setItem(keyForDate(dateKey), JSON.stringify(overrides));
  } catch {
    // Ignore storage write errors (quota/private mode).
  }
};

export const mergePlanWithOverrides = (
  autoItems: PlanItemData[],
  overrides: PersistedPlanOverrides
): PlanItemData[] => {
  const removed = new Set(overrides.removedIds);
  const autoVisible = autoItems.filter((item) => !removed.has(item.id));
  const addedVisible = (overrides.addedItems || []).filter((item) => !removed.has(item.id));

  const deduped = new Map<string, PlanItemData>();
  for (const item of [...autoVisible, ...addedVisible]) {
    deduped.set(item.id, item);
  }

  const orderedIds = overrides.orderedIds || [];
  const orderedIndex = new Map<string, number>();
  orderedIds.forEach((id, index) => orderedIndex.set(id, index));

  return Array.from(deduped.values()).sort((a, b) => {
    const aOrder = orderedIndex.get(a.id);
    const bOrder = orderedIndex.get(b.id);
    if (typeof aOrder === "number" && typeof bOrder === "number" && aOrder !== bOrder) return aOrder - bOrder;
    if (typeof aOrder === "number" && typeof bOrder !== "number") return -1;
    if (typeof aOrder !== "number" && typeof bOrder === "number") return 1;
    if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });
};

export const addOverrideItem = (
  overrides: PersistedPlanOverrides,
  item: PlanItemData
): PersistedPlanOverrides => {
  if (overrides.addedItems.some((existing) => existing.id === item.id)) return overrides;
  return {
    addedItems: [...overrides.addedItems, item],
    removedIds: overrides.removedIds.filter((id) => id !== item.id),
    orderedIds: overrides.orderedIds.includes(item.id) ? overrides.orderedIds : [...overrides.orderedIds, item.id],
  };
};

export const removePlanItemOverride = (
  overrides: PersistedPlanOverrides,
  itemId: string
): PersistedPlanOverrides => {
  const nextAdded = overrides.addedItems.filter((item) => item.id !== itemId);
  const removedIds = overrides.removedIds.includes(itemId)
    ? overrides.removedIds
    : [...overrides.removedIds, itemId];
  return {
    addedItems: nextAdded,
    removedIds,
    orderedIds: overrides.orderedIds.filter((id) => id !== itemId),
  };
};

export const setPlanOrderOverride = (
  overrides: PersistedPlanOverrides,
  orderedIds: string[]
): PersistedPlanOverrides => {
  const seen = new Set<string>();
  const normalized = orderedIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    ...overrides,
    orderedIds: normalized,
  };
};
