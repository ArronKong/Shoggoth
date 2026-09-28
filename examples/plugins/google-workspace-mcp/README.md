# Google Workspace MCP protocol candidate

This local package contains only the three official independent MCP URLs. It
contains no OAuth application identity, secret, scopes, or callback port. It
does not replace or alter the frozen bundled Gmail, Google Calendar, or Google
Drive source packages. See the [Google auth gate](../../../docs/architecture/google-mcp-auth-gap-2026-09-27.md)
before attempting a real connection.

The Service requires one private `oauth-providers.json` entry per endpoint,
using a Google Cloud **Desktop app** client ID that you registered and the
specific Workspace scopes needed by your tools. It rejects source placeholder
IDs, client secrets, fixed callback ports, cross-product scopes, and a missing
Google `openid profile` identity scope. Add the Google OIDC metadata URL and
the product MCP protected-resource metadata URL to each entry. The public
Workspace MCP guide currently documents Web application clients with secrets,
so a Desktop client must still be accepted by the real MCP service before this
candidate can be called supported.

After the private provider file is present and the Service restarts, preview
and install this directory in the Plugins page, enable it, then connect each
MCP component separately. The native consent prompt shows the exact requested
scopes. Tool discovery and every tool authorization remain separate. If the
remote service rejects Desktop OAuth, metadata, resource, identity, or scopes,
the connection must stay closed; do not copy a Web client secret into the App.
