import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type GltfJson = {
  nodes?: Array<{ name?: string }>
  skins?: Array<{ joints?: number[] }>
  animations?: Array<{
    name?: string
    samplers: Array<{ input: number }>
    channels: Array<{ target?: { node?: number; path?: string } }>
  }>
  accessors?: Array<{ bufferView?: number; byteOffset?: number; count?: number; componentType?: number; type?: string }>
  bufferViews?: Array<{ byteOffset?: number; byteLength?: number }>
}

function readGlb(): { json: GltfJson; binary: Buffer } {
  const bytes = readFileSync(resolve('public/modeler/vitruvian.glb'))
  expect(bytes.subarray(0, 4).toString()).toBe('glTF')
  expect(bytes.readUInt32LE(4)).toBe(2)

  const jsonLength = bytes.readUInt32LE(12)
  const jsonStart = 20
  const json = JSON.parse(bytes.subarray(jsonStart, jsonStart + jsonLength).toString()) as GltfJson
  const binaryHeader = jsonStart + jsonLength
  const binaryLength = bytes.readUInt32LE(binaryHeader)
  const binaryStart = binaryHeader + 8
  return { json, binary: bytes.subarray(binaryStart, binaryStart + binaryLength) }
}

describe('RapidScreen Vitruvian starter asset', () => {
  test('exports the named ring, rig controls, and 360 degree animation', () => {
    const { json, binary } = readGlb()
    const nodeNames = (json.nodes ?? []).map((node) => node.name).filter(Boolean)
    const requiredBones = [
      'arm-left-upper', 'arm-left-lower', 'arm-right-upper', 'arm-right-lower',
      'arm-left-upper-2', 'arm-left-lower-2', 'arm-right-upper-2', 'arm-right-lower-2',
      'leg-left-upper', 'leg-left-lower', 'leg-right-upper', 'leg-right-lower',
      'leg-left-upper-2', 'leg-left-lower-2', 'leg-right-upper-2', 'leg-right-lower-2',
    ]

    expect(nodeNames).toContain('vitruvian-ring')
    for (const bone of requiredBones) expect(nodeNames).toContain(bone)
    expect(json.skins?.[0]?.joints?.length).toBeGreaterThanOrEqual(17)

    const animation = json.animations?.find((candidate) => candidate.name === 'Vitruvian 360 Spin')
    expect(animation).toBeDefined()
    expect(animation?.channels.some((channel) => channel.target?.path === 'rotation')).toBe(true)

    const inputAccessorIndex = animation?.samplers[0]?.input
    const inputAccessor = inputAccessorIndex === undefined ? undefined : json.accessors?.[inputAccessorIndex]
    expect(inputAccessor?.count).toBeGreaterThanOrEqual(5)
    expect(inputAccessor?.componentType).toBe(5126)
    expect(inputAccessor?.type).toBe('SCALAR')

    const inputView = inputAccessor?.bufferView === undefined ? undefined : json.bufferViews?.[inputAccessor.bufferView]
    const inputOffset = (inputView?.byteOffset ?? 0) + (inputAccessor?.byteOffset ?? 0)
    const times = Array.from({ length: inputAccessor?.count ?? 0 }, (_, index) => binary.readFloatLE(inputOffset + index * 4))
    expect(times[0]).toBeCloseTo(1 / 60, 4)
    expect(times.at(-1)).toBeCloseTo(4)
  })

  test('keeps the editable project manifest separate from the GLB payload', () => {
    const manifest = JSON.parse(readFileSync(resolve('assets/modeler/vitruvian-neon.manifest.json'), 'utf8')) as {
      schema: string
      files: { glb: string; blender: string }
      source: { license: string; referenceImage: string }
    }
    expect(manifest.schema).toBe('rapidscreen.model-project.v1')
    expect(manifest.files.glb).toBe('/modeler/vitruvian.glb')
    expect(manifest.files.blender).toBe('assets/modeler/vitruvian.blend')
    expect(manifest.source.license).toBe('CC0 1.0')
    expect(manifest.source.referenceImage).toBe('kept outside deployed public assets')
  })
})
