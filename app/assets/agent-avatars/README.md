# Bundled Agent avatar library

`library/` contains all 150 original 640 × 640 JPEG files from the supplied
`640x640_jpg` directory, copied without recompression or renaming. `manifest.json`
records each filename and SHA-256 digest. Two files have identical bytes, so the
library contains 149 distinct images.

The loopback `/avatar/<agentId>` route serves a user-uploaded image first. For
an Agent without a custom image, it randomly chooses a bundled image that no
other Agent currently uses. Byte-identical files count as one image for this
purpose. Once all distinct images have assignments, reuse is allowed.

The management API reserves a selection when it creates an Agent with a known ID;
other Agents receive one on their first avatar request. Selections live in the App's user data at
`agent-avatars/.default-selections.json`, so they survive page reloads and App
restarts. Uploading a custom image releases the Agent's bundled selection.
Bundled JPEGs remain read-only in `app.asar`; custom images stay in user data.
