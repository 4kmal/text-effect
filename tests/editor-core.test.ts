import { describe, expect, test } from 'bun:test'

import { createPreset, parseProject } from '../components/editor/core/model'
import { frameValuesAt } from '../components/editor/core/render'

describe('Text FX project', () => {
  test('a preset survives a JSON round trip and remains independently editable', () => {
    const original = createPreset('glitch')
    const imported = parseProject(JSON.stringify(original))

    expect(imported).toEqual(original)
    imported.layers[0].text = 'CHANGED'
    imported.layers[0].keyframes[0].x = 42
    expect(original.layers[0].text).toBe('RAW DATA')
    expect(original.layers[0].keyframes[0].x).not.toBe(42)
  })

  test('rejects unknown versions and invalid dimensions', () => {
    const project = createPreset('wave')
    expect(() => parseProject({ ...project, version: 2 })).toThrow(/version/)
    expect(() => parseProject({ ...project, width: 0 })).toThrow(/canvas/)
    expect(() => parseProject({ ...project, durationMs: 30_001 })).toThrow(/durationMs/)
  })

  test('interpolates editable layer values and honours step easing', () => {
    const layer = createPreset('wave').layers[0]
    layer.keyframes = [
      {
        x: 100,
        y: 200,
        scale: 1,
        rotation: 0,
        opacity: 0,
        intensity: 0,
        timeMs: 0,
        easing: 'linear',
      },
      {
        x: 300,
        y: 400,
        scale: 2,
        rotation: 90,
        opacity: 1,
        intensity: 1,
        timeMs: 1000,
        easing: 'linear',
      },
    ]

    expect(frameValuesAt(layer, 500)).toEqual({
      x: 200,
      y: 300,
      scale: 1.5,
      rotation: 45,
      opacity: 0.5,
      intensity: 0.5,
    })

    layer.keyframes[0].easing = 'step'
    expect(frameValuesAt(layer, 500).x).toBe(100)
    expect(frameValuesAt(layer, 1000).x).toBe(300)
  })
})
