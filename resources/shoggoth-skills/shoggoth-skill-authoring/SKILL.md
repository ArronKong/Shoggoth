---
name: shoggoth-skill-authoring
description: Design and review a portable Shoggoth native Skill package without coupling it to Codex internals.
---

# Shoggoth Skill Authoring

Use this workflow when the user asks to create or review a Shoggoth native Skill.

1. Keep the workflow in `SKILL.md` and the machine contract in `skill.json`.
2. Declare every required Shoggoth tool and Runtime capability explicitly.
3. Keep credentials, tokens, personal data, and machine-specific absolute paths out of the package.
4. Treat `scripts/`, `references/`, and `assets/` as inert package content; installation must never execute them.
5. Prefer portable Shoggoth capabilities. Do not make Codex, OpenClaw, or Hermes data directories the authority.
6. Ask the user to install or enable the finished package in Shoggoth. Never claim that writing files alone installed it.

Before finishing, verify that the package has no symlink, hardlink, unknown root entry, secret-like text, or undeclared dependency.
