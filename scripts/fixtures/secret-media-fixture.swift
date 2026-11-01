import AppKit
import PDFKit
import Foundation
let output = CommandLine.arguments[1]
let image = NSImage(size: NSSize(width: 1200, height: 400))
image.lockFocus()
NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1200, height: 400).fill()
let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 36, weight: .regular), .foregroundColor: NSColor.black]
("Public receipt: operation completed" as NSString).draw(at: NSPoint(x: 35, y: 300), withAttributes: attributes)
("Password: 123456" as NSString).draw(at: NSPoint(x: 35, y: 200), withAttributes: attributes)
("Order number: 7654321" as NSString).draw(at: NSPoint(x: 35, y: 100), withAttributes: attributes)
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output + "/fixture.png"))
let pdf = PDFDocument(); pdf.insert(PDFPage(image: image)!, at: 0)
try pdf.dataRepresentation()!.write(to: URL(fileURLWithPath: output + "/fixture.pdf"))
