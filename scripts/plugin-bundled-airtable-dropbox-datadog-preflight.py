#!/usr/bin/env python3
"""Reproduce frozen-byte provenance evidence for three branded plugin packages.

Use full public repository clones checked out at the fixed commits below. The
script never fetches, installs, runs bundled Skills, or approves redistribution.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
BATCH = "8d4783872d4be5dd09e65d14e79c26bd92c3a2d3884af04934e239b4c2d5ffa9"
SOURCES = {
    "airtable": {
        "origin": "https://github.com/airtable/skills.git",
        "commit": "812ee67f1fd3d76fb45ff8df40afaa0448602ba8",
        "prefix": "plugins/airtable/",
        "prior": "bundled-vendor-upstream-provenance-2026-09-27.json",
    },
    "datadog": {
        "origin": "https://github.com/datadog-labs/mcp-server.git",
        "commit": "1bef654fa5fff69e233332f286ea9a328581ab11",
        "prefix": "",
        "prior": "bundled-remaining-vendor-provenance-2026-09-27.json",
    },
    "dropbox": {
        "origin": "https://github.com/dropbox/dropbox-ai-plugins.git",
        "commit": "ec1a5264a88081a6161d984d87705ce65535fbe0",
        "prefix": "codex/",
        "prior": "bundled-remaining-vendor-provenance-2026-09-27.json",
    },
}
LICENSE_NAME = re.compile(r"^(LICENSE|LICENCE|NOTICE|COPYING)(\.|$)", re.I)


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def blob_oid(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def git(repo, *args):
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env)


def git_tree(repo, commit):
    found = {}
    for item in git(repo, "ls-tree", "-rz", commit).split(b"\0"):
        if item:
            meta, path = item.split(b"\t", 1)
            mode, kind, oid = meta.decode().split()
            if kind == "blob":
                found[path.decode()] = {"mode": mode, "oid": oid}
    return found


def png_info(data):
    require(data.startswith(b"\x89PNG\r\n\x1a\n"), "asset is not PNG")
    offset = 8
    dimensions = None
    metadata_keys = []
    while offset + 12 <= len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        require(offset + 12 + size <= len(data), "truncated PNG chunk")
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + size]
        if kind == b"IHDR":
            require(size >= 8, "truncated PNG dimensions")
            dimensions = struct.unpack_from(">II", chunk)
        if kind in (b"tEXt", b"zTXt", b"iTXt"):
            metadata_keys.append(chunk.split(b"\0", 1)[0].decode("latin1"))
        offset += 12 + size
        if kind == b"IEND":
            break
    require(dimensions is not None, "PNG lacks dimensions")
    return {"width": dimensions[0], "height": dimensions[1],
            "textMetadataKeys": sorted(metadata_keys)}


def svg_info(data):
    root = ET.fromstring(data)
    require(root.tag.endswith("}svg") or root.tag == "svg", "asset is not SVG")
    hrefs = [value for node in root.iter() for key, value in node.attrib.items()
             if key.endswith("}href") or key == "href"]
    return {"width": root.attrib.get("width"), "height": root.attrib.get("height"),
            "viewBox": root.attrib.get("viewBox"), "externalReferences":
            sorted(value for value in hrefs if ":" in value or value.startswith("//"))}


def skill_license_claim(data):
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return None
    if not lines or lines[0] != "---":
        return None
    for line in lines[1:]:
        if line == "---":
            break
        match = re.fullmatch(r"license:\s*(\S.*?)\s*", line)
        if match:
            return match.group(1)
    return None


def prior_row(prior, path):
    return next(item for item in prior["files"] if item["path"] == path)


def verify_history(repo, source, old, raw):
    found = old.get("sameBytesInPinnedCommitAncestry") or old.get("historicalMatch")
    if not found:
        return None
    ancestor = found["commit"]
    require(subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor",
                            ancestor, source["commit"]],
                           env=dict(os.environ, GIT_NO_LAZY_FETCH="1"),
                           check=False).returncode == 0,
            f"historical commit is not an ancestor: {ancestor}")
    tree = git_tree(repo, ancestor)
    paths = found.get("paths", found.get("matchingPaths", []))
    require(paths, "empty historical match")
    for path in paths:
        require(path in tree and git(repo, "cat-file", "blob", tree[path]["oid"]) == raw,
                f"historical byte mismatch: {ancestor}/{path}")
    return {"commit": ancestor, "sameBytePaths": sorted(paths)}


def inspect(package_id, repo, source, frozen, catalog):
    require(git(repo, "remote", "get-url", "origin").decode().strip() == source["origin"],
            f"origin mismatch: {package_id}")
    require(git(repo, "rev-parse", "HEAD").decode().strip() == source["commit"],
            f"HEAD mismatch: {package_id}")
    require(git(repo, "rev-parse", "--is-shallow-repository").decode().strip() == "false",
            f"shallow history: {package_id}")
    require(frozen["sourceDigest"] == catalog["sourceDigest"],
            f"catalog/source digest mismatch: {package_id}")
    prior_doc = json.loads((ROOT / "docs/architecture" / source["prior"]).read_text())
    require(prior_doc["frozenBatchDigest"] == BATCH, f"prior batch mismatch: {package_id}")
    prior = next(item for item in prior_doc["packages"] if item["id"] == package_id)
    require(prior["pinnedCommit"] == source["commit"] and
            prior["frozenSourceDigest"] == frozen["sourceDigest"],
            f"prior source mismatch: {package_id}")

    directory = ROOT / "resources/bundled-plugins/packages" / package_id
    walked = list(directory.rglob("*"))
    require(not any(path.is_symlink() for path in walked), f"symlink in package: {package_id}")
    actual = {str(path.relative_to(directory)): path for path in walked if path.is_file()}
    expected = {item["path"]: item for item in frozen["files"]}
    require(set(actual) == set(expected) == {item["path"] for item in prior["files"]},
            f"file set mismatch: {package_id}")
    manifest = json.loads(actual[".codex-plugin/plugin.json"].read_text())
    interface = manifest.get("interface", {})
    roles = {}
    for field in ("composerIcon", "logo", "logoDark"):
        value = interface.get(field)
        if isinstance(value, str):
            roles.setdefault(value.removeprefix("./"), []).append(field)
    for value in interface.get("screenshots", []):
        require(isinstance(value, str), f"invalid screenshot path: {package_id}")
        roles.setdefault(value.removeprefix("./"), []).append("screenshot")
    require(all(path in actual for path in roles), f"missing manifest asset: {package_id}")

    current_tree = git_tree(repo, source["commit"])
    aliases_by_oid = {}
    for path, entry in current_tree.items():
        aliases_by_oid.setdefault(entry["oid"], []).append(path)
    reachable = {line.split(b" ", 1)[0].decode()
                 for line in git(repo, "rev-list", "--objects", source["commit"]).splitlines()}
    rows = []
    for path in sorted(actual):
        raw = actual[path].read_bytes()
        item = expected[path]
        require(len(raw) == item["bytes"] and sha256(raw) == item["sha256"],
                f"frozen SHA-256/size mismatch: {package_id}/{path}")
        old = prior_row(prior, path)
        require(old["frozenSha256"] == sha256(raw) and old["gitBlobOid"] == blob_oid(raw),
                f"prior frozen byte mismatch: {package_id}/{path}")
        candidate = source["prefix"] + path
        require((old.get("expectedVendorPath") or old.get("expectedCandidatePath")) == candidate,
                f"prior candidate path mismatch: {package_id}/{path}")
        entry = current_tree.get(candidate)
        candidate_bytes = git(repo, "cat-file", "blob", entry["oid"]) if entry else None
        if entry:
            require(blob_oid(candidate_bytes) == entry["oid"],
                    f"candidate Git object mismatch: {package_id}/{path}")
        if "expectedCandidatePathSha256AtPinnedCommit" in old:
            require(old["expectedCandidatePathSha256AtPinnedCommit"] ==
                    (sha256(candidate_bytes) if candidate_bytes is not None else None),
                    f"prior candidate byte mismatch: {package_id}/{path}")
        aliases = sorted(aliases_by_oid.get(blob_oid(raw), []))
        require(aliases == sorted(old["matchingPathsAtPinnedCommit"]),
                f"prior current-match mismatch: {package_id}/{path}")
        for alias in aliases:
            require(git(repo, "cat-file", "blob", current_tree[alias]["oid"]) == raw,
                    f"current alias byte mismatch: {package_id}/{alias}")
        historical = verify_history(repo, source, old, raw)
        require((blob_oid(raw) in reachable) == bool(historical or aliases),
                f"history reachability mismatch: {package_id}/{path}")
        row = {
            "path": path, "bytes": len(raw), "sha256": sha256(raw),
            "gitBlobOid": blob_oid(raw), "manifestAssetRoles": roles.get(path, []),
            "candidatePath": candidate,
            "candidateState": ("same" if candidate_bytes == raw else
                               "different" if candidate_bytes is not None else "absent"),
            "candidateSha256": sha256(candidate_bytes) if candidate_bytes is not None else None,
            "sameBlobCurrentPaths": aliases,
            "verifiedHistoricalMatch": historical,
            "blobReachableInPinnedHistory": blob_oid(raw) in reachable,
            "rightsReview": "pending",
        }
        if path.endswith(".png"):
            row["png"] = png_info(raw)
        elif path.endswith(".svg"):
            row["svg"] = svg_info(raw)
        elif path.endswith("/SKILL.md"):
            row["frozenSkillLicenseClaim"] = skill_license_claim(raw)
        rows.append(row)
    license_files = [{"path": path,
                      "sha256": sha256(git(repo, "cat-file", "blob", entry["oid"]))}
                     for path, entry in sorted(current_tree.items())
                     if LICENSE_NAME.match(path.rsplit("/", 1)[-1])]
    if package_id == "airtable":
        require({"path": prior["licensePath"], "sha256": prior["licenseSha256"]}
                in license_files, "prior Airtable license mismatch")
    else:
        for item in prior["candidateLicenseFiles"]:
            require({"path": item["path"], "sha256": item["sha256"]} in license_files,
                    f"prior license mismatch: {package_id}/{item['path']}")
    return {
        "id": package_id, "frozenSourceDigest": frozen["sourceDigest"],
        "frozenManifestLicense": frozen["manifestLicense"],
        "frozenNoticePaths": [item["path"] for item in frozen["files"] if item["isNotice"]],
        "sourceOrigin": source["origin"], "sourceCommit": source["commit"],
        "sourcePrefix": source["prefix"], "upstreamLicenseFiles": license_files,
        "reachableCommitCount": len(git(repo, "rev-list", source["commit"]).splitlines()),
        "sameCandidatePathCount": sum(row["candidateState"] == "same" for row in rows),
        "sameBlobCurrentCount": sum(bool(row["sameBlobCurrentPaths"]) for row in rows),
        "verifiedHistoricalMatchCount": sum(row["verifiedHistoricalMatch"] is not None
                                            for row in rows),
        "files": rows, "rightsReview": "pending",
    }


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
    entries = {item["id"]: item for item in catalog["packages"]}
    packages = [inspect(package_id, getattr(args, package_id + "_repo"), source,
                        frozen[package_id], entries[package_id])
                for package_id, source in SOURCES.items()]
    print(json.dumps({"schemaVersion": 1, "batchDigest": BATCH,
                      "limitation": "Provenance is not a license grant; every file and package remains pending.",
                      "packages": packages}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
