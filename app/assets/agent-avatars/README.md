# Bundled Agent avatar library

`builtin/` contains the seven reserved 640 × 640 JPEGs for Shoggoth, Codex,
Grok, Antigravity, Pi, OpenCode, and DeepSeek. Its separate manifest maps each
image to the automatically created Profile's fixed identity and records its
SHA-256 digest. These files are not part of the random library below.

The Agent Service copies a reserved image into the App's `agent-avatars/`
directory immediately before the corresponding Profile is first automatically
created, either during startup or when its CLI is connected later. Existing
Profiles and user-uploaded images are preserved. Persisted built-in creation
records prevent deleted built-ins from being seeded again; manually creating
an Agent, including one with the same name or Runtime, uses the ordinary library.
Restoring an archived Agent preserves its identity and existing avatar.

`library/` contains all 150 original 640 × 640 JPEG files from the supplied
`640x640_jpg` directory, copied without recompression or renaming. `manifest.json`
records each filename and SHA-256 digest. Two files have identical bytes, so the
library contains 149 distinct images.

The chat profile's avatar picker reads the same library from `/avatar/library/`.
The catalog and previews use one content digest per distinct image; browsing
does not reserve an avatar or touch user data. The UI draws up to twenty images
at a time, excluding the preceding batch when shuffling. On save, both presets
and user-provided images use the existing custom avatar upload route.

The loopback `/avatar/<agentId>` route serves a user-uploaded image first. For
an Agent without a custom image, it randomly chooses a bundled image that has
not been automatically assigned to another Agent. Byte-identical files count
as one image for this purpose. Once all distinct images have assignments, reuse
is allowed.

The management API reserves a selection when it creates an Agent with a known ID;
other Agents receive one on their first avatar request. Selections live in the App's user data at
`agent-avatars/.default-selections.json`, so they survive page reloads and App
restarts. Uploading a custom image releases the Agent's bundled selection.
Bundled JPEGs remain read-only in `app.asar`; custom images stay in user data.
