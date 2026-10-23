#!/usr/bin/env python3
"""Read-only frozen-byte/brand-asset preflight for Canva, monday.com, Consensus.

Requires complete public repository clones at the pinned commits; never fetches.
Exact Git matches and license-file presence are evidence, not rights approval.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess


ROOT = Path(__file__).resolve().parent.parent
BATCH = "8d4783872d4be5dd09e65d14e79c26bd92c3a2d3884af04934e239b4c2d5ffa9"
SOURCES = {
    "canva": {
        "origin": "https://github.com/canva-sdks/canva-skills.git",
        "commit": "b56291ea0a36d0a941e1478b47959be5f1771dee",
        "prefix": "plugins/canva/",
    },
    "monday-com": {
        "origin": "https://github.com/mondaycom/skills.git",
        "commit": "ee1f86171ba8c10879532d8334b2c19b61f1c372",
        "prefix": "",
    },
    "consensus": {
        "origin": "https://github.com/Consensus-NLP/consensus-mcp.git",
        "commit": "da2d7d353165823241b2717cf5e946aff6ada37f",
        "prefix": "",
    },
}
LICENSE_NAME = re.compile(r"^(LICENSE|LICENCE|NOTICE|COPYING)(\.|$)", re.I)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git(repo, *args):
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


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


def png_info(data):
    require(data.startswith(b"\x89PNG\r\n\x1a\n"), "asset is not PNG")
    offset = 8
    width = height = None
    text_keys = []
    while offset + 12 <= len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + size]
        require(offset + 12 + size <= len(data), "truncated PNG chunk")
        if kind == b"IHDR":
            width, height = struct.unpack_from(">II", chunk)
        if kind in (b"tEXt", b"zTXt", b"iTXt"):
            text_keys.append(chunk.split(b"\0", 1)[0].decode("latin1"))
        offset += 12 + size
        if kind == b"IEND":
            break
    require(width is not None and height is not None, "PNG lacks IHDR")
    return {"width": width, "height": height, "textMetadataKeys": sorted(text_keys)}


def inspect(package_id, source, repo, frozen):
    require(git(repo, "remote", "get-url", "origin").decode().strip() == source["origin"],
            f"origin mismatch: {package_id}")
    require(git(repo, "rev-parse", "HEAD").decode().strip() == source["commit"],
            f"HEAD mismatch: {package_id}")
    require(git(repo, "rev-parse", "--is-shallow-repository").decode().strip() == "false",
            f"shallow history: {package_id}")
    git_tree = tree(repo, source["commit"])
    aliases_by_oid = {}
    for path, entry in git_tree.items():
        aliases_by_oid.setdefault(entry["oid"], []).append(path)
    reachable = {line.split(b" ", 1)[0].decode()
                 for line in git(repo, "rev-list", "--objects", source["commit"]).splitlines()}

    directory = ROOT / "resources/bundled-plugins/packages" / package_id
    paths = list(directory.rglob("*"))
    require(not any(path.is_symlink() for path in paths), f"symlink in frozen package: {package_id}")
    actual = {str(path.relative_to(directory)): path for path in paths if path.is_file()}
    expected = {item["path"]: item for item in frozen["files"]}
    require(set(actual) == set(expected), f"frozen file set mismatch: {package_id}")
    manifest = json.loads(actual[".codex-plugin/plugin.json"].read_text())
    icon_roles = {}
    for role in ("composerIcon", "logo"):
        value = manifest.get("interface", {}).get(role)
        if isinstance(value, str):
            icon_roles.setdefault(value.removeprefix("./"), []).append(role)
    require(all(path in actual for path in icon_roles), f"missing manifest icon: {package_id}")

    rows = []
    for path in sorted(actual):
        raw = actual[path].read_bytes()
        require(len(raw) == expected[path]["bytes"] and sha256(raw) == expected[path]["sha256"],
                f"frozen SHA-256/size mismatch: {package_id}/{path}")
        oid = blob_oid(raw)
        candidate = source["prefix"] + path
        entry = git_tree.get(candidate)
        candidate_bytes = git(repo, "cat-file", "blob", entry["oid"]) if entry else None
        if entry:
            require(blob_oid(candidate_bytes) == entry["oid"],
                    f"candidate Git object mismatch: {package_id}/{path}")
        aliases = sorted(aliases_by_oid.get(oid, []))
        for alias in aliases:
            require(git(repo, "cat-file", "blob", git_tree[alias]["oid"]) == raw,
                    f"upstream alias byte mismatch: {package_id}/{alias}")
        row = {
            "path": path,
            "bytes": len(raw),
            "sha256": sha256(raw),
            "gitBlobOid": oid,
            "manifestIconRoles": icon_roles.get(path, []),
            "candidatePath": candidate,
            "candidateState": ("same" if candidate_bytes == raw else
                               "different" if candidate_bytes is not None else "absent"),
            "candidateSha256": sha256(candidate_bytes) if candidate_bytes is not None else None,
            "sameBlobCurrentPaths": aliases,
            "blobReachableInPinnedHistory": oid in reachable,
            "rightsReview": "pending",
        }
        if path.endswith(".png"):
            row["png"] = png_info(raw)
        rows.append(row)

    license_files = []
    for path, entry in sorted(git_tree.items()):
        if LICENSE_NAME.match(path.rsplit("/", 1)[-1]):
            license_files.append({"path": path,
                                  "sha256": sha256(git(repo, "cat-file", "blob", entry["oid"]))})
    return {
        "id": package_id,
        "frozenSourceDigest": frozen["sourceDigest"],
        "frozenManifestLicense": frozen["manifestLicense"],
        "sourceOrigin": source["origin"],
        "sourceCommit": source["commit"],
        "sourcePrefix": source["prefix"],
        "reachableCommitCount": len(git(repo, "rev-list", source["commit"]).splitlines()),
        "upstreamLicenseFiles": license_files,
        "frozenNoticePaths": [item["path"] for item in frozen["files"] if item["isNotice"]],
        "sameCandidatePathCount": sum(row["candidateState"] == "same" for row in rows),
        "sameBlobCurrentCount": sum(bool(row["sameBlobCurrentPaths"]) for row in rows),
        "files": rows,
    }


def check_prior_provenance(package, source):
    filename = ("bundled-remaining-vendor-provenance-2026-09-27.json"
                if package["id"] == "consensus" else
                "bundled-vendor-upstream-provenance-2026-09-27.json")
    prior = json.loads((ROOT / "docs/architecture" / filename).read_text())
    require(prior["frozenBatchDigest"] == BATCH, f"prior batch mismatch: {package['id']}")
    previous = next(item for item in prior["packages"] if item["id"] == package["id"])
    require(previous["pinnedCommit"] == source["commit"] and
            previous["frozenSourceDigest"] == package["frozenSourceDigest"],
            f"prior commit/source mismatch: {package['id']}")
    prior_files = {item["path"]: item for item in previous["files"]}
    require(set(prior_files) == {item["path"] for item in package["files"]},
            f"prior file set mismatch: {package['id']}")
    for item in package["files"]:
        old = prior_files[item["path"]]
        require(old["frozenSha256"] == item["sha256"] and
                old["gitBlobOid"] == item["gitBlobOid"] and
                sorted(old["matchingPathsAtPinnedCommit"]) == item["sameBlobCurrentPaths"],
                f"prior byte/provenance mismatch: {package['id']}/{item['path']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for package_id in SOURCES:
        parser.add_argument("--" + package_id + "-repo", required=True, type=Path)
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
    packages = [inspect(package_id, source,
                        getattr(args, package_id.replace("-", "_") + "_repo"), frozen[package_id])
                for package_id, source in SOURCES.items()]
    for package in packages:
        check_prior_provenance(package, SOURCES[package["id"]])
    result = {
        "schemaVersion": 1,
        "batchDigest": BATCH,
        "limitation": "Byte and asset evidence only; all rights reviews remain pending.",
        "packages": packages,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
