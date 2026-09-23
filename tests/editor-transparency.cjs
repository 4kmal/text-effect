const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { targets } = require("./browser-targets.cjs");

const outputDir = path.join(os.tmpdir(), "textfx-export-qa");
fs.mkdirSync(outputDir, { recursive: true });
async function run(name) {
  const { browserType, options } = targets[name];
  const browser = await browserType.launch({ headless: true, ...options });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  await page.route("**/unpkg.com/react-grab/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  try {
    await page.goto("http://localhost:3000/editor", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Text treatments" }).waitFor();
    await page.waitForFunction(() =>
      Boolean(localStorage.getItem("rapidscreen-textfx-drafts-v1")),
    );
    const project = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("rapidscreen-textfx-drafts-v1"))[0]
          .project,
    );
    project.id = "qa-transparent";
    project.name = "QA transparent clip";
    project.width = 320;
    project.height = 180;
    project.durationMs = 1000;
    project.background = {
      kind: "transparent",
      color: "#000000",
      color2: "#000000",
      matteColor: "#00ff00",
    };
    project.layers = project.layers.slice(0, 1).map((layer) => ({
      ...layer,
      text: "FX",
      fontSize: 64,
      x: 160,
      y: 90,
      startMs: 0,
      endMs: 1000,
      keyframes: layer.keyframes.map((keyframe) => ({
        ...keyframe,
        x: 160,
        y: 90,
        timeMs: Math.min(keyframe.timeMs, 1000),
      })),
    }));
    await page.locator("input[type=file]").setInputFiles({
      name: "transparent.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page.waitForFunction(
      () => document.querySelector("canvas")?.width === 320,
    );
    const alpha = await page
      .locator("canvas")
      .first()
      .evaluate(
        (canvas) => canvas.getContext("2d").getImageData(0, 0, 1, 1).data[3],
      );
    assert.equal(alpha, 0, "transparent preview has an opaque corner");
    assert.ok(
      await page.getByLabel("MP4 matte color").isVisible(),
      "matte control is missing",
    );

    for (const format of ["mp4", "webm", "gif"]) {
      await page.getByLabel("Export format").selectOption(format);
      const downloadPromise = page.waitForEvent("download", {
        timeout: 120000,
      });
      await page.getByRole("button", { name: "Export", exact: true }).click();
      let download;
      try {
        download = await downloadPromise;
      } catch (error) {
        const alert = await page.getByRole("alert").allTextContents();
        console.log(
          `[${name}] transparent ${format} unavailable: ${alert.join(" | ") || error.message}`,
        );
        continue;
      }
      const file = path.join(outputDir, `${name}-transparent.${format}`);
      await download.saveAs(file);
      const pixel = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        file,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        "-",
      ]);
      if (format === "mp4") {
        assert.ok(
          pixel[1] > 150 && pixel[1] > pixel[0] * 2 && pixel[1] > pixel[2] * 2,
          "MP4 matte is not green",
        );
      } else if (format === "gif") {
        assert.equal(pixel[3], 0, "GIF corner lost transparency");
      } else {
        const videoPixel = await page.evaluate(async (base64) => {
          const bytes = Uint8Array.from(atob(base64), (letter) =>
            letter.charCodeAt(0),
          );
          const url = URL.createObjectURL(
            new Blob([bytes], { type: "video/webm" }),
          );
          const video = document.createElement("video");
          video.muted = true;
          video.src = url;
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("WebM load timeout")),
              10000,
            );
            video.onloadeddata = () => {
              clearTimeout(timeout);
              resolve();
            };
            video.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("WebM decode failed"));
            };
          });
          const canvas = document.createElement("canvas");
          canvas.width = 320;
          canvas.height = 180;
          const context = canvas.getContext("2d");
          context.drawImage(video, 0, 0);
          const result = [...context.getImageData(0, 0, 1, 1).data];
          URL.revokeObjectURL(url);
          return result;
        }, fs.readFileSync(file).toString("base64"));
        assert.equal(videoPixel[3], 0, "WebM playback lost transparency");
      }
      const tags =
        format === "webm"
          ? execFileSync(
              "ffprobe",
              [
                "-v",
                "error",
                "-show_entries",
                "stream_tags=alpha_mode",
                "-of",
                "json",
                file,
              ],
              { encoding: "utf8" },
            ).trim()
          : "";
      console.log(
        `[${name}] transparent ${format}: first pixel=${[...pixel.subarray(0, 4)]}${tags ? ` tags=${tags}` : ""}`,
      );
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const names = process.env.TEXTFX_BROWSER
    ? [process.env.TEXTFX_BROWSER]
    : Object.keys(targets);
  for (const name of names) await run(name);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
