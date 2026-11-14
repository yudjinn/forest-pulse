// One structured JSON line per decision, read in Workers Logs. Never pass a password, key or cookie.
export function logLine(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
