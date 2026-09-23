export type EffectKind =
  | 'scramble'
  | 'typewriter'
  | 'ascii'
  | 'led'
  | 'wave'
  | 'glitch'

export type FontId = 'departure' | 'geist' | 'press-start'

export type BackgroundKind = 'solid' | 'gradient' | 'pattern' | 'transparent'

export type Easing = 'linear' | 'easeInOut' | 'step'

export type FrameValues = {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
  intensity: number
}

export type Keyframe = FrameValues & {
  timeMs: number
  easing: Easing
}

export type TextLayer = FrameValues & {
  id: string
  name: string
  text: string
  font: FontId
  fontSize: number
  color: string
  align: 'left' | 'center' | 'right'
  startMs: number
  endMs: number
  visible: boolean
  effect: EffectKind
  keyframes: Keyframe[]
}

export type TextFxProject = {
  version: 1
  id: string
  name: string
  width: number
  height: number
  durationMs: number
  seed: number
  background: {
    kind: BackgroundKind
    color: string
    color2: string
    matteColor: string
  }
  layers: TextLayer[]
}

export type PresetDefinition = {
  id: EffectKind
  label: string
  description: string
}

export const FONT_FAMILIES: Record<FontId, string> = {
  departure: "'Departure Mono', monospace",
  geist: "'Geist Mono', monospace",
  'press-start': "'Press Start 2P', monospace",
}

export const PRESETS: PresetDefinition[] = [
  {
    id: 'scramble',
    label: 'Signal scramble',
    description: 'Reveal a message through a deterministic stream of glyphs.',
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    description: 'Type each character into place with a crisp cursor.',
  },
  {
    id: 'ascii',
    label: 'ASCII raster',
    description: 'Turn the text silhouette into a living character grid.',
  },
  {
    id: 'led',
    label: 'LED marquee',
    description: 'Scroll a message through a warm dot matrix.',
  },
  {
    id: 'wave',
    label: 'Wave',
    description: 'Bend each character through a steady signal wave.',
  },
  {
    id: 'glitch',
    label: 'RGB glitch',
    description: 'Split the channels and break the signal with scan lines.',
  },
]

const EFFECTS: EffectKind[] = [
  'scramble',
  'typewriter',
  'ascii',
  'led',
  'wave',
  'glitch',
]

const EASINGS: Easing[] = ['linear', 'easeInOut', 'step']
const FONTS: FontId[] = ['departure', 'geist', 'press-start']
const BACKGROUNDS: BackgroundKind[] = [
  'solid',
  'gradient',
  'pattern',
  'transparent',
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && values.includes(value as T)

const required = (record: Record<string, unknown>, key: string, path: string): unknown => {
  if (!(key in record)) {
    throw new Error(`Invalid Text FX project: missing ${path}.${key}`)
  }
  return record[key]
}

const numberField = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): number => {
  const value = required(record, key, path)
  if (!isFiniteNumber(value)) {
    throw new Error(`Invalid Text FX project: ${path}.${key} must be a finite number`)
  }
  return value
}

const stringField = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): string => {
  const value = required(record, key, path)
  if (!isString(value)) {
    throw new Error(`Invalid Text FX project: ${path}.${key} must be a string`)
  }
  return value
}

const frameValues = (record: Record<string, unknown>, path: string): FrameValues => ({
  x: numberField(record, 'x', path),
  y: numberField(record, 'y', path),
  scale: numberField(record, 'scale', path),
  rotation: numberField(record, 'rotation', path),
  opacity: numberField(record, 'opacity', path),
  intensity: numberField(record, 'intensity', path),
})

const parseKeyframe = (input: unknown, path: string): Keyframe => {
  if (!isRecord(input)) {
    throw new Error(`Invalid Text FX project: ${path} must be an object`)
  }

  const values = frameValues(input, path)
  const timeMs = numberField(input, 'timeMs', path)
  const easing = required(input, 'easing', path)
  if (!isOneOf(EASINGS, easing)) {
    throw new Error(
      `Invalid Text FX project: ${path}.easing must be linear, easeInOut, or step`,
    )
  }

  return { ...values, timeMs, easing }
}

const parseLayer = (input: unknown, index: number): TextLayer => {
  const path = `layers[${index}]`
  if (!isRecord(input)) {
    throw new Error(`Invalid Text FX project: ${path} must be an object`)
  }

  const values = frameValues(input, path)
  const id = stringField(input, 'id', path)
  const name = stringField(input, 'name', path)
  const text = stringField(input, 'text', path)
  const font = required(input, 'font', path)
  const fontSize = numberField(input, 'fontSize', path)
  const color = stringField(input, 'color', path)
  const align = required(input, 'align', path)
  const startMs = numberField(input, 'startMs', path)
  const endMs = numberField(input, 'endMs', path)
  const visible = required(input, 'visible', path)
  const effect = required(input, 'effect', path)
  const keyframesInput = required(input, 'keyframes', path)

  if (!isOneOf(FONTS, font)) {
    throw new Error(`Invalid Text FX project: ${path}.font is not supported`)
  }
  if (!(fontSize > 0)) {
    throw new Error(`Invalid Text FX project: ${path}.fontSize must be greater than zero`)
  }
  if (!isOneOf(['left', 'center', 'right'] as const, align)) {
    throw new Error(`Invalid Text FX project: ${path}.align must be left, center, or right`)
  }
  if (!(startMs >= 0 && endMs > startMs)) {
    throw new Error(`Invalid Text FX project: ${path}.startMs and endMs are out of order`)
  }
  if (typeof visible !== 'boolean') {
    throw new Error(`Invalid Text FX project: ${path}.visible must be a boolean`)
  }
  if (!isOneOf(EFFECTS, effect)) {
    throw new Error(`Invalid Text FX project: ${path}.effect is not supported`)
  }
  if (!Array.isArray(keyframesInput)) {
    throw new Error(`Invalid Text FX project: ${path}.keyframes must be an array`)
  }

  return {
    ...values,
    id,
    name,
    text,
    font,
    fontSize,
    color,
    align,
    startMs,
    endMs,
    visible,
    effect,
    keyframes: keyframesInput.map((keyframe, keyframeIndex) =>
      parseKeyframe(keyframe, `${path}.keyframes[${keyframeIndex}]`),
    ),
  }
}

const cloneProject = (project: TextFxProject): TextFxProject => ({
  ...project,
  background: { ...project.background },
  layers: project.layers.map((layer) => ({
    ...layer,
    keyframes: layer.keyframes.map((keyframe) => ({ ...keyframe })),
  })),
})

export function createBlankProject(): TextFxProject {
  return {
    version: 1,
    id: 'textfx-project',
    name: 'Untitled composition',
    width: 1920,
    height: 1080,
    durationMs: 8000,
    seed: 7301,
    background: {
      kind: 'solid',
      color: '#080808',
      color2: '#1a1a1a',
      matteColor: '#080808',
    },
    layers: [],
  }
}

type PresetSettings = {
  text: string
  font: FontId
  fontSize: number
  color: string
  background: TextFxProject['background']
  intensity: number
  seed: number
}

const PRESET_SETTINGS: Record<EffectKind, PresetSettings> = {
  scramble: {
    text: 'EXECUTE',
    font: 'departure',
    fontSize: 150,
    color: '#ff5a1f',
    background: {
      kind: 'solid',
      color: '#090909',
      color2: '#090909',
      matteColor: '#090909',
    },
    intensity: 0.9,
    seed: 101,
  },
  typewriter: {
    text: 'MAKE IT MOVE',
    font: 'geist',
    fontSize: 112,
    color: '#f2f0ea',
    background: {
      kind: 'gradient',
      color: '#18120f',
      color2: '#050505',
      matteColor: '#050505',
    },
    intensity: 0.8,
    seed: 211,
  },
  ascii: {
    text: 'ASCII SIGNAL',
    font: 'departure',
    fontSize: 128,
    color: '#ffa12f',
    background: {
      kind: 'pattern',
      color: '#080808',
      color2: '#171717',
      matteColor: '#080808',
    },
    intensity: 0.75,
    seed: 307,
  },
  led: {
    text: 'RAPIDSCREEN // TEXT LAB',
    font: 'geist',
    fontSize: 92,
    color: '#ffb000',
    background: {
      kind: 'solid',
      color: '#070707',
      color2: '#070707',
      matteColor: '#070707',
    },
    intensity: 0.85,
    seed: 401,
  },
  wave: {
    text: 'SIGNAL IN MOTION',
    font: 'press-start',
    fontSize: 74,
    color: '#f2f0ea',
    background: {
      kind: 'transparent',
      color: '#000000',
      color2: '#000000',
      matteColor: '#000000',
    },
    intensity: 0.7,
    seed: 503,
  },
  glitch: {
    text: 'RAW DATA',
    font: 'departure',
    fontSize: 168,
    color: '#f2f0ea',
    background: {
      kind: 'gradient',
      color: '#13090c',
      color2: '#050509',
      matteColor: '#050509',
    },
    intensity: 0.9,
    seed: 601,
  },
}

const layerForPreset = (effect: EffectKind, project: TextFxProject): TextLayer => {
  const settings = PRESET_SETTINGS[effect]
  const { width, height, durationMs } = project
  const values: FrameValues = {
    x: width / 2,
    y: height / 2,
    scale: 1,
    rotation: 0,
    opacity: 1,
    intensity: settings.intensity,
  }

  return {
    ...values,
    id: `layer-${effect}`,
    name: PRESETS.find((preset) => preset.id === effect)?.label ?? effect,
    text: settings.text,
    font: settings.font,
    fontSize: settings.fontSize,
    color: settings.color,
    align: 'center',
    startMs: 0,
    endMs: durationMs,
    visible: true,
    effect,
    keyframes: [
      {
        ...values,
        opacity: effect === 'typewriter' || effect === 'scramble' ? 0.1 : 1,
        timeMs: 0,
        easing: 'easeInOut',
      },
      {
        ...values,
        timeMs: durationMs,
        easing: 'easeInOut',
      },
    ],
  }
}

export function createPreset(id: EffectKind | 'blank'): TextFxProject {
  if (id === 'blank') {
    return createBlankProject()
  }
  if (!isOneOf(EFFECTS, id)) {
    throw new Error(`Unknown Text FX preset: ${String(id)}`)
  }

  const settings = PRESET_SETTINGS[id]
  const project = createBlankProject()
  project.id = `preset-${id}`
  project.name = PRESETS.find((preset) => preset.id === id)?.label ?? id
  project.seed = settings.seed
  project.background = { ...settings.background }
  project.layers = [layerForPreset(id, project)]
  return project
}

export function parseProject(input: unknown): TextFxProject {
  let candidate: unknown = input
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      throw new Error('Invalid Text FX project: input is not valid JSON')
    }
  }

  if (!isRecord(candidate)) {
    throw new Error('Invalid Text FX project: expected a project object or JSON string')
  }

  const version = required(candidate, 'version', 'project')
  if (version !== 1) {
    throw new Error(`Invalid Text FX project: unsupported version ${String(version)}`)
  }

  const id = stringField(candidate, 'id', 'project')
  const name = stringField(candidate, 'name', 'project')
  const width = numberField(candidate, 'width', 'project')
  const height = numberField(candidate, 'height', 'project')
  const durationMs = numberField(candidate, 'durationMs', 'project')
  const seed = numberField(candidate, 'seed', 'project')
  const backgroundInput = required(candidate, 'background', 'project')
  const layersInput = required(candidate, 'layers', 'project')

  if (!(width > 0 && height > 0)) {
    throw new Error('Invalid Text FX project: width and height must be greater than zero')
  }
  if (!(durationMs > 0 && durationMs <= 30_000)) {
    throw new Error('Invalid Text FX project: durationMs must be between 1 and 30000')
  }
  if (!isRecord(backgroundInput)) {
    throw new Error('Invalid Text FX project: background must be an object')
  }
  const backgroundKind = required(backgroundInput, 'kind', 'project.background')
  if (!isOneOf(BACKGROUNDS, backgroundKind)) {
    throw new Error('Invalid Text FX project: background.kind is not supported')
  }
  if (!Array.isArray(layersInput)) {
    throw new Error('Invalid Text FX project: layers must be an array')
  }

  return cloneProject({
    version: 1,
    id,
    name,
    width,
    height,
    durationMs,
    seed,
    background: {
      kind: backgroundKind,
      color: stringField(backgroundInput, 'color', 'project.background'),
      color2: stringField(backgroundInput, 'color2', 'project.background'),
      matteColor: stringField(backgroundInput, 'matteColor', 'project.background'),
    },
    layers: layersInput.map((layer, index) => parseLayer(layer, index)),
  })
}
