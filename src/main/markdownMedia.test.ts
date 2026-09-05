import { describe, expect, test } from 'bun:test'

import { loadMarkdownMedia, MAX_MARKDOWN_MEDIA_BYTES } from './markdownMedia.js'

describe('loadMarkdownMedia', () => {
  test('rejects hosts outside GitHub', async () => {
    await expect(loadMarkdownMedia('https://example.com/clip.webm', fetch, async () => null))
      .rejects.toThrow('Only GitHub-hosted videos can be previewed.')
  })

  test('returns the downloaded bytes and a video mime type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetchImpl = async (): Promise<Response> => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'video/webm' }
    })

    await expect(loadMarkdownMedia(
      'https://github.com/user-attachments/assets/clip.webm',
      fetchImpl,
      async () => 'token'
    )).resolves.toEqual({ mimeType: 'video/webm', bytes })
  })

  test('falls back to the extension when GitHub omits a useful content type', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(new Uint8Array([9]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    })

    const media = await loadMarkdownMedia(
      'https://github.com/user-attachments/assets/demo.mp4',
      fetchImpl,
      async () => null
    )
    expect(media.mimeType).toBe('video/mp4')
  })

  test('rejects an oversized download', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(
      new Uint8Array(MAX_MARKDOWN_MEDIA_BYTES + 1),
      {
        status: 200,
        headers: { 'content-type': 'video/mp4' }
      }
    )

    await expect(loadMarkdownMedia(
      'https://github.com/user-attachments/assets/huge.mp4',
      fetchImpl,
      async () => null
    )).rejects.toThrow('too large')
  })
})
