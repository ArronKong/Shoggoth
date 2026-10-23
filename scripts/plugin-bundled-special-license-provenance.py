#!/usr/bin/env python3
"""Read-only byte provenance for the frozen ChatCut and MagicPath packages.

The output is source evidence, never a redistribution approval. This probe
requires complete local clones at the pinned commits and never fetches.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parent.parent
BATCH = "8d4783872d4be5dd09e65d14e79c26bd92c3a2d3884af04934e239b4c2d5ffa9"
SOURCES = {
    "chatcut": {
        "origin": "https://github.com/ChatCut-Inc/agent-plugin.git",
        "commit": "6471abfc60cf6f76060a570a107fec5aa8423470",
        "prefix": "chatcut-desktop-codex-plugin/",
    },
    "magicpath": {
        "origin": "https://github.com/MagicPathAI/agent-skills.git",
        "commit": "a1ced96ad9da6c65d9f57d9fef79d944f7192dfe",
        "prefix": "",
    },
}
LICENSE_NAME = re.compile(r"^(LICENSE|LICENCE|NOTICE|COPYING)(\.|$)", re.I)


def git(repo, *args):
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def blob_oid(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def tree(repo, commit):
    result = {}
    for item in git(repo, "ls-tree", "-rz", commit).split(b"\0"):
        if not item:
            continue
        meta, raw_path = item.split(b"\t", 1)
        mode, kind, oid = meta.decode().split()
        if kind == "blob":
            result[raw_path.decode()] = {"mode": mode, "oid": oid}
    return result


def check_repo(repo, source):
    require(git(repo, "remote", "get-url", "origin").decode().strip() == source["origin"],
            f"origin mismatch: {repo}")
    require(git(repo, "rev-parse", "HEAD").decode().strip() == source["commit"],
            f"HEAD mismatch: {repo}")
    require(git(repo, "rev-parse", "--is-shallow-repository").decode().strip() == "false",
            f"shallow history: {repo}")


def inspect_package(package_id, repo, source, frozen):
    check_repo(repo, source)
    git_tree = tree(repo, source["commit"])
    aliases_by_oid = {}
    for path, entry in git_tree.items():
        aliases_by_oid.setdefault(entry["oid"], []).append(path)
    reachable = {line.split(b" ", 1)[0].decode()
                 for line in git(repo, "rev-list", "--objects", source["commit"]).splitlines()}

    directory = ROOT / "resources/bundled-plugins/packages" / package_id
    actual_files = {str(path.relative_to(directory)): path
                    for path in directory.rglob("*") if path.is_file()}
    require(not any(path.is_symlink() for path in directory.rglob("*")),
            f"symlink in frozen package: {package_id}")
    expected_files = {item["path"]: item for item in frozen["files"]}
    require(set(actual_files) == set(expected_files),
            f"frozen file set mismatch: {package_id}")

    rows = []
    for path in sorted(actual_files):
        raw = actual_files[path].read_bytes()
        expected = expected_files[path]
        require(len(raw) == expected["bytes"], f"frozen size mismatch: {package_id}/{path}")
        require(sha256(raw) == expected["sha256"], f"frozen SHA-256 mismatch: {package_id}/{path}")
        oid = blob_oid(raw)
        candidate = source["prefix"] + path
        upstream_entry = git_tree.get(candidate)
        upstream = git(repo, "cat-file", "blob", upstream_entry["oid"]) if upstream_entry else None
        if upstream_entry:
            require(blob_oid(upstream) == upstream_entry["oid"],
                    f"Git object mismatch: {package_id}/{candidate}")
        aliases = sorted(aliases_by_oid.get(oid, []))
        for alias in aliases:
            require(git(repo, "cat-file", "blob", git_tree[alias]["oid"]) == raw,
                    f"Git alias byte mismatch: {package_id}/{alias}")
        rows.append({
            "path": path,
            "bytes": len(raw),
            "sha256": sha256(raw),
            "gitBlobOid": oid,
            "candidatePath": candidate,
            "candidateState": ("same" if upstream == raw else
                               "different" if upstream is not None else "absent"),
            "candidateSha256": sha256(upstream) if upstream is not None else None,
            "sameBlobCurrentPaths": aliases,
            "blobReachableInPinnedHistory": oid in reachable,
        })

    manifest_path = source["prefix"] + ".codex-plugin/plugin.json"
    upstream_manifest = json.loads(git(repo, "cat-file", "blob", git_tree[manifest_path]["oid"]))
    license_files = sorted(path for path in git_tree
                           if LICENSE_NAME.match(path.rsplit("/", 1)[-1]))
    return {
        "id": package_id,
        "frozenSourceDigest": frozen["sourceDigest"],
        "frozenManifestLicense": frozen["manifestLicense"],
        "sourceOrigin": source["origin"],
        "sourceCommit": source["commit"],
        "sourcePrefix": source["prefix"],
        "upstreamManifestLicense": upstream_manifest.get("license"),
        "upstreamLicenseFiles": license_files,
        "packageScopeLicenseFiles": [path for path in license_files
                                     if path.startswith(source["prefix"])],
        "reachableCommitCount": len(git(repo, "rev-list", source["commit"]).splitlines()),
        "sameCandidatePathCount": sum(row["candidateState"] == "same" for row in rows),
        "files": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chatcut-repo", required=True, type=Path)
    parser.add_argument("--magicpath-repo", required=True, type=Path)
    args = parser.parse_args()
    inventory = json.loads((ROOT / "docs/architecture/bundled-license-evidence-2026-09-27.json").read_text())
    catalog = json.loads((ROOT / "resources/bundled-plugins/catalog.json").read_text())
    require(inventory["batchDigest"] == catalog["batchDigest"] == BATCH,
            "frozen batch digest mismatch")
    frozen = {item["id"]: item for item in inventory["packages"]}
    catalog_items = {item["id"]: item for item in catalog["packages"]}
    for package_id in SOURCES:
        require(frozen[package_id]["sourceDigest"] == catalog_items[package_id]["sourceDigest"],
                f"frozen source digest mismatch: {package_id}")
    repos = {"chatcut": args.chatcut_repo, "magicpath": args.magicpath_repo}
    result = {
        "schemaVersion": 1,
        "batchDigest": BATCH,
        "limitation": "Byte provenance only; no redistribution or trademark approval.",
        "packages": [inspect_package(package_id, repos[package_id], source, frozen[package_id])
                     for package_id, source in SOURCES.items()],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
