# 3D Model Studio

Run `bun install` once, then `bun run modeler:dev` from the repository root and
open `http://localhost:3000/modeler`. The command starts Next.js and the
loopback FFmpeg helper used for ProRes MOV. If Next.js runs on another port,
start the helper with `MODELER_ALLOWED_ORIGINS` set to that page's exact origin.

The route is unlinked and marked `noindex`, but anyone with its URL can open it.
Projects, imported assets, and renders stay on the local machine. Named drafts
live in browser storage. **Save bundle** downloads a portable `.rsm` project
with its mesh binaries; the upload button beside it restores a bundle or a
project JSON file. The editable Blender source is
`assets/modeler/vitruvian.blend`, and the starter GLB is
`public/modeler/vitruvian.glb`.

The starter project has a 30-second 360° rotation. Use the timeline to scrub,
add transform or pose keys, and preview the result. Mesh and Sculpt modes show
the rig's rest pose while editing. In Mesh mode, click a face, edge, or vertex;
Shift-click to add or remove from the selection. Remesh works on static meshes.
GLB includes the rig and animation, while OBJ is a static mesh for 3D software.

For video editing, export transparent WebM or ProRes 4444 MOV, a transparent PNG
frame sequence, or opaque MP4 with a chosen matte colour. MOV requires the local
helper and a native FFmpeg executable. The browser's save picker writes PNG
frames as a ZIP; all formats show progress and can be canceled. Large 1080p
renders can take time and may exhaust browser resources. Keep an `.rsm` bundle
as a backup of important work.

MOV and WebM alpha are checked by decoding exported files, but Filmora 15.1.2
transparency import remains unverified until both formats can be tried on a
Filmora timeline over a coloured background. Do not treat either format as
Filmora compatible until that check passes.
