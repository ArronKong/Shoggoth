# Shoggoth

**English** | [简体中文](README.zh-CN.md)

Shoggoth is a local macOS desktop workspace for AI agents. It brings chat,
models, agent management, scheduled tasks, skills, usage and inspiration notes
into one Electron application. The React interface communicates with a local
agent service and optional OpenClaw, Hermes and native CLI integrations.

## Requirements

- macOS 13 or newer on Apple Silicon or Intel for the desktop app.
- Node.js 22.22.3 or newer and npm. The packaged app carries its own runtime.
- Internet access during dependency and pinned runtime downloads.
- Accounts and any external CLI/backend you choose to connect. They are not
  required to build the UI or run the isolated tests.

## Build from source

From the repository root:

```sh
npm ci
npm --prefix app/manage-ui ci
npm run prepare:runtimes
npm run build:manage
npm start
```

`prepare:runtimes` obtains the pinned Codex and Cua releases and prepares SQLite
binaries for both Mac architectures. Downloads and extracted binaries are
verified against manifests under `build/`. It does not install or configure
external agents or sign in to an account. Generated resources live in `.vendor/`.
Do not commit that directory.

To work on the UI, run `npm --prefix app/manage-ui run dev` and, in a second
terminal, `npm run start:dev`. The desktop process supplies the local API.
To build ZIP archives containing the application:

```sh
npm run dist
```

The output is under `dist/`. Builds without a configured Developer ID and
notarization profile are **internal previews**. Public Mac binary distribution
requires Developer ID signing, notarization, Gatekeeper checks and validation
on a clean Mac account.

## Signed releases and automatic updates

Official builds check the public [GitHub Releases](https://github.com/ArronKong/Shoggoth/releases)
feed after launch and every six hours. A release must contain both macOS ZIPs
and `latest-mac.yml`; source archives alone cannot update the installed app.
Development, ad-hoc and local-signing builds deliberately keep the production
update channel disabled.

The `Signed macOS release` workflow builds both architectures, signs with a
Developer ID Application certificate, notarizes and staples each app, verifies
the ZIPs and update metadata, and keeps the GitHub Release as a draft until all
checks pass. The repository must be public and these Actions secrets must be set:

- `MACOS_CERTIFICATE_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY`
- `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`

Create and push a tag matching `package.json`, for example `v0.8.125`, to run
the workflow. The first updater-capable signed build must be installed manually;
later signed releases can update it in place.

For a first source publication, run `npm run export:source -- /absolute/path/to/an-empty-directory`.
The export excludes internal development notes and Git history; its file-hash
manifest is written beside the directory as `<directory>.manifest.json` for local
verification. Review and scan the exported source before creating a public repo.

## Integrations and data

Connect the local backends you need in Settings and configure models/accounts
in Models. OpenClaw and Hermes remain separate installations; follow their
upstream installation instructions. Local files, conversations and configuration
may contain private data. Never copy application data or credentials into a
public issue or repository.

Native **Claude Code integration is disabled in this release**, and the Claude
Agent SDK is not included in dependencies or packages. Existing account and
conversation data is preserved. Anthropic models accessed through a separately
configured backend are unaffected.

## Checks

```sh
npm --prefix app/manage-ui exec -- tsc --noEmit --project app/manage-ui/tsconfig.json
npm run build:manage
npm run release:metadata
npm run licenses:check
node scripts/third-party-licenses-unit.mjs
node scripts/desktop-app-update-unit.cjs
node scripts/app-update-release-contract-unit.cjs
node scripts/adhoc-sign-unit.cjs
node scripts/notarize-unit.cjs
node scripts/shoggoth-packaged-runtime-smoke.mjs
node scripts/shoggoth-builtin-cli-profiles-unit.cjs
node scripts/runtime-cli-auth-unit.cjs
node scripts/shoggoth-runtime-adapter-registry-unit.cjs
node scripts/proxy-smoke.mjs
node scripts/proxy-chat-smoke.mjs
node scripts/hermes-start-smoke.cjs
npm audit
npm --prefix app/manage-ui audit
```

On macOS, after installing Electron and building the UI:

```sh
node_modules/.bin/electron scripts/ui-security-electron-smoke.cjs
```

These checks use fixtures and temporary local services. Tests that require real
accounts or mutate external backends are separate; see [contributing](CONTRIBUTING.md).
If a runtime download fails, rerun `npm run prepare:runtimes`; do not skip hash
checks. If Electron downloads need your configured HTTP(S) proxy, use
`ELECTRON_GET_USE_PROXY=1 npm ci`. After changing dependencies, install from both lockfiles and regenerate
release metadata before packaging.

## License

Shoggoth-authored code is available under the [MIT License](LICENSE).
Third-party code, fonts and bundled programs retain their original licenses.
See the [complete third-party notices](resources/legal/THIRD-PARTY-NOTICES.md),
[license index](resources/legal/third-party-index.json) and
[runtime source locations](resources/legal/RUNTIME-LICENSE-SOURCES.md).
The application includes these documents under `Contents/Resources/legal`.
