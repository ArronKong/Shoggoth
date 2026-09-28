#!/usr/bin/env python3
"""Compare three pinned quantized models offline on frozen synthetic data.

Run with numpy, onnxruntime and tokenizers already available. Downloads are a
separate command. CPU-only subprocesses isolate model memory and rotate model
order across three rounds. No user records or product vector path are accessed.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import platform
import resource
import statistics
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import tokenizers
from tokenizers import Tokenizer


REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "scripts/fixtures/shoggoth-memory-p4-multilingual-v1.json"
FIXTURE_SHA = "e6a87b1e78a62e2ec3702b7860d3cd4985818db7f731e7b25b03615918516d39"
BASELINE = REPO / "scripts/fixtures/shoggoth-memory-evaluation-v1.json"
BASELINE_SHA = "a926172548441dd59f3aac6e5152590e3b8da2526f57de2631db64429ca745c6"
KEYS = ["minilm", "e5-small", "granite-97m-r2"]
PINNED = {
    "minilm": {
        "repo": "onnx-community/paraphrase-multilingual-MiniLM-L12-v2-ONNX",
        "revision": "d4c06bf0d7680171ac30042a1387e1fdb7a90021",
        "weight": "onnx/model_quantized.onnx",
        "weightSha": "0029fce9c82365d8a2bf20e03a476e84785a872d8d423c8bac0fd0f350df88dc",
        "vocabularySha256": "cad551d5600a84242d0973327029452a1e3672ba6313c2a3c3d69c4310e12719",
        "pooling": "mean", "queryPrefix": "", "passagePrefix": "", "maxTokens": 128,
    },
    "e5-small": {
        "repo": "intfloat/multilingual-e5-small",
        "revision": "614241f622f53c4eeff9890bdc4f31cfecc418b3",
        "weight": "onnx/model_qint8_avx512_vnni.onnx",
        "weightSha": "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88",
        "vocabularySha256": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
        "pooling": "mean", "queryPrefix": "query: ", "passagePrefix": "passage: ", "maxTokens": 512,
    },
    "granite-97m-r2": {
        "repo": "ibm-granite/granite-embedding-97m-multilingual-r2",
        "revision": "835ad14087e140460703cf0fae09f97d469d65c2",
        "weight": "onnx/model_quint8_avx2.onnx",
        "weightSha": "a6022dd8220ea6f6595562a1328ee216f4a94faa55362f2f4747c80f1e78772e",
        "vocabularySha256": "4f2842d568e2724370aec203652a42ac783c7937f8347a1a2cc7506d71f1582f",
        "pooling": "cls", "queryPrefix": "", "passagePrefix": "", "maxTokens": 512,
    },
}


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def frozen(path, expected):
    if sha(path) != expected:
        raise ValueError(f"Frozen file changed: {path.name}")
    return json.loads(path.read_text())


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def timings(values):
    return {"samples": len(values), "p50Ms": round(statistics.median(values), 4),
            "p95Ms": round(float(np.percentile(values, 95)), 4), "maxMs": round(max(values), 4)}


def score(samples, found):
    ranks = []
    for sample in samples:
        # Each authored query has one relevant record. Precision@5 therefore
        # has a maximum of 0.2; it is not an answer-correctness percentage.
        assert len(sample["relevant"]) == 1
        ids = found[sample["id"]][:5]
        relevant = sample["relevant"][0]
        ranks.append(ids.index(relevant) + 1 if relevant in ids else 0)
    return {"queries": len(samples), "hitsAt1": sum(rank == 1 for rank in ranks),
            "hitsAt5": sum(rank > 0 for rank in ranks),
            "recallAt1": round(sum(rank == 1 for rank in ranks) / len(ranks), 6),
            "recallAt5": round(sum(rank > 0 for rank in ranks) / len(ranks), 6),
            "mrrAt5": round(sum(1 / rank if rank else 0 for rank in ranks) / len(ranks), 6),
            "precisionAt5": round(sum(rank > 0 for rank in ranks) / len(ranks) / 5, 6)}


def rrf(lexical, semantic, corpus_ids):
    order = {key: position for position, key in enumerate(corpus_ids)}
    values = {}
    for ranked in [lexical[:5], semantic[:5]]:
        for rank, key in enumerate(ranked, 1):
            values[key] = values.get(key, 0) + 1 / (60 + rank)
    return sorted(values, key=lambda key: (-values[key], order[key]))[:5]


def verified_model(key, artifacts):
    config = PINNED[key]
    if key == "minilm":
        folder = REPO / ".artifacts/memory-p4-real-20260928/model"
        manifest = json.loads((folder.parent / "model-download-manifest.json").read_text())
    else:
        folder = artifacts / "models" / key
        manifest = json.loads((folder / "model-assets-manifest.json").read_text())
    if manifest["repo"] != config["repo"] or manifest["revision"] != config["revision"]:
        raise ValueError(f"Unexpected revision for {key}")
    names = {entry["name"]: entry for entry in manifest["files"]}
    if names[config["weight"]]["sha256"] != config["weightSha"]:
        raise ValueError(f"Unexpected pinned weight hash for {key}")
    if names["tokenizer.json"]["sha256"] != config["vocabularySha256"]:
        raise ValueError(f"Unexpected pinned tokenizer hash for {key}")
    for entry in manifest["files"]:
        file = folder / entry["name"]
        if file.stat().st_size != entry["bytes"] or sha(file) != entry["sha256"]:
            raise ValueError(f"Asset identity mismatch: {key}/{entry['name']}")
    if key != "minilm":
        pooling = json.loads((folder / "1_Pooling/config.json").read_text())
        enabled = {name for name, value in pooling.items() if name.startswith("pooling_mode_") and value}
        expected = {"pooling_mode_cls_token" if config["pooling"] == "cls" else "pooling_mode_mean_tokens"}
        if enabled != expected or pooling["word_embedding_dimension"] != 384:
            raise ValueError(f"Unexpected pooling contract for {key}")
    return folder, manifest


class Encoder:
    def __init__(self, key, folder):
        self.config = PINNED[key]
        raw = json.loads((folder / "tokenizer_config.json").read_text())
        self.tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        # All input lengths are checked before enabling truncation. This trial
        # does not compare long-context quality or extrapolate the 512 cap.
        token = raw["pad_token"]
        if isinstance(token, dict):
            token = token["content"]
        pad_id = self.tokenizer.token_to_id(token)
        if pad_id is None:
            raise ValueError("Tokenizer has no padding token")
        self.padding = {"token": token, "id": pad_id, "side": "right"}
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(folder / self.config["weight"]),
                                            sess_options=options, providers=["CPUExecutionProvider"])
        self.inputs = {item.name for item in self.session.get_inputs()}
        if not {"input_ids", "attention_mask"} <= self.inputs <= {"input_ids", "attention_mask", "token_type_ids"}:
            raise ValueError("Unexpected ONNX input contract")
        if "last_hidden_state" not in {item.name for item in self.session.get_outputs()}:
            raise ValueError("Missing token embedding output")

    def lengths(self, texts, query=False):
        prefix = self.config["queryPrefix" if query else "passagePrefix"]
        return [len(self.tokenizer.encode(prefix + text).ids) for text in texts]

    def configure_lengths(self):
        self.tokenizer.enable_truncation(max_length=self.config["maxTokens"])
        self.tokenizer.enable_padding(pad_id=self.padding["id"], pad_token=self.padding["token"], direction="right")

    def encode(self, texts, query=False):
        prefix = self.config["queryPrefix" if query else "passagePrefix"]
        encoded = self.tokenizer.encode_batch([prefix + text for text in texts])
        tensors = {"input_ids": np.asarray([row.ids for row in encoded], dtype=np.int64),
                   "attention_mask": np.asarray([row.attention_mask for row in encoded], dtype=np.int64),
                   "token_type_ids": np.asarray([row.type_ids for row in encoded], dtype=np.int64)}
        hidden = self.session.run(["last_hidden_state"], {key: tensors[key] for key in self.inputs})[0]
        if hidden.ndim != 3 or hidden.shape[-1] != 384:
            raise ValueError(f"Unexpected hidden output shape: {hidden.shape}")
        if self.config["pooling"] == "cls":
            pooled = hidden[:, 0, :]
        else:
            mask = tensors["attention_mask"][..., None].astype(np.float32)
            pooled = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1e-9)
        norms = np.linalg.norm(pooled, axis=1)
        if not np.isfinite(pooled).all() or (norms <= 0).any():
            raise ValueError("Non-finite or zero embedding")
        return (pooled / norms[:, None]).astype(np.float32)


def one_by_one(encoder, texts, query=False):
    return np.concatenate([encoder.encode([text], query=query) for text in texts])


def batch_build(encoder, texts):
    start = time.perf_counter()
    vectors = np.concatenate([encoder.encode(texts[index:index + 16]) for index in range(0, len(texts), 16)])
    return vectors, (time.perf_counter() - start) * 1000


def retrieval_rows(encoder, samples, corpora, corpus_ids, lexical):
    found, hybrid, rows = {}, {}, []
    for sample in samples:
        vector = encoder.encode([sample["query"]], query=True)[0]
        cosine = corpora[sample["corpusLanguage"]] @ vector
        indices = np.argsort(-cosine, kind="stable")[:5]
        ranked = [corpus_ids[int(index)] for index in indices]
        found[sample["id"]] = ranked
        fused = rrf(lexical[sample["id"]], ranked, corpus_ids)
        hybrid[sample["id"]] = fused
        rows.append({**sample, "lexical": lexical[sample["id"]], "semantic": ranked, "hybridRrf": fused,
                     "cosine": [round(float(cosine[index]), 6) for index in indices]})
    groups = dict.fromkeys(sample["group"] for sample in samples)
    metrics = {mode: {group: score([row for row in samples if row["group"] == group], ranking)
                      for group in groups} for mode, ranking in
               [("lexical", lexical), ("vector", found), ("hybridRrf", hybrid)]}
    for mode, ranking in [("lexical", lexical), ("vector", found), ("hybridRrf", hybrid)]:
        metrics[mode]["all"] = score(samples, ranking)
    return metrics, rows


def worker(args):
    data = frozen(FIXTURE, FIXTURE_SHA)
    baseline = frozen(BASELINE, BASELINE_SHA)
    folder, manifest = verified_model(args.worker, args.artifacts)
    started = time.perf_counter()
    encoder = Encoder(args.worker, folder)
    load_ms = (time.perf_counter() - started) * 1000
    corpora_text = {language: [row[language] for row in data["records"]] for language in ["zh", "en"]}
    all_passages = corpora_text["zh"] + corpora_text["en"] + [row["content"] for row in baseline["memoryItems"]]
    old_queries = [{**row, "group": group, "corpusLanguage": "baseline"}
                   for group in ["A", "B"] for row in baseline["memoryQueries"][group]]
    passage_lengths = encoder.lengths(all_passages)
    query_lengths = encoder.lengths([row["query"] for row in data["queries"] + old_queries], query=True)
    max_tokens = PINNED[args.worker]["maxTokens"]
    truncations = sum(length > max_tokens for length in passage_lengths + query_lengths)
    if truncations:
        raise ValueError("Short-text corpus unexpectedly truncates; stop the comparison")
    encoder.configure_lengths()
    # Warm inference, then keep quality encoding independent of batch neighbors.
    encoder.encode(["你好，世界。", "A short English sentence."])
    corpus_vectors = {language: one_by_one(encoder, texts) for language, texts in corpora_text.items()}
    corpus_vectors["mixed"] = np.stack([corpus_vectors["zh" if index % 2 == 0 else "en"][index]
                                        for index in range(len(data["records"]))])
    lex = json.loads((args.artifacts / "lexical-multilingual.json").read_text())
    metrics, rows = retrieval_rows(encoder, data["queries"], corpus_vectors,
                                   [row["id"] for row in data["records"]], lex["found"])
    old_lex = json.loads((args.artifacts / "lexical-baseline.json").read_text())
    old_found = {row["id"]: row["found"] for group in ["groupA", "groupB"] for row in old_lex[group]["rows"]}
    baseline_vectors = one_by_one(encoder, [row["content"] for row in baseline["memoryItems"]])
    old_metrics, old_rows = retrieval_rows(encoder, old_queries, {"baseline": baseline_vectors},
                                          [row["id"] for row in baseline["memoryItems"]], old_found)
    batch_ms, batch_consistency = {}, {}
    for language, texts in corpora_text.items():
        batched, elapsed = batch_build(encoder, texts)
        batch_ms[language] = round(elapsed, 4)
        similarities = np.sum(batched * corpus_vectors[language], axis=1)
        batch_consistency[language] = {"batchSize": 16, "minCosineToSingle": round(float(min(similarities)), 6),
                                        "medianCosineToSingle": round(float(np.median(similarities)), 6)}
    # Deterministic rotated query order avoids timing only easy first examples.
    elapsed, scans = [], []
    count = len(data["queries"])
    for iteration in range(args.iterations):
        offset = (args.round * 29 + iteration * 13) % count
        ordered = data["queries"][offset:] + data["queries"][:offset]
        for sample in ordered:
            started = time.perf_counter()
            vector = encoder.encode([sample["query"]], query=True)[0]
            scan_started = time.perf_counter()
            cosine = corpus_vectors[sample["corpusLanguage"]] @ vector
            np.argsort(-cosine, kind="stable")[:5]
            finished = time.perf_counter()
            scans.append((finished - scan_started) * 1000)
            elapsed.append((finished - started) * 1000)
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    report = {
        "key": args.worker, "round": args.round,
        "observedAtUtc": datetime.now(timezone.utc).isoformat(),
        "model": {**PINNED[args.worker], "license": manifest["license"], "dimensions": 384,
                  "assetBytes": sum(entry["bytes"] for entry in manifest["files"]),
                  "files": manifest["files"], "padding": encoder.padding, "normalization": "L2",
                  "selectedWeightIsQuantized": True, "cpuProviders": encoder.session.get_providers()},
        "encodingChecks": {"maxPassageTokens": max(passage_lengths), "maxQueryTokens": max(query_lengths),
                           "truncatedInputs": truncations, "batchToSingle": batch_consistency},
        "metrics": metrics, "rows": rows, "baselineMetrics": old_metrics, "baselineRows": old_rows,
        "cost": {"loadModelAndTokenizerMs": round(load_ms, 4), "batchBuild216VectorsMs": batch_ms,
                 "warmQueryIncluding216VectorScan": timings(elapsed), "scan216Vectors": timings(scans),
                 "raw216VectorBytes": int(corpus_vectors["zh"].nbytes),
                 "peakProcessRssMiB": round(rss / (1024 * 1024 if platform.system() == "Darwin" else 1024), 3)},
        "timingSamplesMs": elapsed, "scanSamplesMs": scans,
    }
    output = args.artifacts / f"{args.worker}-round-{args.round}.json"
    save(output, report)
    print(json.dumps({"key": args.worker, "round": args.round, "metrics": metrics["vector"]["all"],
                      "cost": report["cost"]}, ensure_ascii=False), flush=True)


def comparison(args):
    frozen(FIXTURE, FIXTURE_SHA)
    frozen(BASELINE, BASELINE_SHA)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    for file, script, extra in [("lexical-multilingual.json", "shoggoth-memory-p4-comparison-lexical.cjs", []),
                                ("lexical-baseline.json", "shoggoth-memory-evaluation.cjs", ["--check"])]:
        result = json.loads(subprocess.check_output(["node", str(REPO / "scripts" / script), *extra], cwd=REPO))
        save(args.artifacts / file, result)
    env = {**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "TOKENIZERS_PARALLELISM": "false"}
    orders = []
    for round_index in range(args.rounds):
        order = KEYS[round_index % len(KEYS):] + KEYS[:round_index % len(KEYS)]
        orders.append(order)
        for key in order:
            subprocess.run([sys.executable, str(Path(__file__).resolve()), "--artifacts", str(args.artifacts),
                            "--worker", key, "--round", str(round_index + 1), "--iterations", str(args.iterations)],
                           cwd=REPO, env=env, check=True)
    models = []
    for key in KEYS:
        runs = [json.loads((args.artifacts / f"{key}-round-{number}.json").read_text())
                for number in range(1, args.rounds + 1)]
        # Quantized inference must be reproducible under this fixed contract.
        if any(run["metrics"] != runs[0]["metrics"] or run["baselineMetrics"] != runs[0]["baselineMetrics"]
               or [(row["semantic"], row["hybridRrf"]) for row in run["rows"]]
               != [(row["semantic"], row["hybridRrf"]) for row in runs[0]["rows"]] for run in runs[1:]):
            raise ValueError(f"Ranking instability across process rounds: {key}")
        models.append({"key": key, "model": runs[0]["model"], "metrics": runs[0]["metrics"],
                       "baselineMetrics": runs[0]["baselineMetrics"], "encodingChecks": runs[0]["encodingChecks"],
                       "cost": {"loadMsMedian": round(statistics.median(run["cost"]["loadModelAndTokenizerMs"] for run in runs), 4),
                                "batchBuild216VectorsMsMedian": {language: round(statistics.median(run["cost"]["batchBuild216VectorsMs"][language] for run in runs), 4) for language in ["zh", "en"]},
                                "warmQueryIncluding216VectorScan": timings([value for run in runs for value in run["timingSamplesMs"]]),
                                "scan216Vectors": timings([value for run in runs for value in run["scanSamplesMs"]]),
                                "peakProcessRssMiBRange": [min(run["cost"]["peakProcessRssMiB"] for run in runs), max(run["cost"]["peakProcessRssMiB"] for run in runs)]},
                       "roundEvidence": [f"{key}-round-{number}.json" for number in range(1, args.rounds + 1)]})
    control = json.loads((args.artifacts / "lexical-baseline.json").read_text())["groupC"]
    summary = {"kind": "offline-pinned-three-model-synthetic-comparison", "status": "complete",
               "startedAtUtc": started, "completedAtUtc": datetime.now(timezone.utc).isoformat(),
               "environment": {"platform": platform.platform(), "machine": platform.machine(),
                               "python": platform.python_version(), "numpy": np.__version__,
                               "onnxruntime": ort.__version__, "tokenizers": tokenizers.__version__,
                               "provider": "CPUExecutionProvider", "intraThreads": 1, "interThreads": 1},
               "fixture": {"file": str(FIXTURE.relative_to(REPO)), "sha256": FIXTURE_SHA,
                           "recordsPerCorpus": 216, "semanticFamilies": 24, "queries": 216,
                           "crossLanguageCorporaExcludeQueryLanguage": True, "baselineSha256": BASELINE_SHA},
               "roundOrders": orders, "models": models,
               "lexicalConversationPolicyControl": {key: control[key] for key in
                    ["recallAt5", "forbiddenHits", "identityErrors", "forgottenGetDenied"]},
               "productVectorPathEnabled": False, "vectorAuthorizationIntegrationTested": False,
               "physicalIntelOrElectronPackagingTested": False,
               "limits": ["Authored synthetic short-text set: 24 families; translated and paraphrased queries are correlated",
                          "Selected quantized ONNX assets, not a full-precision MTEB rerun or representative user accuracy",
                          "Latency includes tokenize, inference, pooling, L2 and exact top5 of 216 vectors; excludes product IPC/policy/I/O",
                          "Peak RSS includes the isolated Python process, runtime, tokenizer and allocations; not App incremental memory",
                          "Initialization uses warmed filesystem caches after hash checks; not OS-cold first-launch timing",
                          "Granite test cap512 does not validate its published32768 maximum or long-text retrieval",
                          "Same 384 dimensions do not make different models' vectors interoperable"]}
    save(args.artifacts / "comparison-summary.json", summary)
    print(json.dumps({"output": str(args.artifacts / "comparison-summary.json"), "status": "complete",
                      "models": [{"key": item["key"], "vector": item["metrics"]["vector"]["all"],
                                  "hybridRrf": item["metrics"]["hybridRrf"]["all"], "cost": item["cost"]}
                                 for item in models]}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--iterations", type=int, default=1)
    parser.add_argument("--worker", choices=KEYS)
    parser.add_argument("--round", type=int, default=1)
    args = parser.parse_args()
    args.artifacts = args.artifacts.resolve()
    if not args.artifacts.is_relative_to(REPO / ".artifacts"):
        parser.error("Output must be under this repository's .artifacts")
    if not 1 <= args.rounds <= 6 or not 1 <= args.iterations <= 5:
        parser.error("Use 1..6 rounds and 1..5 iterations")
    (worker if args.worker else comparison)(args)


if __name__ == "__main__":
    main()
