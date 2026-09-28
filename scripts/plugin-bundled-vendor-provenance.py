#!/usr/bin/env python3
"""Compare three frozen vendor plugins with pinned public vendor Git histories.

This is a read-only source-identity probe, not a redistribution-license verdict.
It requires complete local clones and never fetches missing Git objects.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
INVENTORY = ROOT / "docs/architecture/bundled-license-evidence-2026-09-27.json"
PACKAGES = ROOT / "resources/bundled-plugins/packages"
SOURCES = {
    "airtable": {
        "url": "https://github.com/airtable/skills.git",
        "commit": "812ee67f1fd3d76fb45ff8df40afaa0448602ba8",
        "prefix": "plugins/airtable/",
        "license": "LICENSE.md",
    },
    "canva": {
        "url": "https://github.com/canva-sdks/canva-skills.git",
        "commit": "b56291ea0a36d0a941e1478b47959be5f1771dee",
        "prefix": "plugins/canva/",
        "license": "LICENSE",
    },
    "monday-com": {
        "url": "https://github.com/mondaycom/skills.git",
        "commit": "ee1f86171ba8c10879532d8334b2c19b61f1c372",
        "prefix": "",
        "license": "LICENSE",
    },
}
NOTICE = re.compile(r"^(LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT|THIRD[-_]?PARTY)(\.|$)", re.I)


def git(repo, *args):
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1")
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env)


def tree(repo, commit):
    by_oid = {}
    by_path = {}
    for entry in git(repo, "ls-tree", "-rz", commit).split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        if kind != "blob" or mode not in ("100644", "100755"):
            continue
        path = raw_path.decode()
        by_oid.setdefault(oid, []).append(path)
        by_path[path] = oid
    return by_oid, by_path


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git_oid(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in SOURCES:
        parser.add_argument(f"--{name}-repo", required=True, type=Path)
    args = parser.parse_args()
    inventory = json.loads(INVENTORY.read_text())
    report = {
        "schemaVersion": 1,
        "frozenBatchDigest": inventory["batchDigest"],
        "limitation": "Exact bytes in a vendor Git repository do not establish rights for unmatched files, brand assets, or public redistribution.",
        "packages": [],
    }

    for name, source in SOURCES.items():
        repo = getattr(args, f"{name.replace('-', '_')}_repo").resolve()
        remote = git(repo, "remote", "get-url", "origin").decode().strip()
        if remote.casefold().removesuffix(".git") != source["url"].casefold().removesuffix(".git"):
            raise ValueError(f"{name}: unexpected Git origin {remote}")
        pinned = source["commit"]
        if git(repo, "rev-parse", "--verify", f"{pinned}^{{commit}}").decode().strip() != pinned:
            raise ValueError(f"{name}: pinned commit is unavailable")
        by_oid, by_path = tree(repo, pinned)
        frozen = next(p for p in inventory["packages"] if p["id"] == name)
        files = []
        for entry in frozen["files"]:
            relative = entry["path"]
            data = (PACKAGES / name / relative).read_bytes()
            if len(data) != entry["bytes"] or sha256(data) != entry["sha256"]:
                raise ValueError(f"{name}/{relative}: frozen bytes changed")
            oid = git_oid(data)
            matching = sorted(by_oid.get(oid, []))
            expected = source["prefix"] + relative
            status = ("same_plugin_relative_path" if expected in matching else
                      "same_bytes_other_path" if matching else "no_pinned_commit_match")
            if matching and sha256(git(repo, "cat-file", "blob", oid)) != entry["sha256"]:
                raise ValueError(f"{name}/{relative}: vendor blob bytes differ")
            files.append({
                "path": relative, "frozenSha256": entry["sha256"], "gitBlobOid": oid,
                "status": status, "expectedVendorPath": expected,
                "matchingPathsAtPinnedCommit": matching,
                "vendorSha256Verified": bool(matching),
            })

        unmatched_oids = {f["gitBlobOid"] for f in files if f["status"] == "no_pinned_commit_match"}
        history_match = {}
        commits = git(repo, "rev-list", pinned).decode().splitlines()
        for historical in commits:
            if len(history_match) == len(unmatched_oids):
                break
            historical_oids, _ = tree(repo, historical)
            for oid in unmatched_oids - history_match.keys():
                if oid in historical_oids:
                    history_match[oid] = {"commit": historical,
                                          "paths": sorted(historical_oids[oid])}
        for file in files:
            if file["status"] == "no_pinned_commit_match":
                historical = history_match.get(file["gitBlobOid"])
                if historical and sha256(git(repo, "cat-file", "blob", file["gitBlobOid"])) != file["frozenSha256"]:
                    raise ValueError(f"{name}/{file['path']}: historical vendor blob bytes differ")
                file["sameBytesInPinnedCommitAncestry"] = historical
                file["historicalVendorSha256Verified"] = bool(historical)

        license_path = source["license"]
        license_hash = (sha256(git(repo, "cat-file", "blob", by_path[license_path]))
                        if license_path in by_path else None)
        counts = {status: sum(f["status"] == status for f in files)
                  for status in ("same_plugin_relative_path", "same_bytes_other_path",
                                 "no_pinned_commit_match")}
        counts["historyOnlyMatch"] = sum(f["status"] == "no_pinned_commit_match"
                                         and f["sameBytesInPinnedCommitAncestry"] is not None
                                         for f in files)
        report["packages"].append({
            "id": name, "frozenSourceDigest": frozen["sourceDigest"],
            "vendorRepository": source["url"], "pinnedCommit": pinned,
            "pinnedCommitDate": git(repo, "show", "-s", "--format=%cI", pinned).decode().strip(),
            "scannedAncestorCommits": len(commits), "vendorPluginPrefix": source["prefix"],
            "licensePath": license_path if license_hash else None,
            "licenseSha256": license_hash,
            "vendorNoticeNamedPaths": sorted(path for path in by_path if NOTICE.match(Path(path).name)),
            "frozenNoticePaths": [entry["path"] for entry in frozen["notices"]],
            "counts": counts, "files": files,
        })

    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
