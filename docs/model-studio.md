# 3D Model Studio

Run `bun install` once, then `bun run modeler:dev` from the repository root and
open `http://localhost:3000/modeler`. The command starts Next.js and the
loopback FFmpeg helper used for ProRes MOV. If Next.js runs on another port,
start the helper with `MODELER_ALLOWED_ORIGINS` set to that page's exact origin.

The route is unlinked and marked `noindex`, but anyone with its URL can open it.
Projects, imported assets, and renders stay on the local machine. Named drafts
live in browser storage. **Save bundle** downloads a portable `.rsm` project
with its mesh binaries; the upload button beside it restores a bundle or a
project JSON file. New projects use the MPFB based Vitruvian V2 asset at
`public/modeler/vitruvian-v2.glb`, with editable source at
`assets/modeler/vitruvian-v2.blend`. The earlier
`public/modeler/vitruvian.glb` and `assets/modeler/vitruvian.blend` remain in
place for saved V1 drafts.

The V2 starter has two complete figures with separate 163-bone MPFB rigs, a
ring, and a shared 30-second 360° rotation. Select either figure to pose its
rig independently. Use the timeline to scrub, add transform or pose keys, and
preview the result. Mesh and Sculpt modes show the rig's rest pose while
editing. In Mesh mode, click a face, edge, or vertex;
Shift-click to add or remove from the selection. Remesh works on static meshes.
GLB includes the rig and animation, while OBJ is a static mesh for 3D software.

To rebuild the asset, install MPFB 2.0.17 from Blender's official extension
source, then run `scripts/modeler-asset/build_vitruvian_v2.py` in Blender 5.2.
Run `scripts/modeler-asset/validate_vitruvian_v2.py` to reimport the GLB and
check the two rigs, posed mesh deformation, alpha and spin. The generated
manifest, validation report, source details and CC0 asset provenance are in
`assets/modeler/vitruvian-v2.*`. The build uses MPFB's bundled base mesh;
MPFB program code is not bundled with the deployed studio.

Blender MCP runs separately from the web app. Install the official MCP for
Blender add-on, enable it in Blender's Add-ons preferences, and start its server
from the viewport's MCP panel on localhost port 9876. Register the STDIO bridge
with Codex using `uvx mcp-for-blender` and `BLENDER_MCP_SAFE_MODE=1`, then reload
Codex so the Blender tools appear. Query the open scene before making edits.

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
