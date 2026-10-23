// Logging policy belongs to Shoggoth. Keep upstream's default redaction rules
// without consulting another application's configuration or environment.
export function readLoggingConfig() { return { redactSensitive: "tools" as const }; }
