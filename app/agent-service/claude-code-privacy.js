"use strict";

const CLAUDE_PRIVACY_FLAGS = Object.freeze([
  "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DO_NOT_TRACK", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
]);
const LAUNCH_AGENT_OPT_OUTS = "SHOGGOTH_CLAUDE_CODE_OPT_OUTS";

// launchd starts the Service independently of the desktop. Store only the
// names of enabled opt-outs so generic flags do not apply to other runtimes.
function claudeLaunchAgentEnvironment(desktopEnv) {
  const flags = CLAUDE_PRIVACY_FLAGS.filter(name =>
    typeof desktopEnv[name] === "string" && /^(?:1|true|yes|on)$/iu.test(desktopEnv[name]));
  return flags.length ? { [LAUNCH_AGENT_OPT_OUTS]: flags.join(",") } : {};
}

function applyClaudeLaunchAgentOptOuts(childEnv, serviceEnv) {
  const flags = serviceEnv[LAUNCH_AGENT_OPT_OUTS];
  if (typeof flags !== "string") return;
  for (const name of flags.split(",")) {
    if (CLAUDE_PRIVACY_FLAGS.includes(name)) childEnv[name] = "1";
  }
}

module.exports = { CLAUDE_PRIVACY_FLAGS, claudeLaunchAgentEnvironment, applyClaudeLaunchAgentOptOuts };
