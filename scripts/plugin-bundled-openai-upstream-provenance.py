#!/usr/bin/env python3
"""Compare every frozen bundled plugin file with one pinned openai/plugins tree.

This is a read-only source-identity check, not a redistribution license review.
The archive supplies blob bytes; the Git clone supplies the immutable tree IDs.
Every archive blob and executable bit must agree with that tree before any
frozen-file match is reported. No Git lazy fetch or archive extraction occurs.
"""

import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile


ROOT = Path(__file__).resolve().parent.parent
INVENTORY = ROOT / "docs/architecture/bundled-license-evidence-2026-09-27.json"
PACKAGES = ROOT / "resources/bundled-plugins/packages"
BATCH = "8d4783872d4be5dd09e65d14e79c26bd92c3a2d3884af04934e239b4c2d5ffa9"
REPOSITORY = "https://github.com/openai/plugins.git"
COMMIT = "1dc195897af4161d039b80d8471ec0a10c9bbc89"
STATUSES = (
    "same_path_same_bytes_and_mode",
    "same_path_same_bytes_mode_differs",
    "same_bytes_other_path",
    "different_bytes_at_same_path",
    "no_match_in_pinned_tree",
)


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args],
        env={**os.environ, "GIT_NO_LAZY_FETCH": "1"},
    )


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def blob_oid(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def tree_at_commit(repo):
    remote = git(repo, "remote", "get-url", "origin").decode().strip()
    if remote.casefold().removesuffix(".git") != REPOSITORY.casefold().removesuffix(".git"):
        raise ValueError(f"unexpected origin: {remote}")
    resolved = git(repo, "rev-parse", "--verify", f"{COMMIT}^{{commit}}").decode().strip()
    if resolved != COMMIT:
        raise ValueError(f"pinned commit unavailable: {COMMIT}")
    tree = {}
    for row in git(repo, "ls-tree", "-rz", COMMIT, "plugins").split(b"\0"):
        if not row:
            continue
        metadata, raw_path = row.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        path = raw_path.decode()
        if kind != "blob" or mode not in ("100644", "100755"):
            raise ValueError(f"unsupported upstream entry: {path} ({mode} {kind})")
        tree[path] = (mode, oid)
    return tree


def read_frozen(inventory):
    if inventory["batchDigest"] != BATCH:
        raise ValueError("frozen batch digest changed")
    if len(inventory["packages"]) != 62:
        raise ValueError("frozen package count changed")
    frozen = {}
    for package in inventory["packages"]:
        package_id = package["id"]
        for item in package["files"]:
            relative = item["path"]
            path = PACKAGES / package_id / relative
            if not path.is_file() or path.is_symlink():
                raise ValueError(f"missing or nonregular frozen file: {path}")
            data = path.read_bytes()
            if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
                raise ValueError(f"frozen inventory bytes changed: {path}")
            upstream_path = f"plugins/{package_id}/{relative}"
            if upstream_path in frozen:
                raise ValueError(f"duplicate frozen path: {upstream_path}")
            frozen[upstream_path] = {
                "sha256": item["sha256"],
                "gitBlobOid": blob_oid(data),
                "bytes": len(data),
                "executable": bool(path.stat().st_mode & stat.S_IXUSR),
            }
    if len(frozen) != 5378:
        raise ValueError("frozen file count changed")
    actual = {
        "plugins/" + path.relative_to(PACKAGES).as_posix()
        for path in PACKAGES.rglob("*") if path.is_file()
    }
    if actual != frozen.keys():
        raise ValueError(f"frozen path set changed: {len(actual - frozen.keys())} extra, "
                         f"{len(frozen.keys() - actual)} missing")
    return frozen


def read_archive(archive_path, tree, frozen):
    archive = {}
    with tarfile.open(archive_path, "r:gz") as source:
        comment = source.pax_headers.get("comment")
        if comment is not None and comment != COMMIT:
            raise ValueError(f"archive commit comment differs: {comment}")
        roots = set()
        for member in source:
            parts = member.name.split("/")
            if not parts or any(part in ("", ".", "..") for part in parts):
                raise ValueError(f"unsafe archive path: {member.name}")
            roots.add(parts[0])
            if len(parts) < 3 or parts[1] != "plugins":
                continue
            relative = "/".join(parts[1:])
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"nonregular upstream plugin entry: {relative}")
            if relative in archive:
                raise ValueError(f"duplicate upstream archive entry: {relative}")
            if relative not in tree or relative not in frozen:
                raise ValueError(f"unexpected upstream archive file: {relative}")
            if member.size != frozen[relative]["bytes"]:
                raise ValueError(f"archive size differs from frozen inventory: {relative}")
            data = source.extractfile(member).read()
            mode = "100755" if member.mode & 0o111 else "100644"
            oid = blob_oid(data)
            if tree.get(relative) != (mode, oid):
                raise ValueError(f"archive bytes/mode do not match pinned Git tree: {relative}")
            archive[relative] = {
                "sha256": sha256(data), "gitBlobOid": oid,
                "bytes": len(data), "executable": mode == "100755",
                "sameFrozenBytes": (data == (PACKAGES / relative.removeprefix("plugins/")).read_bytes()
                                    if relative in frozen else None),
            }
        if len(roots) != 1:
            raise ValueError(f"archive has multiple roots: {sorted(roots)}")
    if archive.keys() != tree.keys():
        raise ValueError(f"archive/Git plugin tree differ: {len(tree.keys() - archive.keys())} "
                         f"missing, {len(archive.keys() - tree.keys())} extra")
    return archive


def complete_counts(counts):
    return {
        **{status: counts[status] for status in STATUSES},
        "filesWithDuplicateUpstreamBytes": counts["filesWithDuplicateUpstreamBytes"],
        "nonSkillMdFiles": counts["nonSkillMdFiles"],
        "skillMdFiles": counts["skillMdFiles"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path,
                        help="local openai/plugins Git clone containing the pinned commit tree")
    parser.add_argument("--archive", required=True, type=Path,
                        help="GitHub source tar.gz for the pinned commit")
    args = parser.parse_args()
    inventory = json.loads(INVENTORY.read_text())
    frozen = read_frozen(inventory)
    tree = tree_at_commit(args.repo.resolve())
    upstream = read_archive(args.archive.resolve(), tree, frozen)
    oid_paths = defaultdict(list)
    for path, item in upstream.items():
        oid_paths[item["gitBlobOid"]].append(path)

    packages = []
    totals = defaultdict(int)
    for package in inventory["packages"]:
        records = []
        counts = defaultdict(int)
        for item in package["files"]:
            path = item["path"]
            full_path = f"plugins/{package['id']}/{path}"
            local = frozen[full_path]
            candidate = upstream.get(full_path)
            matches = oid_paths.get(local["gitBlobOid"], [])
            same_path_bytes = candidate is not None and candidate["sameFrozenBytes"]
            exact = same_path_bytes and candidate["executable"] == local["executable"]
            if exact:
                status = "same_path_same_bytes_and_mode"
            elif same_path_bytes:
                status = "same_path_same_bytes_mode_differs"
            elif matches:
                status = "same_bytes_other_path"
            elif candidate is not None:
                status = "different_bytes_at_same_path"
            else:
                status = "no_match_in_pinned_tree"
            duplicate_paths = len(matches) - (1 if full_path in matches else 0)
            record = {
                "path": path,
                "frozenSha256": local["sha256"],
                "gitBlobOid": local["gitBlobOid"],
                "status": status,
                "byteIdenticalOtherUpstreamPaths": duplicate_paths,
            }
            if not exact:
                record["matchingUpstreamPaths"] = sorted(matches)
                record["samePathUpstreamSha256"] = candidate["sha256"] if candidate else None
            records.append(record)
            counts[status] += 1
            totals[status] += 1
            if duplicate_paths:
                counts["filesWithDuplicateUpstreamBytes"] += 1
                totals["filesWithDuplicateUpstreamBytes"] += 1
            if path.endswith("/SKILL.md"):
                counts["skillMdFiles"] += 1
                totals["skillMdFiles"] += 1
            else:
                counts["nonSkillMdFiles"] += 1
                totals["nonSkillMdFiles"] += 1
        packages.append({
            "id": package["id"],
            "frozenSourceDigest": package["sourceDigest"],
            "counts": complete_counts(counts),
            "files": records,
        })
    report = {
        "schemaVersion": 1,
        "frozenBatchDigest": BATCH,
        "upstreamRepository": REPOSITORY,
        "pinnedCommit": COMMIT,
        "scope": "Pinned openai/plugins commit plugin tree, exact paths, bytes, and executable bits.",
        "limitation": "Source identity does not establish authorship, file-level license coverage, trademark rights, or redistribution permission.",
        "counts": {
            "packages": len(packages),
            "frozenFiles": len(frozen),
            "upstreamTreeFiles": len(tree),
            "archiveFiles": len(upstream),
            "frozenBytes": sum(item["bytes"] for item in frozen.values()),
            "upstreamExtraPaths": len(upstream.keys() - frozen.keys()),
            "frozenMissingUpstreamPaths": len(frozen.keys() - upstream.keys()),
            **complete_counts(totals),
        },
        "packages": packages,
    }
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
