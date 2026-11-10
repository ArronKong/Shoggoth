# DMG artwork

Approved Shoggoth installer artwork.

- `background.png` measures 640 × 400 pixels.
- `background@2x.png` measures 1280 × 800 pixels.

These background-only frames are production artwork. The App, Applications
folder and their labels remain real Finder items, not pixels in the background.
The 1× and 2× exports are preserved as supplied, including their typography.

`scripts/macos-dmg-layout.cjs` sets the 640 × 400 point content area, 128 point
icons, 13 point labels, and icon centers at `(160, 238)` and `(480, 238)`. The saved
window is 640 × 431 points, including a 31 point title-bar allowance verified in
macOS 26 Finder. The native folder icon, alias badge, labels and hidden-file
display follow the user's Finder version and preferences.
The checksum-pinned dmgbuild tool combines the PNGs into a TIFF with
72/144 dpi representations and writes the Finder metadata without UI automation.

`scripts/create-macos-dmg.mjs` accepts only the existing verified App inputs.
It builds the image from an isolated clone and explicit dmgbuild settings;
App hooks, re-signing, update metadata and publishing are not run by this step.
Missing or incorrectly sized artwork, a failed builder/signature/image check,
or a destination that exists at startup stops the build. A retry starts with a
fresh staging directory and requires the existing destination to be resolved.
The existing official App ticket validation and subsequent DMG notarization
remain in the release pipeline. No running App or Service restart is required.

Validation: `node --test scripts/macos-dmg-layout-unit.cjs`, plus a small signed
fixture through the production DMG command, read-only mounting, payload signature
verification, and an actual Finder visual check. This verifies the installer
layout, not a full Shoggoth App release or installation.
