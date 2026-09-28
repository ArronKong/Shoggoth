#!/usr/bin/env python3
"""Read-only, byte-level comparison of three frozen packages with official Git history.

Use complete, local clones of the official repositories. The script never writes
to the package, report, or upstream checkouts; JSON is emitted on stdout.
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
FROZEN_JSON = ROOT / "docs/architecture/bundled-license-evidence-2026-09-27.json"
PACKAGES_ROOT = ROOT / "resources/bundled-plugins/packages"
SOURCES = {
    "shopify": {
        "url": "https://github.com/Shopify/Shopify-AI-Toolkit.git",
        "commit": "859be93bfc858f183ff5eb40183e35a4d91d2950",
        "historyHead": "3e8a074fba02d9b95086ad505f8cbe0020ffeb9a",
    },
    "stripe": {
        "url": "https://github.com/stripe/ai.git",
        "commit": "2cda67e9ab99eec887c156c748d9a42d66ca5d53",
        "historyHead": "79ccee2edc0edc5b57491eef1c4ce96269e850a7",
    },
    "higgsfield": {
        "url": "https://github.com/higgsfield-ai/skills.git",
        "commit": "f83af0bc1d937c8119099a11f8ebbf5e6fb99819",
        "historyHead": "f83af0bc1d937c8119099a11f8ebbf5e6fb99819",
    },
}
NOTICE_BASENAME = re.compile(r"^(LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT|THIRD[-_]?PARTY)(\.|$)", re.I)


def git(repo, *args):
    # Complete clones make every blob local. Refuse a lazy fetch so this stays read-only.
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1")
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env)


def tree(repo, commit):
    by_oid = {}
    by_path = {}
    for entry in git(repo, "ls-tree", "-rz", commit).split(b"\0"):
        if not entry:
            continue
        mode_type_oid, path = entry.split(b"\t", 1)
        mode, kind, oid = mode_type_oid.decode().split()
        if kind != "blob":
            continue
        path = path.decode()
        by_oid.setdefault(oid, []).append(path)
        by_path[path] = oid
    return by_oid, by_path


def blob_oid(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in SOURCES:
        parser.add_argument(f"--{name}-repo", type=Path, required=True)
    args = parser.parse_args()
    source_repos = {name: getattr(args, f"{name}_repo").resolve() for name in SOURCES}
    frozen = json.loads(FROZEN_JSON.read_text())
    report = {
        "schemaVersion": 1,
        "frozenBatchDigest": frozen["batchDigest"],
        "method": "Frozen SHA-256 rechecked from bytes; Git blob SHA-1 compared to pinned commit trees; matched upstream blob bytes independently SHA-256 checked; unmatched blobs searched through pinned default-branch-head ancestry.",
        "packages": [],
    }

    for name, source in SOURCES.items():
        repo = source_repos[name]
        remote = git(repo, "remote", "get-url", "origin").decode().strip()
        if remote.casefold().removesuffix(".git") != source["url"].casefold().removesuffix(".git"):
            raise ValueError(f"{name}: unexpected origin: {remote}")
        commit = source["commit"]
        if git(repo, "rev-parse", "--verify", f"{commit}^{{commit}}").decode().strip() != commit:
            raise ValueError(f"{name}: pinned commit unavailable")
        history_head = source["historyHead"]
        if git(repo, "rev-parse", "--verify", f"{history_head}^{{commit}}").decode().strip() != history_head:
            raise ValueError(f"{name}: history head unavailable")
        git(repo, "merge-base", "--is-ancestor", commit, history_head)
        commit_tree, by_path = tree(repo, commit)
        frozen_package = next(p for p in frozen["packages"] if p["id"] == name)
        files = []
        for entry in frozen_package["files"]:
            path = entry["path"]
            data = (PACKAGES_ROOT / name / path).read_bytes()
            if sha256(data) != entry["sha256"] or len(data) != entry["bytes"]:
                raise ValueError(f"{name}/{path}: frozen evidence differs from bytes")
            oid = blob_oid(data)
            matching_paths = sorted(commit_tree.get(oid, []))
            if path in matching_paths:
                status = "same_path_same_bytes"
                selected_path = path
            elif matching_paths:
                status = "same_bytes_other_path"
                selected_path = matching_paths[0]
            else:
                status = "no_pinned_commit_match"
                selected_path = None
            if matching_paths:
                upstream_data = git(repo, "cat-file", "blob", oid)
                if sha256(upstream_data) != entry["sha256"]:
                    raise ValueError(f"{name}/{path}: upstream SHA-256 differs")
            files.append({
                "path": path,
                "frozenSha256": entry["sha256"],
                "gitBlobOid": oid,
                "status": status,
                "selectedUpstreamPath": selected_path,
                "allMatchingPathsAtCommit": matching_paths,
                "upstreamSha256Verified": bool(matching_paths),
            })

        unmatched = {f["gitBlobOid"] for f in files if f["status"] == "no_pinned_commit_match"}
        seen_elsewhere = set()
        commits = git(repo, "rev-list", history_head).decode().splitlines()
        for historical_commit in commits:
            if not unmatched - seen_elsewhere:
                break
            historical_tree, _ = tree(repo, historical_commit)
            seen_elsewhere.update((unmatched - seen_elsewhere) & historical_tree.keys())
        for file in files:
            if file["status"] == "no_pinned_commit_match":
                file["sameBytesInDefaultBranchHistory"] = file["gitBlobOid"] in seen_elsewhere

        notice_paths = sorted(p for p in by_path if NOTICE_BASENAME.match(Path(p).name))
        license_sha256 = sha256(git(repo, "cat-file", "blob", by_path["LICENSE"])) if "LICENSE" in by_path else None
        counts = {status: sum(f["status"] == status for f in files) for status in (
            "same_path_same_bytes", "same_bytes_other_path", "no_pinned_commit_match")}
        counts["unmatchedAnywhereInDefaultBranchHistory"] = sum(
            f["status"] == "no_pinned_commit_match" and not f["sameBytesInDefaultBranchHistory"] for f in files)
        report["packages"].append({
            "id": name,
            "frozenSourceDigest": frozen_package["sourceDigest"],
            "officialRepository": source["url"],
            "pinnedCommit": commit,
            "pinnedCommitDate": git(repo, "show", "-s", "--format=%cI", commit).decode().strip(),
            "auditedDefaultBranchHead": history_head,
            "defaultBranchCommitCount": len(commits),
            "rootLicenseSha256": license_sha256,
            "noticeNamedPathsAtPinnedCommit": notice_paths,
            "frozenPackageNoticePaths": [n["path"] for n in frozen_package["notices"]],
            "counts": counts,
            "files": files,
        })

    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
