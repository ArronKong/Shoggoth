"use strict";

const RETIRED_PLUGIN_TOOLS = Object.freeze(["plugin_create", "plugin_install", "plugin_status",
  "plugin_setup_get", "plugin_secret_request", "plugin_activate", "plugin_resource_read",
  "shoggoth_plugin_call", "shoggoth_plugin_resource_read", "shoggoth_plugin_search"]);
const RETIRED_CONNECTOR_TOOLS = Object.freeze(["connector_list_apps", "connector_list_connections", "connector_search_actions", "connector_get_action_guide", "connector_execute_action"]);
const EXPLICIT_DEPENDENCY = new RegExp(`(?:^|[^A-Za-z0-9_])(?:${[...RETIRED_PLUGIN_TOOLS, ...RETIRED_CONNECTOR_TOOLS].join("|")})(?=$|[^A-Za-z0-9_])|plugin\\.[a-f0-9]{64}`, "u");
// Only explicit retired protocol identifiers can be classified. A service's
// name in ordinary prose is not evidence of a plugin binding or authorization.
function requiresConnectorMigration(value) {
  return !!value && (Object.hasOwn(value, "pluginSelection") || Object.hasOwn(value, "connectorSelection")
    || typeof value.prompt === "string" && EXPLICIT_DEPENDENCY.test(value.prompt));
}
module.exports = { RETIRED_PLUGIN_TOOLS, requiresConnectorMigration };
