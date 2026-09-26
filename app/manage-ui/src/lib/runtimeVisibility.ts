import releasePolicy from "../../../release-policy.json";

export const isVisibleRuntime = (runtime: string): boolean =>
  !releasePolicy.disabledRuntimes.includes(runtime);
