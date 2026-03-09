/**
 * Gnosys Retry Logic — Exponential backoff for LLM calls and transient failures.
 */

export interface RetryOptions {
  /** Max number of retry attempts (default: 3) */
  maxAttempts: number;
  /** Base delay in ms (default: 1000) */
  baseDelayMs: number;
  /** Whether to use exponential backoff (default: true) */
  exponential: boolean;
  /** Optional callback on each retry */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** Predicate to decide if error is retryable (default: all errors) */
  isRetryable?: (error: Error) => boolean;
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  exponential: true,
};

/**
 * Default retryable-error check: retries on rate limits, timeouts, and transient server errors.
 */
export function isTransientError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  // Rate limit (429)
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) return true;
  // Timeouts
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("econnreset")) return true;
  // Server errors (5xx)
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("overloaded")) return true;
  // Network errors
  if (msg.includes("enotfound") || msg.includes("econnrefused") || msg.includes("fetch failed")) return true;
  return false;
}

/**
 * Execute an async function with retry logic.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_RETRY, ...options };
  const isRetryable = opts.isRetryable || isTransientError;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on non-retryable errors or after last attempt
      if (attempt > opts.maxAttempts || !isRetryable(lastError)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff + jitter
      const expDelay = opts.exponential
        ? opts.baseDelayMs * Math.pow(2, attempt - 1)
        : opts.baseDelayMs;
      const jitter = Math.random() * opts.baseDelayMs * 0.5;
      const delayMs = Math.round(expDelay + jitter);

      opts.onRetry?.(attempt, lastError, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("Retry exhausted");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
