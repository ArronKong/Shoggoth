# Runtime license sources

Shoggoth-authored source code is MIT licensed. The components below retain their
own licenses. This index records the runtime license documents added on
2026-09-18; it is not the complete inventory of all application dependencies.

## OpenAI Codex 0.149.0

The pinned runtime version is recorded in `build/codex-runtime-manifest.json` in
the source repository and `codex/runtime-manifest.json` in the application.
The generated protocol files under `schemas/codex-app-server/0.149.0` originate
from that version of Codex.

- Source: <https://github.com/openai/codex/tree/rust-v0.149.0>
- [CODEX-LICENSE.txt](CODEX-LICENSE.txt): unmodified copy of
  <https://raw.githubusercontent.com/openai/codex/rust-v0.149.0/LICENSE>
- [CODEX-NOTICE.txt](CODEX-NOTICE.txt): unmodified copy of
  <https://raw.githubusercontent.com/openai/codex/rust-v0.149.0/NOTICE>, including
  the upstream Ratatui attribution.

The [third-party index](THIRD-PARTY-NOTICES.md) also preserves the upstream
ripgrep, PCRE2 and zsh license texts. Their versions were read from the pinned
package binaries. The two Codex documents above do not replace those texts.
When updating Codex, review its license and notices at the new pinned version.

## Cua and UniFFI

[CUA-LICENSE.md](CUA-LICENSE.md) and [CUA-NOTICE.md](CUA-NOTICE.md) identify the
MIT and MPL-covered portions. [MPL-2.0.txt](MPL-2.0.txt) is the complete official
MPL 2.0 text, obtained from
<https://www.mozilla.org/media/MPL/2.0/index.txt>.

The npm registry's `gitHead` field for the exact published versions identifies
the corresponding UniFFI source commits:

| Package | Version | Corresponding source |
|---|---|---|
| @ubjs/core | 0.31.0-3 | [49bc591, typescript](https://github.com/jhugman/uniffi-bindgen-react-native/tree/49bc59194d183a05855ed4104c18eb92fb465e02/typescript) |
| @ubjs/node | 0.31.0-3 | [dcb5c4a, runtimes/napi](https://github.com/jhugman/uniffi-bindgen-react-native/tree/dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449/runtimes/napi) |
| @ubjs/node-darwin-arm64 / @ubjs/node-darwin-x64 | 0.31.0-3 | [dcb5c4a, runtimes/napi](https://github.com/jhugman/uniffi-bindgen-react-native/tree/dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449/runtimes/napi) |
| Cua compatibility runtime | 0.22.0 | [cua-driver-rs-v0.22.0](https://github.com/trycua/cua/tree/cua-driver-rs-v0.22.0) |

Shoggoth currently uses these upstream runtime files without source changes.
Recipients can obtain the source at the links above. Any future modifications
to MPL-covered files must remain available to recipients under MPL 2.0, with
the source location and notices updated accordingly.

## Deferred Claude Code integration

The Claude Agent SDK is excluded from both dependency lockfiles and application
packages. Native Claude Code connection and execution are disabled by
`app/release-policy.json`. Existing user data and first-party integration source
are retained for a possible later return after the applicable terms are reviewed.
This does not disable Anthropic models supplied by separately configured backends.

## License document checksums

SHA-256 of the unmodified downloaded files:

```text
d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc  CODEX-LICENSE.txt
9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915  CODEX-NOTICE.txt
3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04  MPL-2.0.txt
```
