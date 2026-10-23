// Expand grouped tool names and aliases into the existing flat translation
// keys. Group prefixes and shared wording need only one copy in the bundle.
type Labels = Record<string, string | Record<string, string>>;
type FlatLabels<T extends Labels> = {
  [K in keyof T as T[K] extends string ? K : `${K & string}_${keyof T[K] & string}`]: string;
};
type Alias = `shoggoth_${"skill_read" | "skill_file_read" | "plugin_resource_read"}`
  | `external_agent_${"create" | "update" | "list" | "get" | "run"}` | "external_cron_list";
export function productToolLabels<T extends Labels>(labels: T): FlatLabels<T> & Record<Alias, string> {
  const result: Record<string, string> = {};
  for (const [prefix, value] of Object.entries(labels)) {
    if (typeof value === "string") result[prefix] = value;
    else for (const [name, text] of Object.entries(value)) result[`${prefix}_${name}`] = text;
  }
  for (const key of ["skill_read", "skill_file_read", "plugin_resource_read"]) result[`shoggoth_${key}`] = result[key];
  for (const action of ["create", "update"]) result[`external_agent_${action}`] = result[`native_agent_${action}`];
  for (const action of ["list", "get", "run"]) result[`external_agent_${action}`] = result[`federation_agent_${action}`];
  result.external_cron_list = result.cron_list;
  return result as FlatLabels<T> & Record<Alias, string>;
}
