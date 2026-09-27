// Calendar helpers. The sales day is the Asia/Tokyo date.

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function jstDate(at: Date): string {
  return new Date(at.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}
