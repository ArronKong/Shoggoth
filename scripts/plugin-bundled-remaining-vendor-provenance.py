#!/usr/bin/env python3
"""Read-only byte provenance probe for five frozen vendor plugin packages.

Requires complete local clones of the named official public repositories.
Reads pinned Git objects without fetching and writes JSON only to stdout.
An exact upstream blob match is source evidence, not redistribution clearance.
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
FROZEN_BATCH = "8d4783872d4be5dd09e65d14e79c26bd92c3a2d3884af04934e239b4c2d5ffa9"
SOURCES = {
    "adobe": {
        "url": "https://github.com/adobe/skills.git",
        "commit": "27b87ccd7b5b5b6a12d949d8747e25248c2b02fb",
        "prefix": "plugins/creative-cloud/adobe-for-creativity/",
        "licensePaths": ["LICENSE"],
        "frozenSourceDigest": "e485801cd55252f410ec4f1a010cfa807ce5d333269a6af7e303f00f5663cec0",
    },
    "consensus": {
        "url": "https://github.com/Consensus-NLP/consensus-mcp.git",
        "commit": "da2d7d353165823241b2717cf5e946aff6ada37f",
        "prefix": "",
        "licensePaths": ["LICENSE"],
        "frozenSourceDigest": "17e7cb4bb1a390117af323deb36c869444ea02752d7093a900e5022d508ae5b9",
    },
    "datadog": {
        "url": "https://github.com/datadog-labs/mcp-server.git",
        "commit": "1bef654fa5fff69e233332f286ea9a328581ab11",
        "prefix": "",
        "licensePaths": ["LICENSE"],
        "frozenSourceDigest": "1c763fcaf3d2eae09b5b72e82d21935ad4366ccec19d543f9cd1338e93ceb86f",
    },
    "dropbox": {
        "url": "https://github.com/dropbox/dropbox-ai-plugins.git",
        "commit": "ec1a5264a88081a6161d984d87705ce65535fbe0",
        "prefix": "codex/",
        "licensePaths": ["LICENSE", "codex/LICENSE"],
        "frozenSourceDigest": "5c6afefe72fe0f56c12877ebbcfaf672f8f027a7aff4302d5786d3b2a5f12668",
    },
    "lovable": {
        "url": "https://github.com/lovablelabs/mcp.git",
        "commit": "0336e6db8026b0f02cb89d1451cc48ea3f469791",
        "prefix": "",
        "licensePaths": ["LICENSE"],
        "frozenSourceDigest": "8cc06b23524e5dfe964f8efb63010bafe2b3a8f44098fae59c58527da7127c68",
    },
}
NOTICE_NAME = re.compile(r"^(LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT|THIRD[-_]?PARTY)(\.|$)", re.I)


def git(repo, *args):
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1")
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def blob_oid(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def tree(repo, commit):
    paths_by_oid = {}
    oid_by_path = {}
    for record in git(repo, "ls-tree", "-rz", commit).split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        _mode, kind, oid = metadata.decode().split()
        if kind != "blob":
            continue
        path = raw_path.decode()
        paths_by_oid.setdefault(oid, []).append(path)
        oid_by_path[path] = oid
    return paths_by_oid, oid_by_path


def history_hits(repo, pinned, wanted):
    """Return a most-recent ancestor tree containing each wanted blob."""
    if not wanted:
        return {}, len(git(repo, "rev-list", pinned).splitlines())
    reachable = {row.split(b" ", 1)[0].decode()
                 for row in git(repo, "rev-list", "--objects", pinned).splitlines()}
    remaining = wanted & reachable
    commits = git(repo, "rev-list", pinned).decode().splitlines()
    hits = {}
    for commit in commits[1:]:  # pinned tree was already compared directly
        if not remaining:
            break
        paths_by_oid, _ = tree(repo, commit)
        for oid in remaining & paths_by_oid.keys():
            hits[oid] = {"commit": commit, "matchingPaths": sorted(paths_by_oid[oid])}
        remaining -= hits.keys()
    if remaining:
        raise ValueError(f"reachable Git blobs missing from scanned ancestor trees: {remaining}")
    return hits, len(commits)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in SOURCES:
        parser.add_argument(f"--{name}-repo", required=True, type=Path)
    args = parser.parse_args()
    inventory = json.loads(INVENTORY.read_text())
    if inventory["batchDigest"] != FROZEN_BATCH:
        raise ValueError("frozen batch digest changed")
    report = {
        "schemaVersion": 1,
        "frozenBatchDigest": FROZEN_BATCH,
        "scope": "Five official public candidate repositories and pinned default-branch ancestry only.",
        "limitation": "Exact bytes in an official repository do not establish rights for unmatched files, brand assets, OpenAI plugin metadata, or public redistribution.",
        "packages": [],
    }
    for name, source in SOURCES.items():
        repo = getattr(args, f"{name}_repo").resolve()
        remote = git(repo, "remote", "get-url", "origin").decode().strip()
        if remote.casefold().removesuffix(".git") != source["url"].casefold().removesuffix(".git"):
            raise ValueError(f"{name}: unexpected Git origin {remote}")
        if git(repo, "rev-parse", "--is-shallow-repository").decode().strip() != "false":
            raise ValueError(f"{name}: shallow history is insufficient")
        pinned = source["commit"]
        if git(repo, "rev-parse", "--verify", f"{pinned}^{{commit}}").decode().strip() != pinned:
            raise ValueError(f"{name}: pinned commit unavailable")
        current, by_path = tree(repo, pinned)
        frozen = next(p for p in inventory["packages"] if p["id"] == name)
        if frozen["sourceDigest"] != source["frozenSourceDigest"]:
            raise ValueError(f"{name}: frozen source digest changed")
        files = []
        for entry in frozen["files"]:
            relative = entry["path"]
            data = (PACKAGES / name / relative).read_bytes()
            if len(data) != entry["bytes"] or sha256(data) != entry["sha256"]:
                raise ValueError(f"{name}/{relative}: frozen bytes changed")
            oid = blob_oid(data)
            matching = sorted(current.get(oid, []))
            expected = source["prefix"] + relative
            expected_oid = by_path.get(expected)
            if matching and sha256(git(repo, "cat-file", "blob", oid)) != entry["sha256"]:
                raise ValueError(f"{name}/{relative}: upstream blob bytes differ")
            files.append({
                "path": relative,
                "frozenSha256": entry["sha256"],
                "gitBlobOid": oid,
                "expectedCandidatePath": expected,
                "expectedCandidatePathExistsAtPinnedCommit": expected_oid is not None,
                "expectedCandidatePathSha256AtPinnedCommit": (
                    sha256(git(repo, "cat-file", "blob", expected_oid)) if expected_oid else None),
                "status": ("same_path_same_bytes" if expected in matching else
                           "same_bytes_other_path" if matching else "no_pinned_commit_match"),
                "matchingPathsAtPinnedCommit": matching,
            })
        unmatched = {f["gitBlobOid"] for f in files if f["status"] == "no_pinned_commit_match"}
        historical, commit_count = history_hits(repo, pinned, unmatched)
        for file in files:
            if file["status"] != "no_pinned_commit_match":
                continue
            hit = historical.get(file["gitBlobOid"])
            if hit:
                if sha256(git(repo, "cat-file", "blob", file["gitBlobOid"])) != file["frozenSha256"]:
                    raise ValueError(f"{name}/{file['path']}: historical blob bytes differ")
                file["status"] = ("history_same_path_same_bytes" if file["expectedCandidatePath"]
                                  in hit["matchingPaths"] else "history_same_bytes_other_path")
                file["historicalMatch"] = hit
            else:
                file["status"] = "no_match_in_pinned_history"
        licenses = []
        for path in source["licensePaths"]:
            if path not in by_path:
                raise ValueError(f"{name}: expected candidate license absent: {path}")
            licenses.append({"path": path,
                             "sha256": sha256(git(repo, "cat-file", "blob", by_path[path]))})
        statuses = ("same_path_same_bytes", "same_bytes_other_path",
                    "history_same_path_same_bytes", "history_same_bytes_other_path",
                    "no_match_in_pinned_history")
        report["packages"].append({
            "id": name,
            "frozenSourceDigest": frozen["sourceDigest"],
            "candidateOfficialRepository": source["url"],
            "pinnedCommit": pinned,
            "pinnedCommitDate": git(repo, "show", "-s", "--format=%cI", pinned).decode().strip(),
            "candidatePrefix": source["prefix"],
            "reachableHistoryCommitCount": commit_count,
            "candidateLicenseFiles": licenses,
            "candidateNoticeNamedPathsUnderPrefix": sorted(
                path for path in by_path if path.startswith(source["prefix"])
                and NOTICE_NAME.match(Path(path).name)),
            "frozenNoticePaths": [notice["path"] for notice in frozen["notices"]],
            "counts": {status: sum(f["status"] == status for f in files) for status in statuses},
            "files": files,
        })
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
