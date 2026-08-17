import consola from "consola"

const MIN_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 5 * 60_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Retries `fn` with exponential backoff (5s -> 5min cap) instead of letting
// its rejection propagate. GitHub's Copilot endpoints have transient outages
// (502/503) that used to crash the whole server on the first failed call —
// on startup that meant launchd's respawn loop burned through its
// crash-loop budget and gave up entirely, requiring a manual
// `launchctl kickstart` even after GitHub recovered. Retrying in-process
// lets the server come up (or keep running) and self-heal once the upstream
// outage clears, with no outside intervention.
export async function retryWithBackoff<T>(
  context: string,
  fn: () => Promise<T>,
): Promise<T> {
  let delay = MIN_RETRY_DELAY_MS
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      consola.error(
        `Failed to ${context} (retrying in ${Math.round(delay / 1000)}s):`,
        error,
      )
      await sleep(delay)
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
    }
  }
}
