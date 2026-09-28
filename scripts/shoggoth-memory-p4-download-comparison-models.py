#!/usr/bin/env python3
"""Download only two fixed public model repositories for an isolated P4 trial.

No user memories, credentials, runtime configuration or App files are read.
Each repository revision is pinned before downloading and every selected file
is verified against its published LFS SHA-256 or Git blob identity.
"""

import argparse
import hashlib
import json
import re
import time
import urllib.request
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MODELS = {
    "e5-small": {
        "repo": "intfloat/multilingual-e5-small",
        "revision": "614241f622f53c4eeff9890bdc4f31cfecc418b3",
        "license": "mit",
        "weight": "onnx/model_qint8_avx512_vnni.onnx",
        "pooling": "mean",
        "queryPrefix": "query: ",
        "passagePrefix": "passage: ",
        "maxTokens": 512,
    },
    "granite-97m-r2": {
        "repo": "ibm-granite/granite-embedding-97m-multilingual-r2",
        "revision": "835ad14087e140460703cf0fae09f97d469d65c2",
        "license": "apache-2.0",
        "weight": "onnx/model_quint8_avx2.onnx",
        "pooling": "cls",
        "queryPrefix": "",
        "passagePrefix": "",
        "maxTokens": 512,
    },
}
CONFIG_FILES = [
    "config.json", "tokenizer.json", "tokenizer_config.json",
    "special_tokens_map.json", "1_Pooling/config.json", "modules.json", "README.md",
]


def file_sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def get_metadata(repo, revision=None):
    suffix = f"/revision/{revision}" if revision else ""
    url = f"https://huggingface.co/api/models/{repo}{suffix}?blobs=true"
    with urllib.request.urlopen(url, timeout=30) as response:
        raw = response.read(4 * 1024 * 1024)
        if len(raw) >= 4 * 1024 * 1024:
            raise ValueError("Model metadata exceeds the fixed size limit")
    data = json.loads(raw)
    if not re.fullmatch(r"[0-9a-f]{40}", data["sha"]):
        raise ValueError("Invalid repository revision")
    return data


def verify(path, expected):
    actual_size = path.stat().st_size
    if actual_size != expected["bytes"]:
        raise ValueError(f"Size mismatch: {expected['name']}")
    actual_sha = file_sha(path)
    if expected.get("lfsSha256"):
        if actual_sha != expected["lfsSha256"]:
            raise ValueError(f"LFS SHA-256 mismatch: {expected['name']}")
    else:
        digest = hashlib.sha1(f"blob {actual_size}\0".encode())
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected["gitBlob"]:
            raise ValueError(f"Git blob mismatch: {expected['name']}")
    return {**expected, "sha256": actual_sha}


def download(repo, revision, root, expected):
    name = expected["name"]
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return verify(target, expected)
    partial = target.with_name(target.name + ".part")
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{name}"
    for attempt in range(3):
        try:
            written = 0
            last_notice = time.monotonic()
            with urllib.request.urlopen(url, timeout=30) as response, partial.open("wb") as stream:
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    written += len(chunk)
                    if written > expected["bytes"]:
                        raise ValueError(f"Response exceeds expected file size: {name}")
                    stream.write(chunk)
                    if time.monotonic() - last_notice >= 5:
                        print(f"{repo}: {name} {written}/{expected['bytes']} B", flush=True)
                        last_notice = time.monotonic()
            checked = verify(partial, expected)
            partial.replace(target)
            print(f"verified {repo}: {name} ({written} B)", flush=True)
            return checked
        except (OSError, ValueError) as error:
            print(f"download attempt {attempt + 1} failed for {repo}/{name}: {type(error).__name__}", flush=True)
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    output = args.output_dir.resolve()
    artifacts = (REPO / ".artifacts").resolve()
    if not output.is_relative_to(artifacts):
        parser.error("The output directory must be inside this repository's .artifacts")
    output.mkdir(parents=True, exist_ok=True)
    manifests = []
    for key, spec in MODELS.items():
        root = output / "models" / key
        root.mkdir(parents=True, exist_ok=True)
        metadata_path = root / "pinned-repository-metadata.json"
        if metadata_path.exists():
            metadata = json.loads(metadata_path.read_text())
            if metadata["id"] != spec["repo"] or metadata["sha"] != spec["revision"]:
                raise ValueError("Cached model metadata identity mismatch")
        else:
            metadata = get_metadata(spec["repo"], spec["revision"])
            if metadata["id"] != spec["repo"] or metadata["sha"] != spec["revision"]:
                raise ValueError("Published model metadata identity mismatch")
            metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
        revision = metadata["sha"]
        print(f"pinned {key}: {revision}", flush=True)
        siblings = {item["rfilename"]: item for item in metadata["siblings"]}
        required = [spec["weight"], "tokenizer.json", "tokenizer_config.json", "1_Pooling/config.json"]
        if any(name not in siblings for name in required):
            raise ValueError(f"Required fixed model assets missing for {key}")
        selected = [spec["weight"]] + [name for name in CONFIG_FILES if name in siblings]
        selected += [name for name in ("LICENSE", "LICENSE.txt", "NOTICE") if name in siblings]
        files = []
        for name in selected:
            entry = siblings[name]
            size = entry.get("size", entry.get("lfs", {}).get("size"))
            if not isinstance(size, int) or not 0 <= size <= 160 * 1024 * 1024:
                raise ValueError(f"Invalid or oversized fixed asset: {key}/{name}")
            expected = {"name": name, "bytes": size, "gitBlob": entry["blobId"]}
            if entry.get("lfs"):
                expected["lfsSha256"] = entry["lfs"]["sha256"]
            files.append(download(spec["repo"], revision, root, expected))
        manifest = {
            "key": key, **spec, "revision": revision,
            "localDir": str(root.relative_to(REPO)), "files": files,
            "totalBytes": sum(item["bytes"] for item in files),
            "dimensions": 384, "status": "downloaded-and-published-identity-verified",
            "macInferenceTested": False,
        }
        (root / "model-assets-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        manifests.append(manifest)
    (output / "downloaded-models.json").write_text(json.dumps(manifests, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({item["key"]: {"revision": item["revision"], "totalBytes": item["totalBytes"]}
                      for item in manifests}), flush=True)


if __name__ == "__main__":
    main()
