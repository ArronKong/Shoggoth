// Remote embedding helpers consume already resolved values; config IO and
// session-directory discovery belong to the Shoggoth Service.
export { hasConfiguredSecretInput, normalizeResolvedSecretInputString } from "upstream:src/config/types.secrets.ts";
