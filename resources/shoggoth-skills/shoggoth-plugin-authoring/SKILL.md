---
name: shoggoth-plugin-authoring
description: Create a reusable Codex-format plugin from a task, public MCP configuration, CLI documentation, or existing Skills, then validate and install it in Shoggoth for native Agents and bridged Hermes/OpenClaw.
---

# Create a shared Shoggoth plugin

Use this workflow when the user asks to create or package a plugin. Read
`app_help_get` with `featureId: "mcp"` for the current tools and permission state.

1. Determine the task and expected result. Inspect supplied documentation and
   existing files first. Ask only for missing information that blocks creation:
   the product name/docs, public MCP endpoint or launch configuration, CLI
   executable/help/argument/output schema, or existing Skills and referenced
   files. Credentials are collected by Shoggoth (step 6), never in chat or files.
2. Prefer a Skill for an instruction-only workflow; add an MCP declaration when
   live product operations are needed. Prefer a remote MCP endpoint
   (`{"type": "http", "url": "https://…"}`) over writing a local bridge. A CLI
   needs a contained MCP adapter with bounded structured arguments, an
   executable availability check, explicit timeouts, and structured errors.
   Do not use shell interpolation. A missing executable remains unavailable.
3. Declare every credential as `${secret:NAME}` (NAME uses A-Z, 0-9 and _):
   - stdio: `"env": { "SERVICE_TOKEN": "${secret:SERVICE_TOKEN}" }`
   - http: `"headers": { "Authorization": "Bearer ${secret:SERVICE_TOKEN}" }`
     (any header name works, for example `"X-Api-Key": "${secret:SERVICE_KEY}"`)
   The value must be exactly the reference (only headers may add `Bearer `).
   Never write a token, a sample token, or instructions to save token files into
   the package. Shoggoth injects the value only into that process env or that
   endpoint's requests.
4. Call `plugin_create` with `name`, `description`, optional `version` (default
   `0.1.0`), and UTF-8 `files`. The Service supplies the default Codex manifest at
   `.codex-plugin/plugin.json`. Do not supply a second manifest or format.
   Each Skill is `skills/<name>/SKILL.md` with standard YAML `name`,
   `description`, and task instructions. Optional `.mcp.json` contains
   `{"mcpServers": {...}}`. Include all referenced scripts/resources. A stdio
   server uses a contained executable (`executable: true`) or Node/Python with a
   contained script; `npx`, `uv`, arbitrary bare CLI commands and shell launchers
   are unsupported by this plugin launcher. Keep shared workflows independent
   of Codex-only tools and personal Runtime configuration.
   Calls accept at most 64 files, 32 KiB per file and 48 KiB total JSON input.
   Correct `diagnostics` with a new `plugin_create` call before installing.
   Calling it again with the same `name` replaces that draft; to change an
   installed plugin, raise `version` and create it again.
5. Call `plugin_install` with the exact `draftId`, `previewDigest`,
   `expectedRevision` and an explicit `enable` choice. Product confirmation
   covers installation and optional global activation; do not ask again.
   When `installation` is already present this updates it in place: an
   enabled old version is disabled and drained inside the same confirmation,
   and its tools need step 7 again. `PLUGIN_ROLLBACK_REQUIRES_PREVIEW` means
   the files equal an older release; raise `version` and recreate.
6. Read `plugin_status` for the `installationId`, then `plugin_setup_get`.
   For each `provide_secret:NAME`, call `plugin_secret_request` with a short
   `reason` saying where the user obtains it. Shoggoth shows a password card in
   this conversation; you only receive `stored` or `canceled`.
7. Call `plugin_activate` with the `releaseDigest` from `plugin_setup_get`. One
   product confirmation enables the plugin, pins a local Node/Python when a
   stdio server needs it, connects the MCP servers, discovers their tools and
   allows them for all Agents (tools annotated destructive still ask per call).
   Servers that need a provider account sign-in report `configure_in_plugins`;
   tell the user to finish them in Plugins.
8. New tools are available from the next message, not the current turn. Tell
   the user to continue in a new message, and report the absolute `sourcePath`,
   the `#/plugins` entry and any remaining setup plainly.

The source package is kept as Service-owned product state; put user-requested
exports in the current WorkRun workspace. Never write copies into
Hermes/OpenClaw/Codex configuration directories or grant tools yourself.
