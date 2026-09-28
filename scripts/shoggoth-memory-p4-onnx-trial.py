#!/usr/bin/env python3
"""Offline P4 trial on the SHA-frozen synthetic A/B corpus, never user data.

Prerequisites: numpy, onnxruntime and tokenizers. Download the pinned model
separately; this script has no network/download code or product vector path.
Fusion rules and the A/B gate are fixed before executing inference.
"""

import argparse
import hashlib
import json
import platform
import resource
import statistics
import subprocess
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "scripts/fixtures/shoggoth-memory-evaluation-v1.json"
FIXTURE_SHA = "a926172548441dd59f3aac6e5152590e3b8da2526f57de2631db64429ca745c6"
MODEL_REPO = "onnx-community/paraphrase-multilingual-MiniLM-L12-v2-ONNX"
MODEL_REVISION = "d4c06bf0d7680171ac30042a1387e1fdb7a90021"
MODEL_SHA = "0029fce9c82365d8a2bf20e03a476e84785a872d8d423c8bac0fd0f350df88dc"
VOCABULARY_SHA256 = "cad551d5600a84242d0973327029452a1e3672ba6313c2a3c3d69c4310e12719"
DIMENSIONS = 384
MAX_TOKENS = 128
RRF_K = 60


def check_file(path, expected):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected:
        raise ValueError(f"SHA-256 mismatch: {path.name}")
    return {"name": path.name, "bytes": path.stat().st_size, "sha256": digest}


def timing(values):
    return {
        "samples": len(values),
        "p50Ms": round(statistics.median(values), 4),
        "p95Ms": round(float(np.percentile(values, 95)), 4),
        "maxMs": round(max(values), 4),
    }


def score(samples, found):
    possible = sum(len(row["relevant"]) for row in samples)
    hits = sum(sum(item in found[row["id"]] for item in row["relevant"]) for row in samples)
    return {
        "queries": len(samples), "hits": hits, "possible": possible,
        "recallAt5": round(hits / possible, 4),
        "precisionAt5": round(sum(sum(item in found[row["id"]] for item in row["relevant"]) / 5
                                   for row in samples) / len(samples), 4),
    }


def rrf(lexical, semantic, corpus_ids):
    ranks = {item: index for index, item in enumerate(corpus_ids)}
    values = {}
    for results in [lexical, semantic]:
        for rank, item in enumerate(results, 1):
            values[item] = values.get(item, 0.0) + 1.0 / (RRF_K + rank)
    return sorted(values, key=lambda item: (-values[item], ranks[item]))[:5]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--provider", choices=["cpu", "coreml"], default="cpu")
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--profile", action="store_true", help="Profile node placement; adds measurement overhead")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.iterations <= 50:
        parser.error("--iterations must be between 1 and 50")

    fixture_info = check_file(FIXTURE, FIXTURE_SHA)
    model_info = check_file(args.model_dir / "onnx/model_quantized.onnx", MODEL_SHA)
    tokenizer_info = check_file(args.model_dir / "tokenizer.json", VOCABULARY_SHA256)
    fixture = json.loads(FIXTURE.read_text())
    corpus = fixture["memoryItems"]
    corpus_ids = [row["id"] for row in corpus]
    samples = fixture["memoryQueries"]["A"] + fixture["memoryQueries"]["B"]
    # Current real MemoryEngine + ConversationRecallService on the same frozen
    # fixture; group C remains a lexical-policy check, never a vector gate.
    lexical = json.loads(subprocess.check_output(
        ["node", "scripts/shoggoth-memory-evaluation.cjs", "--check"], cwd=REPO))
    lexical_found = {row["id"]: row["found"] for group in ["groupA", "groupB"]
                     for row in lexical[group]["rows"]}

    available = ort.get_available_providers()
    selected = ["CPUExecutionProvider"]
    if args.provider == "coreml":
        if "CoreMLExecutionProvider" not in available:
            raise ValueError("CoreMLExecutionProvider is unavailable")
        selected = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.log_severity_level = 3
    # Profiling exposes actual node placement. A listed CoreML provider alone
    # does not prove the graph ran on CoreML. Profiling overhead is reported.
    if args.profile:
        options.enable_profiling = True
        options.profile_file_prefix = str(args.output.with_suffix(".profile"))
    started = time.perf_counter()
    tokenizer = Tokenizer.from_file(str(args.model_dir / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=MAX_TOKENS)
    # This multilingual tokenizer uses <pad>=1; the converted Bert config's
    # pad_token_id=0 is not the tokenizer vocabulary contract.
    pad_id = tokenizer.token_to_id("<pad>")
    if pad_id != 1:
        raise ValueError("Unexpected pinned tokenizer padding contract")
    tokenizer.enable_padding(pad_id=pad_id, pad_token="<pad>", direction="right")
    session = ort.InferenceSession(str(args.model_dir / "onnx/model_quantized.onnx"),
                                  sess_options=options, providers=selected)
    load_ms = (time.perf_counter() - started) * 1000
    required = {item.name for item in session.get_inputs()}
    if not required <= {"input_ids", "attention_mask", "token_type_ids"}:
        raise ValueError("Unexpected model input contract")
    outputs = [item.name for item in session.get_outputs()]
    if "last_hidden_state" not in outputs:
        raise ValueError("Model must return token embeddings for masked mean pooling")

    def encode(texts):
        encoded = tokenizer.encode_batch(texts)
        tensors = {
            "input_ids": np.asarray([item.ids for item in encoded], dtype=np.int64),
            "attention_mask": np.asarray([item.attention_mask for item in encoded], dtype=np.int64),
            "token_type_ids": np.asarray([item.type_ids for item in encoded], dtype=np.int64),
        }
        hidden = session.run(["last_hidden_state"], {name: tensors[name] for name in required})[0]
        if hidden.ndim != 3 or hidden.shape[2] != DIMENSIONS:
            raise ValueError(f"Unexpected token embedding shape: {hidden.shape}")
        mask = tensors["attention_mask"][..., None].astype(np.float32)
        pooled = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1e-9)
        norms = np.linalg.norm(pooled, axis=1)
        if not np.isfinite(pooled).all() or (norms <= 0).any():
            raise ValueError("Invalid embedding or zero norm")
        normalized = (pooled / norms[:, None]).astype(np.float32)
        return normalized, norms

    started = time.perf_counter()
    corpus_vectors, corpus_norms = encode([item["content"] for item in corpus])
    build_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    query_vectors, query_norms = encode([row["query"] for row in samples])
    first_queries_ms = (time.perf_counter() - started) * 1000
    semantic, hybrid_rrf, hybrid_fill, rows = {}, {}, {}, []
    for sample, vector in zip(samples, query_vectors):
        cosine = corpus_vectors @ vector
        indices = np.argsort(-cosine, kind="stable")[:5]
        found = [corpus_ids[int(index)] for index in indices]
        current_lexical = lexical_found[sample["id"]]
        semantic[sample["id"]] = found
        hybrid_rrf[sample["id"]] = rrf(current_lexical, found, corpus_ids)
        hybrid_fill[sample["id"]] = list(dict.fromkeys(current_lexical + found))[:5]
        rows.append({
            "id": sample["id"], "query": sample["query"], "relevant": sample["relevant"],
            "lexical": current_lexical,
            "vector": [{"id": corpus_ids[int(index)], "cosine": round(float(cosine[index]), 6)}
                       for index in indices],
            "hybridRrf": hybrid_rrf[sample["id"]],
            "hybridLexicalFill": hybrid_fill[sample["id"]],
        })

    query_ms, scan_ms = [], []
    # Warm measurements include tokenization + real model inference + pooling
    # + normalization + exact top-5; they exclude authorization/product IPC.
    for _ in range(args.iterations):
        for sample in samples:
            started = time.perf_counter()
            vector, _norms = encode([sample["query"]])
            scan_started = time.perf_counter()
            cosine = corpus_vectors @ vector[0]
            np.argsort(-cosine, kind="stable")[:5]
            finished = time.perf_counter()
            scan_ms.append((finished - scan_started) * 1000)
            query_ms.append((finished - started) * 1000)

    placement = None
    if args.profile:
        profile = Path(session.end_profiling())
        placement = {}
        for event in json.loads(profile.read_text()):
            provider = event.get("args", {}).get("provider")
            if event.get("cat") == "Node" and provider:
                placement[provider] = placement.get(provider, 0) + 1
    metrics = {name: {group: score(fixture["memoryQueries"][group], found) for group in ["A", "B"]}
               for name, found in [("lexical", lexical_found), ("vector", semantic),
                                   ("hybridRrf", hybrid_rrf), ("hybridLexicalFill", hybrid_fill)]}
    gate = metrics["hybridRrf"]["A"]["hits"] == 8 and metrics["hybridRrf"]["B"]["hits"] >= 4
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    report = {
        "kind": "offline-frozen-synthetic-real-embedding-trial", "generatedAt": time.time(),
        "environment": {"platform": platform.platform(), "machine": platform.machine(),
                        "onnxruntime": ort.__version__, "numpy": np.__version__},
        "fixture": fixture_info,
        "model": {"repo": MODEL_REPO, "revision": MODEL_REVISION, "license": "Apache-2.0",
                  "model": model_info, "tokenizer": tokenizer_info, "dimensions": DIMENSIONS,
                  "maxTokens": MAX_TOKENS, "pooling": "attention-mask mean including special tokens",
                  "padding": {"token": "<pad>", "id": pad_id, "side": "right"},
                  "normalization": "explicit L2", "corpusRawNormRange": [float(min(corpus_norms)), float(max(corpus_norms))],
                  "queryRawNormRange": [float(min(query_norms)), float(max(query_norms))]},
        "provider": {"requested": args.provider, "available": available, "session": session.get_providers(),
                     "profiledNodeExecutions": placement, "profilingEnabled": args.profile},
        "fusion": {"rrf": {"k": RRF_K, "lexicalWeight": 1, "vectorWeight": 1,
                            "candidates": "lexical top-5 union vector top-5", "tieBreak": "frozen corpus order"},
                   "lexicalFill": "preserve lexical top-5 order and fill free slots with vector top-5"},
        "metrics": metrics, "rows": rows,
        "cost": {"loadModelAndTokenizerMs": round(load_ms, 4), "build15MemoryVectorsMs": round(build_ms, 4),
                 "first14QueriesBatchMs": round(first_queries_ms, 4), "warmSingleQueryEndToEnd": timing(query_ms),
                 "warm15VectorScan": timing(scan_ms), "rawVectorBytes": int(corpus_vectors.nbytes),
                 "peakProcessRssMiB": round(rss / (1024 * 1024 if platform.system() == "Darwin" else 1024), 3)},
        "decision": {"predeclaredSyntheticGate": "RRF A=8/8 and B>=4/6", "syntheticGatePassed": gate,
                     "productVectorPathEnabled": False, "vectorAuthorizationIntegrationTested": False,
                     "physicalIntelOrElectronPackagingTested": False},
        "lexicalConversationPolicyControl": {key: lexical["groupC"][key]
                                             for key in ["recallAt5", "forbiddenHits", "identityErrors", "forgottenGetDenied"]},
        "limits": ["15 synthetic memories and 14 queries are not representative user-corpus accuracy",
                   "Timings exclude product authorization, journal I/O, SQLite, IPC and large-index retrieval",
                   "This trial does not test vector deletion, permission filtering, app packaging or Intel hardware",
                   "A CoreML provider list is not proof of CoreML node execution; use profiling counts"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "metrics": metrics, "provider": report["provider"],
                      "cost": report["cost"], "decision": report["decision"]}, ensure_ascii=False, indent=2))
    if args.check and not gate:
        raise SystemExit("Synthetic hybrid gate failed; keep the product lexical path")


if __name__ == "__main__":
    main()
