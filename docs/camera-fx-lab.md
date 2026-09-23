# Camera FX Lab

Open `http://localhost:3000/camera` in Chrome or Edge after running `bun run dev`.
The route is unlinked from the homepage. On a deployed site, anyone with the URL
can open the tool; camera access still requires browser permission. Frames,
microphone audio, settings, and recordings are not uploaded by the lab.

## Record a take

1. Select **Start camera** and allow camera access. Allow microphone access to
   include sound; video-only recording remains available if the mic is denied.
2. Choose a camera, microphone, resolution, and effect stack. The live preview
   shows the same mirror setting and effects that the finished clip will use.
3. Select **Choose folder**. The lab writes two files there: an effected clip and
   a clean clip with matching framing and audio.
4. Select **Record**, change effects live if desired, then select **Stop**. Wait
   for both files to finish before closing the tab.

The default is 1920×1080 at a target of 30 fps. Switch to 1280×720 if the
camera cannot provide 1080p or the preview falls below 24 fps. Chrome and Edge
record H.264/AAC MP4 when available. If the browser cannot encode MP4, it saves
WebM files and offers a separate conversion action. The original WebM files are
kept if conversion fails.

The FLIR and Heat Vision presets imitate thermal imagery; a normal webcam does
not measure temperature. Pseudo Depth is an image-space effect, not distance
data from a depth sensor.

## Local data

Named looks are saved in browser storage as small versioned JSON projects. The
lab does not store camera device IDs, media, or folder permissions in those
projects. Recordings are saved directly to the chosen folder, with no in-app
video library. Keep the tab open while recording; a browser or system crash may
leave a take incomplete.
