import releasePolicy from "../../../release-policy.json";

// An empty JSON array imports as never[]; the policy lists runtime ids.
const disabledRuntimes: readonly string[] = releasePolicy.disabledRuntimes;

export const isVisibleRuntime = (runtime: string): boolean =>
  !disabledRuntimes.includes(runtime);
