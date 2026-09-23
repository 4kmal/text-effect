const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { targets } = require("./browser-targets.cjs");

const outputDir = path.join(os.tmpdir(), "textfx-export-qa");
fs.mkdirSync(outputDir, { recursive: true });
async function openEditor(name) {
  const { browserType, options } = targets[name];
  const browser = await browserType.launch({
    headless: true,
    timeout: 15000,
    ...options,
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  await page.route("**/unpkg.com/react-grab/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  await page.goto("http://localhost:3000/editor", {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page
    .getByRole("heading", { name: "Text treatments" })
    .waitFor({ timeout: 20000 });
  return { browser, page };
}

async function importProject(page, project) {
  await page.locator("input[type=file]").setInputFiles({
    name: "qa-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.waitForFunction(
    ([width, height]) => {
      const canvas = document.querySelector("canvas");
      return canvas?.width === width && canvas?.height === height;
    },
    [project.width, project.height],
    { timeout: 10000 },
  );
}

function smallProject(project) {
  const copy = structuredClone(project);
  copy.id = "qa-short";
  copy.name = "QA short clip";
  copy.width = 320;
  copy.height = 180;
  copy.durationMs = 1000;
  copy.background = {
    kind: "solid",
    color: "#080808",
    color2: "#080808",
    matteColor: "#00ff00",
  };
  copy.layers = copy.layers.slice(0, 1).map((layer) => ({
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
  return copy;
}

function probeFile(file, preview, expectedFormat) {
  const metadata = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,codec_name,pix_fmt:format=duration",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    ),
  );
  const video = metadata.streams.find(
    (stream) => stream.width && stream.height,
  );
  assert.ok(video, `${expectedFormat} has no video stream`);
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  if (expectedFormat === "gif") assert.equal(video.nb_frames, "15");
  assert.equal(
    expectedFormat === "gif" ? video.r_frame_rate : video.avg_frame_rate,
    expectedFormat === "gif" ? "15/1" : "30/1",
  );
  assert.ok(
    Number(metadata.format.duration) > 0.85,
    `${expectedFormat} duration is too short`,
  );
  assert.ok(
    Number(metadata.format.duration) < 1.2,
    `${expectedFormat} duration is too long`,
  );
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], {
    encoding: "utf8",
  });
  const comparison = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "info",
      "-i",
      preview,
      "-i",
      file,
      "-filter_complex",
      "[1:v]trim=end_frame=1,setpts=PTS-STARTPTS[first];[0:v][first]psnr",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    comparison.status,
    0,
    `${expectedFormat} frame comparison failed`,
  );
  const match = /average:(inf|[\d.]+)/.exec(comparison.stderr);
  assert.ok(match, `${expectedFormat} did not report frame similarity`);
  const psnr = match[1] === "inf" ? Infinity : Number(match[1]);
  assert.ok(psnr > 20, `${expectedFormat} preview/export mismatch: ${psnr} dB`);
  return {
    codec: video.codec_name,
    fps: expectedFormat === "gif" ? video.r_frame_rate : video.avg_frame_rate,
    duration: metadata.format.duration,
    psnr,
  };
}

async function testBrowser(name) {
  console.log(`[${name}] opening editor`);
  const { browser, page } = await openEditor(name);
  try {
    await page.waitForFunction(
      () => Boolean(localStorage.getItem("rapidscreen-textfx-drafts-v1")),
      null,
      { timeout: 10000 },
    );
    const original = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("rapidscreen-textfx-drafts-v1"))?.[0]
          ?.project,
    );
    assert.ok(original, "initial draft not saved");
    await importProject(page, smallProject(original));
    await page.waitForTimeout(100);
    const preview = await page
      .locator("canvas")
      .first()
      .evaluate((canvas) => canvas.toDataURL("image/png"));
    fs.writeFileSync(
      path.join(outputDir, `${name}-preview.png`),
      Buffer.from(preview.split(",")[1], "base64"),
    );

    for (const format of ["mp4", "webm", "gif"]) {
      console.log(`[${name}] exporting ${format}`);
      await page.getByLabel("Export format").selectOption(format);
      const downloadPromise = page.waitForEvent("download", {
        timeout: 180000,
      });
      await page.getByRole("button", { name: "Export", exact: true }).click();
      let download;
      try {
        download = await downloadPromise;
      } catch (error) {
        const alert = await page.getByRole("alert").allTextContents();
        throw new Error(
          `${name} ${format} did not download: ${alert.join(" | ") || error.message}`,
        );
      }
      const file = path.join(outputDir, `${name}-short.${format}`);
      await download.saveAs(file);
      const metadata = probeFile(
        file,
        path.join(outputDir, `${name}-preview.png`),
        format,
      );
      console.log(`[${name}] ${format}: ${JSON.stringify(metadata)}`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const names = process.env.TEXTFX_BROWSER
    ? [process.env.TEXTFX_BROWSER]
    : ["chrome", "firefox", "webkit"];
  for (const name of names) await testBrowser(name);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
