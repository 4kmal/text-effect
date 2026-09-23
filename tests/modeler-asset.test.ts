import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

type GltfJson = {
  nodes?: Array<{ name?: string; rotation?: number[]; children?: number[] }>
  scenes?: Array<{ nodes?: number[] }>
  scene?: number
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
    const nodeNames = (json.nodes ?? [])
      .map((node) => node.name)
      .filter((name): name is string => typeof name === 'string')
    const requiredBones = [
      'arm-left-upper', 'arm-left-lower', 'arm-right-upper', 'arm-right-lower',
      'arm-left-upper-2', 'arm-left-lower-2', 'arm-right-upper-2', 'arm-right-lower-2',
      'leg-left-upper', 'leg-left-lower', 'leg-right-upper', 'leg-right-lower',
      'leg-left-upper-2', 'leg-left-lower-2', 'leg-right-upper-2', 'leg-right-lower-2',
    ]

    expect(nodeNames).toContain('vitruvian-ring')
    expect(nodeNames).toContain('root')
    expect(nodeNames).toContain('spine')
    for (const bone of requiredBones) expect(nodeNames).toContain(bone)
    expect(nodeNames.filter((name) => requiredBones.includes(name))).toHaveLength(requiredBones.length)
    expect(json.skins?.[0]?.joints?.length).toBeGreaterThanOrEqual(18)

    // The asset is authored in Blender's review orientation, then exported
    // with the inverse axis conversion on the scene root so Three.js receives
    // Y-up geometry. Keep this guard beside the bone-name contract.
    const assetRoot = json.nodes?.find((node) => node.name === 'VitruvianAsset')
    expect(assetRoot?.rotation?.[0]).toBeCloseTo(Math.SQRT1_2, 5)
    expect(assetRoot?.rotation?.[1]).toBeCloseTo(0, 5)
    expect(assetRoot?.rotation?.[2]).toBeCloseTo(0, 5)
    expect(assetRoot?.rotation?.[3]).toBeCloseTo(Math.SQRT1_2, 5)

    const assetRootIndex = json.nodes?.findIndex((node) => node.name === 'VitruvianAsset') ?? -1
    const runtimeOrientationIndex = json.nodes?.findIndex((node) => node.name === 'VitruvianRuntimeOrientation') ?? -1
    const runtimeOrientation = runtimeOrientationIndex < 0 ? undefined : json.nodes?.[runtimeOrientationIndex]
    expect(runtimeOrientationIndex).toBeGreaterThanOrEqual(0)
    expect(runtimeOrientation?.rotation?.[0]).toBeCloseTo(0, 5)
    expect(runtimeOrientation?.rotation?.[1]).toBeCloseTo(0, 5)
    expect(runtimeOrientation?.rotation?.[2]).toBeCloseTo(1, 5)
    expect(runtimeOrientation?.rotation?.[3]).toBeCloseTo(0, 5)
    expect(runtimeOrientation?.children).toContain(assetRootIndex)
    expect(json.scenes?.[json.scene ?? 0]?.nodes).toContain(runtimeOrientationIndex)

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

  test('loads head-up in the Three.js runtime coordinate system', async () => {
    const bytes = readFileSync(resolve('public/modeler/vitruvian.glb'))
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const gltf = await new GLTFLoader().parseAsync(data, '')
    const body = gltf.scene.getObjectByName('MakeHumanBody')
    const foot = gltf.scene.getObjectByName('mesh-leg-left-foot-sole')
    if (!body || !foot) throw new Error('The exported GLB is missing the body or foot mesh.')

    const bodyCenter = new THREE.Box3().setFromObject(body).getCenter(new THREE.Vector3())
    const footCenter = new THREE.Box3().setFromObject(foot).getCenter(new THREE.Vector3())
    expect(bodyCenter.y).toBeGreaterThan(0)
    expect(footCenter.y).toBeLessThan(0)
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
    expect(JSON.stringify(manifest)).not.toMatch(/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/)
  })
})
