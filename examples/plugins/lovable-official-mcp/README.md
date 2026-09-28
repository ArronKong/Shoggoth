# Lovable official MCP candidate

This Shoggoth-authored package declares Lovable's [official remote MCP server](https://docs.lovable.dev/integrations/lovable-mcp-server) as a standalone Streamable HTTP connection candidate. It does not contain Lovable code or credentials. Import this directory through Shoggoth's local plugin installer to preview and install the MCP component.

The source is separate from the frozen `resources/bundled-plugins/packages/lovable` Codex app reference. Its `asdk_app_*` ID is not an MCP URL, OAuth client ID, or claim of feature parity.

Installation alone does not connect an account or grant tools. Shoggoth's Service currently requires a trusted OAuth provider configuration with a client ID, pinned issuer and token endpoints, requested scopes, and a stable account principal verifier. The [Lovable OAuth gap record](../../../docs/architecture/lovable-managed-connector-gap-2026-09-27.md) explains the remaining DCR, exact resource-audience, and identity contract work. With no matching trusted provider, Shoggoth rejects connection before launching a browser or contacting Lovable. Do not copy the public client ID from another client into a private provider configuration without verifying its redirect contract.

Once OAuth and account verification are implemented and tested against a real Lovable account, discover tools with `tools/list` and validate `list_workspaces` as the first read-only call. Lovable's tools can change projects, spend credits, deploy sites, and run SQL, so no tool grant is implied by installing this candidate.
