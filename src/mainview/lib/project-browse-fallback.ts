import { ApiError } from "./api";

/** True only for the exact "no native bridge in this session" signal
 *  `notAvailableHeadless` returns (`server.ts`) — never pattern-matched on
 *  message text. Any other failure (network error, non-501 ApiError, a
 *  thrown non-Error) must NOT trigger the headless-picker fallback (AC-8). */
export function shouldFallbackToHeadlessPicker(error: unknown): boolean {
  return error instanceof ApiError && error.status === 501;
}
