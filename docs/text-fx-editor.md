# Text FX Studio

Run `bun install --frozen-lockfile` and `bun run dev`, then open
`http://localhost:3000/editor`. The route is unlinked from the homepage. Anyone
with its URL can reach it on a deployed site.

Projects are versioned JSON. The editor autosaves named drafts in browser local
storage and can import or download a project JSON file. Nothing is sent to an
account or database. Media export runs in the browser: Mediabunny uses native
codecs when supported, ffmpeg.wasm handles other MP4/WebM cases, and gifenc
handles GIF. The bundled ffmpeg core is single-threaded and large exports can
take several minutes.

Transparent WebM works where the browser encoder supports alpha. GIF uses
one-bit transparency. MP4 flattens transparent pixels over the editable matte
color. The bundled ffmpeg VP9 alpha fallback failed in local Playwright WebKit
testing, so transparent WebM is unavailable there; transparent GIF and matte
MP4 worked. Real Safari still needs a device check.

## Verification

With the dev server running:

```text
bun test tests/editor-core.test.ts tests/editor-render.test.ts
node tests/editor-browser.cjs
node tests/editor-export.cjs
node tests/editor-transparency.cjs
node tests/editor-cancel.cjs
node tests/editor-presets.cjs
node tests/editor-stress.cjs
```

The browser scripts use desktop Chrome, Firefox, and local Playwright WebKit.
They write screenshots and downloaded media to the OS temporary directory.
`editor-stress.cjs` exports 1920×1080, 30-second MP4 clips and can take minutes
on the ffmpeg fallback. Video and GIF probes require `ffprobe` and `ffmpeg` on
`PATH`.
