import type { FileImagePreview, ImagePreviewSide } from './contracts.js'

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

function extensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = slash === -1 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function imageMimeType(path: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[extensionOf(path)] ?? null
}

export function isImagePath(path: string): boolean {
  return imageMimeType(path) != null
}

export function hasImagePreview(
  image: FileImagePreview | null | undefined
): image is FileImagePreview {
  return image != null && (image.old != null || image.new != null)
}

export function imagePreviewCacheKey(image: FileImagePreview): string {
  return `image:${sideCacheKey(image.old)}:${sideCacheKey(image.new)}`
}

function sideCacheKey(side: ImagePreviewSide | null): string {
  if (side == null) return '0'
  return `${side.byteLength}:${side.dataUrl.length}:${side.dataUrl.slice(-24)}`
}

export function createImagePreviewSide(
  path: string,
  contents: Buffer,
  binary: boolean
): ImagePreviewSide | null {
  if (contents.byteLength === 0) return null
  const mimeType = imageMimeType(path)
  if (mimeType == null) return null
  // SVG that is actually XML stays a text diff. A binary SVG still previews.
  if (mimeType === 'image/svg+xml' && !binary) return null
  return {
    mimeType,
    dataUrl: `data:${mimeType};base64,${contents.toString('base64')}`,
    byteLength: contents.byteLength
  }
}
