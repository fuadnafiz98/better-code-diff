import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

private let canvasSize = 1024
private let artworkInset: CGFloat = 44
private let cornerRadius: CGFloat = 210

guard CommandLine.arguments.count == 3 else {
  FileHandle.standardError.write(Data("Usage: render-macos-icon.swift <source.png> <destination.png>\n".utf8))
  exit(2)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let destinationURL = URL(fileURLWithPath: CommandLine.arguments[2])

guard
  let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
  let sourceImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  FileHandle.standardError.write(Data("Could not read the source icon.\n".utf8))
  exit(1)
}

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
guard let context = CGContext(
  data: nil,
  width: canvasSize,
  height: canvasSize,
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
  FileHandle.standardError.write(Data("Could not create the icon canvas.\n".utf8))
  exit(1)
}

context.interpolationQuality = .high
context.clear(CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize))

let artworkRect = CGRect(
  x: artworkInset,
  y: artworkInset,
  width: CGFloat(canvasSize) - artworkInset * 2,
  height: CGFloat(canvasSize) - artworkInset * 2
)
let artworkShape = CGPath(
  roundedRect: artworkRect,
  cornerWidth: cornerRadius,
  cornerHeight: cornerRadius,
  transform: nil
)

context.saveGState()
context.setShadow(
  offset: CGSize(width: 0, height: -12),
  blur: 24,
  color: NSColor.black.withAlphaComponent(0.42).cgColor
)
context.addPath(artworkShape)
context.setFillColor(NSColor.black.cgColor)
context.fillPath()
context.restoreGState()

context.saveGState()
context.addPath(artworkShape)
context.clip()
context.draw(sourceImage, in: artworkRect)
context.restoreGState()

guard
  let iconImage = context.makeImage(),
  let destination = CGImageDestinationCreateWithURL(
    destinationURL as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
  )
else {
  FileHandle.standardError.write(Data("Could not create the destination icon.\n".utf8))
  exit(1)
}

CGImageDestinationAddImage(destination, iconImage, nil)
guard CGImageDestinationFinalize(destination) else {
  FileHandle.standardError.write(Data("Could not write the destination icon.\n".utf8))
  exit(1)
}
