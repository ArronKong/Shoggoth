"use strict";

// The signing step supplies the public capture token in the signed release
// marker. An ordinary checkout or an internally signed package has no project.
function getProductTelemetryBuildConfig(marker, appVersion) {
  return {
    officialRelease: marker?.distribution === "official" && marker.signingMode === "developer-id"
      && marker.updateChannel === "stable" && marker.version === appVersion,
    exportEnabled: Boolean(marker?.productTelemetry),
    projectToken: marker?.productTelemetry?.projectToken,
    appVersion, region: "us", revision: 2,
  };
}

function telemetryEnvironmentOverride(env) {
  const on = name => /^(1|true)$/iu.test(String(env[name] ?? "").trim());
  if (on("DO_NOT_TRACK") || on("SHOGGOTH_TELEMETRY_DISABLED")) return "environment";
  return ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "TF_BUILD"].some(on) ? "ci" : null;
}

module.exports = { getProductTelemetryBuildConfig, telemetryEnvironmentOverride };
