#!/usr/bin/env swift
// Strictly local P4 probe: fixed synthetic fixture, installed NaturalLanguage assets only.
// No user memory, network request, model download, or product index is involved.

import CryptoKit
import Dispatch
import Foundation
import NaturalLanguage

private let fixtureSHA256 = "a926172548441dd59f3aac6e5152590e3b8da2526f57de2631db64429ca745c6"
private let language = NLLanguage.simplifiedChinese
#if arch(arm64)
private let architecture = "arm64"
#elseif arch(x86_64)
private let architecture = "x86_64"
#else
private let architecture = "unknown"
#endif

private struct Fixture: Decodable {
    struct Item: Decodable { let id: String; let content: String }
    struct Query: Decodable { let id: String; let query: String; let relevant: [String] }
    let version: Int
    let memoryItems: [Item]
    let memoryQueries: [String: [Query]]
}

private struct Baseline: Decodable {
    struct Group: Decodable {
        struct Row: Decodable { let id: String; let found: [String] }
        let recallAt5: Double
        let precisionAt5: Double
        let rows: [Row]
    }
    let groupA: Group
    let groupB: Group
}

private enum TrialError: Error, CustomStringConvertible {
    case invalid(String)
    var description: String {
        switch self { case .invalid(let message): return message }
    }
}

private func milliseconds(_ start: UInt64) -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
}

private func percentile(_ samples: [Double], _ fraction: Double) -> Double? {
    guard !samples.isEmpty else { return nil }
    let values = samples.sorted()
    return values[max(0, Int(ceil(Double(values.count) * fraction)) - 1)]
}

private func summary(_ samples: [Double]) -> [String: Any] {
    ["samples": samples.count,
     "p50Ms": percentile(samples, 0.5) ?? NSNull(),
     "p95Ms": percentile(samples, 0.95) ?? NSNull()]
}

private func repositoryURL() -> URL {
    let argument = CommandLine.arguments[0]
    let scriptURL = argument.hasPrefix("/")
        ? URL(fileURLWithPath: argument)
        : URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(argument)
    return scriptURL.standardizedFileURL.deletingLastPathComponent().deletingLastPathComponent()
}

private func readBaseline(repository: URL) throws -> Baseline {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", repository.appendingPathComponent("scripts/shoggoth-memory-evaluation.cjs").path]
    process.currentDirectoryURL = repository
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    try process.run()
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        let error = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        throw TrialError.invalid("Synthetic lexical evaluator failed: \(error)")
    }
    return try JSONDecoder().decode(Baseline.self, from: data)
}

private func unitVector(_ values: [Double], dimension: Int) throws -> (vector: [Double], norm: Double) {
    guard values.count == dimension, values.allSatisfy({ $0.isFinite }) else {
        throw TrialError.invalid("Embedding returned an invalid dimension or nonfinite value")
    }
    let norm = sqrt(values.reduce(0.0) { $0 + $1 * $1 })
    guard norm.isFinite && norm > 0 else { throw TrialError.invalid("Embedding returned a zero vector") }
    return (values.map { $0 / norm }, norm)
}

private func topFive(query: [Double], items: [(id: String, vector: [Double])]) -> [String] {
    var scored: [(id: String, score: Double)] = []
    for item in items {
        var similarity = 0.0
        for index in query.indices { similarity += query[index] * item.vector[index] }
        scored.append((id: item.id, score: similarity))
    }
    scored.sort { left, right in
        left.score == right.score ? left.id < right.id : left.score > right.score
    }
    return scored.prefix(5).map(\.id)
}

private func score(_ queries: [Fixture.Query], found: [String: [String]]) -> [String: Any] {
    var hits = 0
    var possible = 0
    var rows: [[String: Any]] = []
    for query in queries {
        let ids = found[query.id] ?? []
        let matched = query.relevant.filter { ids.contains($0) }
        hits += matched.count
        possible += query.relevant.count
        rows.append(["id": query.id, "found": ids, "hits": matched])
    }
    return ["recallAt5": possible == 0 ? NSNull() : Double(hits) / Double(possible),
            "precisionAt5": queries.isEmpty ? NSNull() : Double(hits) / Double(queries.count * 5),
            "rows": rows]
}

private func run() throws {
    guard CommandLine.arguments.count == 1 else {
        throw TrialError.invalid("No input overrides: this probe only accepts the frozen synthetic fixture")
    }
    let repository = repositoryURL()
    let fixtureData = try Data(contentsOf: repository.appendingPathComponent("scripts/fixtures/shoggoth-memory-evaluation-v1.json"))
    let digest = SHA256.hash(data: fixtureData).map { String(format: "%02x", $0) }.joined()
    guard digest == fixtureSHA256 else { throw TrialError.invalid("Frozen fixture SHA-256 mismatch") }
    let fixture = try JSONDecoder().decode(Fixture.self, from: fixtureData)
    guard fixture.version == 1, let a = fixture.memoryQueries["A"], let b = fixture.memoryQueries["B"] else {
        throw TrialError.invalid("Unexpected synthetic fixture schema")
    }
    let baseline = try readBaseline(repository: repository)
    let lexicalRows = baseline.groupA.rows + baseline.groupB.rows
    let lexical = Dictionary(uniqueKeysWithValues: lexicalRows.map { ($0.id, $0.found) })
    guard Set(lexical.keys) == Set((a + b).map(\.id)) else {
        throw TrialError.invalid("Lexical evaluator rows do not match the frozen fixture")
    }

    let revisions = Array(NLEmbedding.supportedSentenceEmbeddingRevisions(for: language))
    let currentRevision = NLEmbedding.currentSentenceEmbeddingRevision(for: language)
    let modelStart = DispatchTime.now().uptimeNanoseconds
    let model = NLEmbedding.sentenceEmbedding(for: language)
    let availabilityLookupMs = milliseconds(modelStart)
    let pinnedAvailable = currentRevision > 0
        && NLEmbedding.sentenceEmbedding(for: language, revision: currentRevision) != nil
    let wordModelAvailable = NLEmbedding.wordEmbedding(for: language) != nil
    var result: [String: Any] = [
        "kind": "apple-nlembedding-frozen-synthetic-p4-trial",
        "fixtureSHA256": fixtureSHA256,
        "language": language.rawValue,
        "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
        "architecture": architecture,
        "supportedSentenceRevisions": revisions,
        "currentSentenceRevision": currentRevision,
        "sentenceEmbeddingAvailable": model != nil,
        "pinnedCurrentRevisionAvailable": pinnedAvailable,
        "wordEmbeddingAvailable": wordModelAvailable,
        "englishSentenceEmbeddingAvailable": NLEmbedding.sentenceEmbedding(for: .english) != nil,
        "englishWordEmbeddingAvailable": NLEmbedding.wordEmbedding(for: .english) != nil,
        "availabilityLookupMs": availabilityLookupMs,
        "lexical": ["A": score(a, found: lexical), "B": score(b, found: lexical)],
        "modelFileBytes": NSNull(),
    ]
    guard let model else {
        result["status"] = "unavailable"
        result["reason"] = "The installed OS returned nil for Simplified Chinese sentenceEmbedding; supported revision metadata does not establish a usable local asset."
        result["dimension"] = NSNull()
        result["vectorOnly"] = NSNull()
        result["lexicalFirstHybrid"] = NSNull()
        try emit(result)
        return
    }

    let dimension = model.dimension
    guard dimension > 0 else { throw TrialError.invalid("Embedding dimension is zero") }
    var norms: [Double] = []
    var buildMs: [Double] = []
    var itemVectors: [(id: String, vector: [Double])] = []
    for item in fixture.memoryItems {
        let start = DispatchTime.now().uptimeNanoseconds
        guard let raw = model.vector(for: item.content) else {
            throw TrialError.invalid("Embedding returned nil for synthetic item \(item.id)")
        }
        let normalized = try unitVector(raw, dimension: dimension)
        buildMs.append(milliseconds(start))
        norms.append(normalized.norm)
        itemVectors.append((item.id, normalized.vector))
    }

    var vectorFound: [String: [String]] = [:]
    var hybridFound: [String: [String]] = [:]
    var queryMs: [Double] = []
    var rankingMs: [Double] = []
    for query in a + b {
        let start = DispatchTime.now().uptimeNanoseconds
        guard let raw = model.vector(for: query.query) else {
            throw TrialError.invalid("Embedding returned nil for synthetic query \(query.id)")
        }
        let normalized = try unitVector(raw, dimension: dimension)
        queryMs.append(milliseconds(start))
        norms.append(normalized.norm)
        let rankStart = DispatchTime.now().uptimeNanoseconds
        let ranked = topFive(query: normalized.vector, items: itemVectors)
        rankingMs.append(milliseconds(rankStart))
        vectorFound[query.id] = ranked
        // Predeclared candidate fusion: keep existing lexical top-5 order, then fill empty slots
        // from vector top-5. This protects exact lexical hits in the frozen A group.
        var merged = lexical[query.id] ?? []
        for id in ranked where merged.count < 5 && !merged.contains(id) { merged.append(id) }
        hybridFound[query.id] = merged
    }
    // Repeated warm inference is measured separately from the first query pass.
    var warmMs: [Double] = []
    for _ in 0..<20 {
        for query in a + b {
            let start = DispatchTime.now().uptimeNanoseconds
            guard model.vector(for: query.query) != nil else {
                throw TrialError.invalid("Warm inference returned nil")
            }
            warmMs.append(milliseconds(start))
        }
    }
    result["status"] = "measured"
    result["dimension"] = dimension
    result["modelRevision"] = model.revision
    result["modelLoadMs"] = availabilityLookupMs
    result["rawVectorNormRange"] = ["min": norms.min()!, "max": norms.max()!]
    result["normalization"] = "Cosine ranking uses explicit L2 normalization; raw vector norms are reported above."
    result["float32BytesFor15Items"] = fixture.memoryItems.count * dimension * MemoryLayout<Float>.size
    result["indexOnePass"] = summary(buildMs)
    result["indexOnePassTotalMs"] = buildMs.reduce(0, +)
    result["queryFirstPass"] = summary(queryMs)
    result["queryWarm20Passes"] = summary(warmMs)
    result["cosineRank15Items"] = summary(rankingMs)
    result["vectorOnly"] = ["A": score(a, found: vectorFound), "B": score(b, found: vectorFound)]
    result["lexicalFirstHybrid"] = ["A": score(a, found: hybridFound), "B": score(b, found: hybridFound)]
    try emit(result)
}

private func emit(_ result: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

do { try run() } catch {
    FileHandle.standardError.write(Data("P4 Apple embedding trial failed: \(error)\n".utf8))
    exit(1)
}
