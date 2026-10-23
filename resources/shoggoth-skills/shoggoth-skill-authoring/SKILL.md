---
name: shoggoth-skill-authoring
description: Design and review a portable Shoggoth native Skill package without coupling it to Codex internals.
---

# Shoggoth Skill Authoring

Use this workflow when the user asks to create or review a Shoggoth native Skill.

1. Use the portable Agent Skills format: a `SKILL.md` with YAML frontmatter containing `name` and `description`, followed by Markdown instructions. A separate `skill.json` is optional and only needed for an explicit Shoggoth package contract.
2. Declare required Shoggoth tools and Runtime capabilities in the optional `x-shoggoth.requiredTools` and `x-shoggoth.requiredRuntimeCapabilities` frontmatter fields, or in the existing `skill.json` contract. Preserve OpenClaw, Hermes and other host metadata without treating it as permission.
3. Keep credentials, tokens, personal data, and machine-specific absolute paths out of the package.
4. Keep supporting files such as `scripts/`, `references/`, `assets/`, `templates/`, licenses and channel metadata with the Skill. Installation must never execute them, install binaries, or configure credentials.
5. Prefer portable Shoggoth capabilities. Do not make Codex, OpenClaw, or Hermes data directories the authority.
6. Install a directory, ZIP or single `SKILL.md` through `skill_install_global`, using `skill_catalog.registryVersion` as `expectedRevision` and the product's confirmation. Never claim that writing files alone installed it or that successful import proves its environment dependencies are ready.

Before finishing, verify the frontmatter, supporting file paths, declared dependencies and absence of symlinks, hardlinks or credentials. A portable package does not need to be rewritten for Shoggoth. Ordinary macOS ZIP metadata is ignored; path traversal and unsafe files are rejected.
