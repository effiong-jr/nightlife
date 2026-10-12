// Date labels shared by server and client components.

// "2026-10-12" -> "12 Oct"
export function dayLabel(isoDate: string): string {
  return new Date(`${isoDate.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
