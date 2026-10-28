/** Shared shaping helpers for Albert Heijn responses. */

export const AH_WEB = 'https://www.ah.nl';

export const productUrl = (id: number): string => `${AH_WEB}/producten/product/wi${id}`;

export const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface RawImage {
  width?: number;
  height?: number;
  url?: string;
}

/** The image closest to 200 px wide, which is plenty for a chat client. */
export function pickImage(images: RawImage[] | undefined): string | undefined {
  if (!images?.length) return undefined;
  const sorted = [...images]
    .filter((i) => i.url)
    .sort((a, b) => Math.abs((a.width ?? 0) - 200) - Math.abs((b.width ?? 0) - 200));
  return sorted[0]?.url;
}

/** Monday of the week that contains the date, as YYYY-MM-DD in Amsterdam time. */
export function mondayOf(date: Date = new Date()): string {
  const local = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const day = (local.getDay() + 6) % 7;
  local.setDate(local.getDate() - day);
  return isoDate(local);
}

export function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

/** Render a UTC timestamp in Amsterdam local time, e.g. "Thu 29 Oct 15:00". */
export function amsterdam(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString('en-GB', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function amsterdamTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
  });
}
