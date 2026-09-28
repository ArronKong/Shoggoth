#!/usr/bin/env python3
"""Snapshot public Hugging Face metadata for the three selected P4 models.

Downloads are request counts, not unique users, market share or install counts.
The converted MiniLM repository is recorded separately from the original.
"""

import argparse
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MODEL_REPOS = [
    ("minilm", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "original-model"),
    ("e5-small", "intfloat/multilingual-e5-small", "original-model"),
    ("granite-97m-r2", "ibm-granite/granite-embedding-97m-multilingual-r2", "original-model"),
    ("minilm-onnx-distribution", "onnx-community/paraphrase-multilingual-MiniLM-L12-v2-ONNX", "converted-distribution"),
]

def fetch_json(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                return json.loads(response.read(1024 * 1024))
        except OSError as error:
            if attempt == 2:
                raise
            print(f"public metadata retry {attempt + 1}: {type(error).__name__}", flush=True)
            time.sleep(1 + attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to((REPO / ".artifacts").resolve()):
        parser.error("The output must be inside this repository's .artifacts")
    fields = ["downloads", "likes", "createdAt", "lastModified", "sha"]
    query = urllib.parse.urlencode([("expand[]", field) for field in fields])
    rows = []
    for key, model_repo, role in MODEL_REPOS:
        url = f"https://huggingface.co/api/models/{model_repo}?{query}"
        data = fetch_json(url)
        observed = datetime.now(timezone.utc).isoformat()
        downloads, likes = data.get("downloads"), data.get("likes")
        if not isinstance(downloads, int) or not isinstance(likes, int):
            raise ValueError(f"Public download/like metrics unavailable for {key}")
        row = {
            "key": key, "repo": model_repo, "role": role,
            "observedAtUtc": observed, "downloadsLastMonth": downloads,
            "likes": likes, "createdAt": data.get("createdAt"),
            "lastModified": data.get("lastModified"), "revision": data.get("sha"),
            "modelPage": f"https://huggingface.co/{model_repo}",
            "publicApi": url,
            "uniqueUsers": None, "installedUsers": None, "marketShare": None,
        }
        rows.append(row)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({"status": "collecting", "rows": rows}, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(row, ensure_ascii=False), flush=True)
    report = {
        "kind": "live-public-huggingface-model-metadata",
        "status": "complete",
        "rows": rows,
        "downloadCountingDocumentation": "https://huggingface.co/docs/hub/models-download-stats",
        "limits": [
            "Model download counters count selected-file requests including GET and HEAD",
            "Original model and converted distribution are separate repositories",
            "Likes and downloads are not retrieval-quality scores or unique install counts",
            "Repository creation and modification times are not necessarily model-release dates",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
