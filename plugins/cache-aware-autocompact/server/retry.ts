export const RETRY_DELAY_MS = 2 * 60_000;
export const MAX_RETRIES = 3;

export function retryableSkip(reason: string): boolean {
  return reason === "running-tool" || reason === "not-idle";
}

export function nextRetryCount(reason: string, current: number): number | null {
  if (!retryableSkip(reason) || current >= MAX_RETRIES) return null;
  return current + 1;
}
