#!/usr/bin/env python3
"""Check the observed batching/padding risk without changing frozen qrels.

Use the comparison encoder's pinned contracts. This diagnostic is additional
to the three-round single-record comparison; it does not tune model settings,
replace the primary score, or measure App/Intel deployment performance.
"""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys

import numpy as np


SCRIPT = Path(__file__).with_name("shoggoth-memory-p4-compare-models.py")
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("memory_comparison", SCRIPT)
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


def similarity(left, right):
    return round(float(left @ right), 6)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", required=True, type=Path)
    args = parser.parse_args()
    root = args.artifacts.resolve()
    if not root.is_relative_to(trial.REPO / ".artifacts"):
        parser.error("Use this repository's .artifacts")
    data = trial.frozen(trial.FIXTURE, trial.FIXTURE_SHA)
    lexical = json.loads((root / "lexical-multilingual.json").read_text())["found"]
    report = {"kind": "additional-batch-padding-diagnostic", "fixtureSha256": trial.FIXTURE_SHA,
              "observedAtUtc": datetime.now(timezone.utc).isoformat(), "models": [],
              "limits": ["Primary quality scores remain those of single-record encoding",
                         "Differences here concern selected quantized exports; no claim about original full-precision models",
                         "This probe does not establish the cause of a difference or validate production integration"]}
    for key in trial.KEYS:
        folder, _manifest = trial.verified_model(key, root)
        encoder = trial.Encoder(key, folder)
        encoder.configure_lengths()
        ids = [row["id"] for row in data["records"]]
        corpus = {}
        for language in ["zh", "en"]:
            corpus[language], _elapsed = trial.batch_build(encoder, [row[language] for row in data["records"]])
        corpus["mixed"] = np.stack([corpus["zh" if index % 2 == 0 else "en"][index] for index in range(len(ids))])
        metrics, rows = trial.retrieval_rows(encoder, data["queries"], corpus, ids, lexical)
        probes = []
        for position in [0, 16, 32]:
            for language in ["zh", "en"]:
                text = data["records"][position][language]
                base = encoder.encode([text])[0]
                duplicate = encoder.encode([text, text])[0]
                neighbor = encoder.encode([text, data["records"][-1][language]])[0]
                encoder.tokenizer.enable_padding(length=64, pad_id=encoder.padding["id"],
                                                 pad_token=encoder.padding["token"], direction="right")
                padded = encoder.encode([text])[0]
                encoder.tokenizer.enable_padding(pad_id=encoder.padding["id"],
                                                 pad_token=encoder.padding["token"], direction="right")
                probes.append({"recordId": ids[position], "language": language,
                               "sameTextAndSameNeighborCosine": similarity(base, duplicate),
                               "sameTextDifferentNeighborCosine": similarity(base, neighbor),
                               "sameTextPaddedTo64Cosine": similarity(base, padded)})
        single = json.loads((root / f"{key}-round-1.json").read_text())
        old = {row["id"]: row for row in single["rows"]}
        changed_top1 = [row["id"] for row in rows if row["semantic"][0] != old[row["id"]]["semantic"][0]]
        changed_top5 = [row["id"] for row in rows if set(row["semantic"]) != set(old[row["id"]]["semantic"])]
        item = {"key": key, "indexBatchSize": 16, "queryBatchSize": 1, "metrics": metrics,
                "singleRecordIndexMetrics": single["metrics"], "paddingProbes": probes,
                "changedTop1Queries": changed_top1, "changedTop5Queries": changed_top5, "rows": rows}
        report["models"].append(item)
        trial.save(root / "batch-index-diagnostics.json", report)
        print(json.dumps({"key": key, "batchIndexVector": metrics["vector"]["all"],
                          "batchIndexHybrid": metrics["hybridRrf"]["all"],
                          "changedTop1": len(changed_top1), "changedTop5": len(changed_top5),
                          "paddingProbes": probes}, ensure_ascii=False), flush=True)
    report["completedAtUtc"] = datetime.now(timezone.utc).isoformat()
    report["status"] = "complete"
    trial.save(root / "batch-index-diagnostics.json", report)


if __name__ == "__main__":
    main()
