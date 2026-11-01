// Keep the pinned upstream policies while honoring the Product setting's
// existing ten-minute range, including its five-minute default. Both config
// normalization and the plugin hook watchdog import this same upper bound.
export * from "upstream:extensions/active-memory/types.ts";
export const MAX_TIMEOUT_MS = 600_000;
