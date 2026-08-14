import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 1234 → "1.2k", 12_345_678 → "12.3M" — compact token counts for the
 *  harness rows and picker tooltips. Whole numbers below 1000 pass through. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function abbreviateHome(p: string, homeDir: string): string {
  if (!homeDir) return p;
  if (p === homeDir) return "~";
  if (p.startsWith(homeDir + "/")) return "~" + p.slice(homeDir.length);
  return p;
}
