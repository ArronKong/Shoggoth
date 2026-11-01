// Local-only attachment inspection. Input/output use inherited pipes; raw OCR
// and frames are never written to a temporary file or sent to a network service.
import Foundation
import Vision
import PDFKit
import AppKit
import AVFoundation
import Speech
import ImageIO

enum Failure: String, Error { case invalid = "SECRET_MEDIA_INVALID", unavailable = "SECRET_MEDIA_UNAVAILABLE", capacity = "SECRET_MEDIA_CAPACITY", speech = "SECRET_MEDIA_SPEECH_UNAVAILABLE" }
struct Block: Codable { let text: String; let confidence: Float; let box: [Double] }
struct Page { let image: CGImage; let blocks: [Block] }
func line(_ object: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func input() throws -> [String: Any] {
    guard let text = readLine(), text.utf8.count <= 72 * 1024 * 1024,
          let data = text.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.invalid }
    return value
}
func inspect(_ image: CGImage) throws -> Page {
    guard image.width > 0, image.height > 0, image.width * image.height <= 32_000_000 else { throw Failure.capacity }
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let supported = try request.supportedRecognitionLanguages()
    request.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant"].filter { supported.contains($0) }
    try VNImageRequestHandler(cgImage: image).perform([request])
    let blocks = (request.results ?? []).compactMap { observation -> Block? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let r = observation.boundingBox
        return Block(text: candidate.string, confidence: candidate.confidence, box: [r.minX, r.minY, r.width, r.height])
    }
    guard blocks.count <= 4096 else { throw Failure.capacity }
    return Page(image: image, blocks: blocks)
}
func rasterPDF(_ page: PDFPage) throws -> CGImage {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { throw Failure.invalid }
    let scale = min(2, 3000 / max(bounds.width, bounds.height))
    guard let context = CGContext(data: nil, width: Int(ceil(bounds.width * scale)), height: Int(ceil(bounds.height * scale)), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Failure.invalid }
    context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: context.width, height: context.height))
    context.scaleBy(x: scale, y: scale); context.translateBy(x: -bounds.minX, y: -bounds.minY)
    page.draw(with: .mediaBox, to: context)
    guard let image = context.makeImage() else { throw Failure.invalid }; return image
}
func speech(_ url: URL, locale: String) throws -> String {
    // Never ask for network fallback. Authorization is requested by the app's
    // explicit local-transcription control, not as a side effect of a tool call.
    guard SFSpeechRecognizer.authorizationStatus() == .authorized,
          let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
          recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else { throw Failure.speech }
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.requiresOnDeviceRecognition = true; request.shouldReportPartialResults = false
    var result: String?; var failed = false
    let task = recognizer.recognitionTask(with: request) { response, error in
        if let response, response.isFinal { result = response.bestTranscription.formattedString }
        if error != nil { failed = true }
    }
    defer { task.cancel() }
    let deadline = Date().addingTimeInterval(90)
    while result == nil && !failed && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.025)) }
    guard let result, !failed else { throw Failure.speech }; return result
}
func masked(_ page: Page, indices: [Int]) throws -> CGImage {
    guard let context = CGContext(data: nil, width: page.image.width, height: page.image.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Failure.invalid }
    context.draw(page.image, in: CGRect(x: 0, y: 0, width: context.width, height: context.height))
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    for index in indices {
        guard page.blocks.indices.contains(index) else { throw Failure.invalid }
        let b = page.blocks[index].box
        // Cover the entire recognized line, with padding for glyph overhangs.
        let rect = CGRect(x: b[0] * Double(context.width), y: b[1] * Double(context.height), width: b[2] * Double(context.width), height: b[3] * Double(context.height)).insetBy(dx: -8, dy: -8)
        context.fill(rect)
    }
    guard let image = context.makeImage() else { throw Failure.invalid }; return image
}
func main() throws {
    let request = try input()
    if request["action"] as? String == "requestSpeechPermission" {
        var finished = false
        SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async { finished = true } }
        let deadline = Date().addingTimeInterval(110)
        while !finished && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.025)) }
        guard finished else { throw Failure.speech }
    }
    if ["capabilities", "requestSpeechPermission"].contains(request["action"] as? String ?? "") {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        let status: String
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: status = "authorized"
        case .denied: status = "denied"
        case .restricted: status = "restricted"
        case .notDetermined: status = "not-determined"
        @unknown default: status = "unavailable"
        }
        try line(["version": 1, "ocr": true, "speechAuthorized": SFSpeechRecognizer.authorizationStatus() == .authorized,
                  "speechOnDevice": recognizer?.supportsOnDeviceRecognition == true, "speechStatus": status]); return
    }
    guard request["version"] as? Int == 1, let mime = request["mimeType"] as? String else { throw Failure.invalid }
    let inline = (request["data"] as? String).flatMap { Data(base64Encoded: $0) }
    let source = request["path"] as? String
    guard (inline != nil) != (source != nil), source == nil || source!.hasPrefix("/"),
          inline == nil || inline!.count <= 50 * 1024 * 1024 else { throw Failure.invalid }
    let url = source.map { URL(fileURLWithPath: $0) }
    var pages: [Page] = []; var transcript = ""
    if mime == "application/pdf" {
        guard let document = inline.flatMap({ PDFDocument(data: $0) }) ?? url.flatMap({ PDFDocument(url: $0) }), !document.isLocked, document.pageCount > 0,
              document.pageCount <= 64 else { throw Failure.capacity }
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { throw Failure.invalid }
            pages.append(try inspect(rasterPDF(page)))
        }
    } else if mime.hasPrefix("image/") {
        guard let source = inline.flatMap({ CGImageSourceCreateWithData($0 as CFData, nil) })
            ?? url.flatMap({ CGImageSourceCreateWithURL($0 as CFURL, nil) }) else { throw Failure.invalid }
        let count = CGImageSourceGetCount(source)
        guard count > 0, count <= 64 else { throw Failure.capacity }
        for index in 0..<count {
            // Apply EXIF orientation before OCR and discard all source metadata.
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 4096]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else { throw Failure.invalid }
            pages.append(try inspect(image))
        }
    } else if mime.hasPrefix("audio/") || mime.hasPrefix("video/") {
        guard let url else { throw Failure.invalid }
        transcript = try speech(url, locale: request["locale"] as? String ?? "en-US")
        if mime.hasPrefix("video/") {
            let asset = AVURLAsset(url: url)
            let duration = CMTimeGetSeconds(asset.duration)
            guard duration.isFinite, duration > 0, duration <= 300 else { throw Failure.capacity }
            let generator = AVAssetImageGenerator(asset: asset); generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 1920, height: 1920)
            // Video bytes never leave this helper. OCR samples enrich the safe
            // text transcript; they are not a claim of frame-complete masking.
            for second in stride(from: 0, to: duration, by: 2) {
                let image = try generator.copyCGImage(at: CMTime(seconds: second, preferredTimescale: 600), actualTime: nil)
                let page = try inspect(image)
                transcript += "\n[Video \(Int(second))s] " + page.blocks.map(\.text).joined(separator: "\n")
            }
        }
    } else { throw Failure.invalid }
    let records = try pages.map { page -> [[String: Any]] in
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(page.blocks)) as! [[String: Any]]
    }
    try line(["version": 1, "pages": records, "transcript": transcript])
    let projection = try input()
    guard let masks = projection["masks"] as? [[Int]], masks.count == pages.count else { throw Failure.invalid }
    if pages.isEmpty { try line(["version": 1, "mimeType": "text/plain", "data": ""]); return }
    let images = try pages.enumerated().map { try masked($0.element, indices: masks[$0.offset]) }
    let data: Data; let outputMime: String
    if images.count == 1 && mime.hasPrefix("image/") {
        let bitmap = NSBitmapImageRep(cgImage: images[0])
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw Failure.invalid }
        data = png; outputMime = "image/png"
    } else {
        let pdf = PDFDocument()
        for (index, image) in images.enumerated() {
            guard let page = PDFPage(image: NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))) else { throw Failure.invalid }
            pdf.insert(page, at: index)
        }
        guard let output = pdf.dataRepresentation() else { throw Failure.invalid }
        data = output; outputMime = "application/pdf"
    }
    guard data.count <= 50 * 1024 * 1024 else { throw Failure.capacity }
    try line(["version": 1, "mimeType": outputMime, "data": data.base64EncodedString()])
}
do { try main() } catch {
    try? line(["errorCode": (error as? Failure)?.rawValue ?? Failure.unavailable.rawValue]); exit(1)
}
