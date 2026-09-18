# Built-in native Agent avatars

These seven PNGs were supplied by the user on 2026-09-19 and are stored unchanged.
`shoggoth.png` uses the replacement 1254 × 1254 original; the other six are 768 × 768.
`manifest.json` binds them to the fixed built-in Agent identities,
including the default Shoggoth Agent. It deliberately does not match arbitrary
`shoggoth-*` profiles or backend names.

The loopback `/avatar/<agentId>` route resolves avatars in this order:

1. A custom avatar in Shoggoth's `userData/agent-avatars/` directory.
2. A legacy custom avatar, if its migration could not complete.
3. The bundled PNG mapped in this directory.
4. The generated texture and initial for an Agent without a built-in image.

Bundled defaults are read from the application package and are never copied into
user data. A clean install can display them without OpenClaw, an internet
connection, or user-uploaded files. Custom uploads remain writable user data and
never alter these defaults.

The `app/**/*` electron-builder file set includes this directory in `app.asar`.
`scripts/builtin-agent-avatar-unit.cjs` checks fixed-identity coverage, clean-home
HTTP responses, custom override/restart behavior, and archive asset parity.

| File | SHA-256 |
| --- | --- |
| antigravity.png | c394fb5fefdc64b5fb6c2caccd1434d03b610a0f3d32794b86f077acec6df611 |
| pi.png | d91e49e8821523084e82260cb4c3bbdef8261c21ac91da8ad05bde03e922cb9a |
| deepseek-harness.png | a0b43738352a4d5b3cad51545617a0417b0a7caea6def5f1903b1267e08f2afe |
| claude-code.png | ba1b258c96eed73c4902287f3e03ad2bc22785b5862d7107c38d3aaba4252c8d |
| grok.png | c527ac8343af40bec6df7c56ec307eeb2669472ede07262c3f79d02d6e1f0bf0 |
| codex.png | 08377e2d1fb5fe7f2cda6da49faf89c0d7ad9dc0c82c5cc01c16e35bb8dc6aae |
| shoggoth.png | f82f78cc6d9d38b61ea67b4e6f310b595043c6717232dc92bf63ce59cdd5f691 |
