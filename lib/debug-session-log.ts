/** Debug-mode NDJSON ingest (session acd53a). Remove after verification. */
export function debugSessionLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = 'pre-fix',
): void {
  // #region agent log
  fetch('http://127.0.0.1:7488/ingest/1aa19189-3291-441a-aa5d-1b07eacb3a64', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'acd53a' },
    body: JSON.stringify({
      sessionId: 'acd53a',
      runId: process.env.DEBUG_RUN_ID ?? runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}
