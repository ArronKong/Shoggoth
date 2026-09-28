#!/usr/bin/env python3
"""Synthetic exact-vector scan cost only; never reads or embeds user content."""

import argparse
import json
import platform
import statistics
import time

import numpy as np


def percentile(values, fraction):
    ordered = sorted(values)
    return round(ordered[max(0, int(np.ceil(len(ordered) * fraction)) - 1)], 3)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=110_000)
    parser.add_argument("--dimensions", type=int, default=384)
    parser.add_argument("--iterations", type=int, default=20)
    args = parser.parse_args()
    if not 0 < args.rows <= 1_000_000 or not 0 < args.dimensions <= 4_096 or not 0 < args.iterations <= 1_000:
        parser.error("rows, dimensions and iterations must be bounded positive integers")

    rng = np.random.default_rng(27)
    build_start = time.perf_counter()
    vectors = rng.standard_normal((args.rows, args.dimensions), dtype=np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    query = rng.standard_normal(args.dimensions, dtype=np.float32)
    query /= np.linalg.norm(query)
    build_ms = (time.perf_counter() - build_start) * 1_000

    elapsed = []
    for _ in range(args.iterations):
        start = time.perf_counter()
        scores = vectors @ query
        positions = np.argpartition(scores, -5)[-5:]
        positions = positions[np.argsort(scores[positions])[::-1]]
        assert len(positions) == 5
        elapsed.append((time.perf_counter() - start) * 1_000)

    print(json.dumps({
        "kind": "synthetic-exact-vector-scan-only",
        "hardware": platform.processor() or platform.machine(),
        "platform": platform.platform(),
        "numpy": np.__version__,
        "rows": args.rows,
        "dimensions": args.dimensions,
        "dtype": "float32",
        "rawVectorBytes": vectors.nbytes,
        "rawVectorMiB": round(vectors.nbytes / (1024 ** 2), 3),
        "syntheticBuildMs": round(build_ms, 3),
        "iterations": args.iterations,
        "queryMs": {
            "min": round(min(elapsed), 3),
            "p50": round(statistics.median(elapsed), 3),
            "p95": percentile(elapsed, 0.95),
            "max": round(max(elapsed), 3),
        },
        "note": "Excludes tokenization, model inference, event eligibility, index serialization, and hybrid ranking.",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
