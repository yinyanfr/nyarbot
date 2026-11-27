export function withTimeout(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// grammY's Node adapter types use the polyfill; node-fetch also accepts native signals.
export function telegramSignal(signal: AbortSignal | undefined): Parameters<Api["getFile"]>[1] {
  return signal as unknown as Parameters<Api["getFile"]>[1];
}

export function waitForAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
import type { Api } from "grammy";
