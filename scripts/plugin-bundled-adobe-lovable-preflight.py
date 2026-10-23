#!/usr/bin/env python3
"""Read-only fixed-source/Skill-icon preflight; every rights review stays pending.

Requires full official clones at the commits below. Reuses the checked-in byte
verifier from the preceding batch; does not fetch, execute Skills, or approve.
"""

import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "scripts/plugin-bundled-airtable-dropbox-datadog-preflight.py"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("bundled_byte_preflight", HELPER)
byte_preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(byte_preflight)
require = byte_preflight.require
BATCH = byte_preflight.BATCH
SOURCES = {
    "adobe": {
        "origin": "https://github.com/adobe/skills.git",
        "commit": "27b87ccd7b5b5b6a12d949d8747e25248c2b02fb",
        "prefix": "plugins/creative-cloud/adobe-for-creativity/",
        "prior": "bundled-remaining-vendor-provenance-2026-09-27.json",
    },
    "lovable": {
        "origin": "https://github.com/lovablelabs/mcp.git",
        "commit": "0336e6db8026b0f02cb89d1451cc48ea3f469791",
        "prefix": "",
        "prior": "bundled-remaining-vendor-provenance-2026-09-27.json",
    },
}
ICON_LINE = re.compile(r'^\s+(icon_small|icon_large):\s*"([^"\n]+)"\s*$', re.M)


def add_skill_icons(package):
    directory = ROOT / "resources/bundled-plugins/packages" / package["id"]
    rows = {item["path"]: item for item in package["files"]}
    declarations = []
    for path, row in rows.items():
        if path.endswith("/agents/openai.yaml"):
            raw = (directory / path).read_text()
            matches = ICON_LINE.findall(raw)
            require(len(matches) == 2 and {role for role, _ in matches} ==
                    {"icon_small", "icon_large"}, f"unexpected Skill icon declarations: {path}")
            skill_root = (directory / path).parent.parent
            for role, value in matches:
                target = (skill_root / value).resolve()
                require(target.is_relative_to(directory.resolve()),
                        f"Skill icon escapes package: {path}/{value}")
                relative = str(target.relative_to(directory.resolve()))
                require(relative in rows, f"missing Skill icon: {path}/{value}")
                declaration = {"declaringFile": path, "role": role, "targetPath": relative}
                declarations.append(declaration)
                rows[relative].setdefault("skillIconRoles", []).append(
                    {"declaringFile": path, "role": role})
    groups = {}
    for row in rows.values():
        groups.setdefault(row["sha256"], []).append(row["path"])
    package["skillIconDeclarations"] = sorted(declarations,
                                               key=lambda item: (item["declaringFile"], item["role"]))
    package["duplicateFrozenByteGroups"] = [
        {"sha256": digest, "paths": sorted(paths)} for digest, paths in sorted(groups.items())
        if len(paths) > 1]


def add_license_context(package, repo, source):
    prefix = source["prefix"]

    def relevant(path):
        return "/" not in path or bool(prefix and path.startswith(prefix))

    package["candidateLicenseFilesRelevantToPrefix"] = [
        item for item in package["upstreamLicenseFiles"] if relevant(item["path"])]
    for row in package["files"]:
        match = row["verifiedHistoricalMatch"]
        if match is None:
            continue
        tree = byte_preflight.git_tree(repo, match["commit"])
        match["licenseFilesAtCommit"] = [
            {"path": path, "sha256": byte_preflight.sha256(
                byte_preflight.git(repo, "cat-file", "blob", entry["oid"]))}
            for path, entry in sorted(tree.items())
            if relevant(path) and byte_preflight.LICENSE_NAME.match(path.rsplit("/", 1)[-1])]


def main():
    require(byte_preflight.ROOT == ROOT, "helper root mismatch")
    parser = argparse.ArgumentParser(description=__doc__)
    for package_id in SOURCES:
        parser.add_argument("--" + package_id + "-repo", required=True, type=Path)
    args = parser.parse_args()
    inventory = json.loads((ROOT / "docs/architecture/bundled-license-evidence-2026-09-27.json").read_text())
    catalog = json.loads((ROOT / "resources/bundled-plugins/catalog.json").read_text())
    require(inventory["batchDigest"] == catalog["batchDigest"] == BATCH,
            "frozen batch digest mismatch")
    frozen = {item["id"]: item for item in inventory["packages"]}
    entries = {item["id"]: item for item in catalog["packages"]}
    packages = []
    for package_id, source in SOURCES.items():
        repo = getattr(args, package_id + "_repo")
        package = byte_preflight.inspect(package_id, repo,
                                         source, frozen[package_id], entries[package_id])
        add_skill_icons(package)
        add_license_context(package, repo, source)
        packages.append(package)
    require(len(packages) == 2 and sum(len(item["files"]) for item in packages) == 28,
            "unexpected batch scope")
    print(json.dumps({"schemaVersion": 1, "batchDigest": BATCH,
                      "limitation": "Frozen byte, candidate source and icon-reference evidence only; all rights reviews remain pending.",
                      "packages": packages}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
