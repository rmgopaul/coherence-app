export function buildUpcomingTuesdayLabel(date = new Date()): string {
  const local = new Date(date);
  const day = local.getDay();
  const daysUntilTuesday = (2 - day + 7) % 7 || 7;
  local.setDate(local.getDate() + daysUntilTuesday);
  return local.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function buildMonthKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
