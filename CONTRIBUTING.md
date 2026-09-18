# Contributing

Backend contracts live in `app/core/agent-backend.js`. Keep configuration in
its existing stores and route management through `app/core/backend-registry.js`. Keep
unrelated local work intact and add targeted regression coverage when behavior
or a security boundary changes.

Install both dependency trees with `npm ci`, following `README.md`. Run the
relevant isolated checks and the production UI build. Backend smoke tests that
write to real OpenClaw, Hermes or account state require a disposable test setup;
do not run them against personal data just to obtain a green result.

When adding a dependency, check its actual version's license and retain the
lockfile. When copying or adapting code, record the upstream URL, revision,
affected local files, changes, copyright and full license in
`resources/legal/source-components.json` and `resources/legal/licenses/source/`.
Keep the original notices in copied source files. Run `npm run release:metadata`
and `npm run licenses:check`; generated documents must not be edited by hand.

Changes to bundled runtimes require updated source links, archive/binary hashes
and architecture-specific verification. Never replace a license with this
project's MIT license or assume a brand logo's copyright license grants use of
the corresponding trademark.

Do not commit credentials, user data, screenshots of private sessions, downloaded
runtime binaries, dependencies, build output or internal acceptance reports.
