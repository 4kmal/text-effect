const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { targets } = require("./browser-targets.cjs");

const origin = "http://localhost:3000";

async function openCameraBrowser(
  name,
  {
    fakeDevices = true,
    permissions = ["camera", "microphone"],
    mockFolderPicker = true,
    forceWebM = false,
    failEffectedWrite = false,
    headless = true,
    staticVideo = false,
  } = {},
) {
  const { browserType, options } = targets[name];
  const browser = await browserType.launch({
    headless,
    timeout: 20000,
    ...options,
    args: fakeDevices ? ["--use-fake-device-for-media-stream"] : [],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 950 },
    acceptDownloads: true,
  });
  if (permissions !== null) {
    await context.grantPermissions(permissions, { origin });
  }
  const page = await context.newPage();
  if (staticVideo) {
    await page.addInitScript(() => {
      const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (!constraints.video) return nativeGetUserMedia(constraints);
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Static camera canvas unavailable");
        const draw = () => {
          const gradient = context.createLinearGradient(0, 0, 1280, 720);
          gradient.addColorStop(0, "#101d34");
          gradient.addColorStop(0.5, "#f08b39");
          gradient.addColorStop(1, "#eef2ff");
          context.fillStyle = gradient;
          context.fillRect(0, 0, 1280, 720);
          context.fillStyle = "#080808";
          context.fillRect(170, 140, 270, 450);
          context.fillStyle = "#00d6ca";
          context.fillRect(750, 170, 310, 310);
          context.fillStyle = "#ffffff";
          context.fillRect(800, 250, 75, 75);
        };
        draw();
        window.__staticCameraTimer = setInterval(draw, 33);
        return canvas.captureStream(30);
      };
    });
  }
  if (forceWebM) {
    await page.addInitScript(() => {
      const supports = MediaRecorder.isTypeSupported.bind(MediaRecorder);
      MediaRecorder.isTypeSupported = (mimeType) =>
        !mimeType.startsWith("video/mp4") && supports(mimeType);
    });
  }
  if (mockFolderPicker) {
    await page.addInitScript((shouldFailEffectedWrite) => {
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          return {
            name: "Camera QA captures",
            kind: "directory",
            getFileHandle: async (name, options) => {
              const handle = await root.getFileHandle(name, options);
              if (!shouldFailEffectedWrite || !name.includes("effected")) {
                return handle;
              }
              return {
                name: handle.name,
                kind: "file",
                getFile: handle.getFile.bind(handle),
                createWritable: async () => {
                  const writable = await handle.createWritable();
                  return {
                    write: async () => {
                      throw new Error("Simulated effected file write failure");
                    },
                    close: writable.close.bind(writable),
                    abort: writable.abort.bind(writable),
                  };
                },
              };
            },
          };
        },
      });
    }, failEffectedWrite);
  }
  await page.route("**/unpkg.com/react-grab/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  await page.goto(`${origin}/camera`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  return { browser, context, page };
}

async function savedFileNames(page) {
  return page.evaluate(async () => {
    const names = [];
    const directory = await navigator.storage.getDirectory();
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "file") names.push(name);
    }
    return names.sort();
  });
}

async function saveRecordedFile(page, name, destination) {
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.evaluate(async (filename) => {
    const directory = await navigator.storage.getDirectory();
    const file = await (await directory.getFileHandle(filename)).getFile();
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }, name);
  const download = await downloadPromise;
  await download.saveAs(destination);
}

function probeMedia(filename) {
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "stream=codec_name,codec_type,width,height,avg_frame_rate,nb_read_frames:format=duration",
        "-of",
        "json",
        filename,
      ],
      { encoding: "utf8" },
    ),
  );
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  assert.ok(video, `${filename} has no video track`);
  let duration = Number(probe.format.duration);
  if (!Number.isFinite(duration)) {
    const packets = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_packets",
        "-show_entries",
        "packet=pts_time,duration_time",
        "-of",
        "csv=p=0",
        filename,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    duration = Math.max(
      0,
      ...packets
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const [timestamp, packetDuration] = line.split(",").map(Number);
          return (
            timestamp + (Number.isFinite(packetDuration) ? packetDuration : 0)
          );
        })
        .filter(Number.isFinite),
    );
  }
  return {
    video,
    audio: probe.streams.find((stream) => stream.codec_type === "audio"),
    duration,
    decodedFrames: Number(video.nb_read_frames),
  };
}

module.exports = {
  openCameraBrowser,
  savedFileNames,
  saveRecordedFile,
  probeMedia,
};
