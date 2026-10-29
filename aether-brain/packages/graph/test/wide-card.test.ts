import { describe, expect, it } from 'vitest'
import type { GraphData, GraphNode } from '@aether/core'
import { thumbTargets } from '../src/scene/thumbLayer'
import { WIDE_ASPECT } from '../src/scene/thumbs'
import { AUDIO_CARD_RADIUS, nodeRadius } from '../src/theme'

/** A song's waveform is a long horizontal card (docs/COSMOLOGY.md): the scene knows which cards are wide, and how big a song is. */

function image(id: string, extra: Record<string, unknown>): GraphNode {
  return { id, kind: 'image', title: id, degree: 0, image: { path: id.slice(6), size: 5_000_000, mtime: 1, ...extra } } as unknown as GraphNode
}
const graphOf = (nodes: GraphNode[]): GraphData => ({ nodes, links: [], index: new Map(nodes.map((n, i) => [n.id, i])) }) as unknown as GraphData

describe('wide cards', () => {
  it('marks the songs that have a waveform, and no other picture, as wide', () => {
    const t = thumbTargets(
      graphOf([
        image('image:a.png', {}),
        image('image:song.mp3', { file: 'audio', preview: 'audio' }),
        image('image:doc.pdf', { file: 'document', preview: 'pdf' }),
        image('image:rock.zip', { file: 'archive' }),
      ]),
    )
    // The zip has no picture at all; the others are listed in order, and only the song is wide.
    expect(Array.from(t.nodes)).toEqual([0, 1, 2])
    expect(Array.from(t.wide)).toEqual([0, 1, 0])
    expect(WIDE_ASPECT).toBe(3)
  })

  it('gives a song a card of one size whatever its file size, a picture\'s own size as before', () => {
    expect(nodeRadius(image('image:big.mp3', { file: 'audio', preview: 'audio', size: 90_000_000 }))).toBe(AUDIO_CARD_RADIUS)
    expect(nodeRadius(image('image:tiny.mp3', { file: 'audio', preview: 'audio', size: 10 }))).toBe(AUDIO_CARD_RADIUS)
    expect(nodeRadius(image('image:a.png', { size: 10 }))).not.toBe(AUDIO_CARD_RADIUS)
  })
})
