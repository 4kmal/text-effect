const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { targets } = require("./browser-targets.cjs");
const outputDir = path.join(os.tmpdir(), "textfx-export-qa");
fs.mkdirSync(outputDir, { recursive: true });

async function run(name) {
  const { browserType, options } = targets[name];
  console.log(`[${name}] starting 1920x1080 / 30s MP4 stress export`);
  const browser = await browserType.launch({
    headless: true,
    timeout: 20000,
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
  let progressTimer;
  try {
    await page.goto("http://localhost:3000/editor", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page
      .getByRole("heading", { name: "Text treatments" })
      .waitFor({ timeout: 30000 });
    await page.waitForFunction(() =>
      Boolean(localStorage.getItem("rapidscreen-textfx-drafts-v1")),
    );
    const project = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("rapidscreen-textfx-drafts-v1"))[0]
          .project,
    );
    project.id = `qa-stress-${name}`;
    project.name = "QA stress clip";
    project.width = 1920;
    project.height = 1080;
    project.durationMs = 30000;
    project.background = {
      kind: "solid",
      color: "#080808",
      color2: "#080808",
      matteColor: "#080808",
    };
    project.layers = project.layers.slice(0, 1).map((layer) => ({
      ...layer,
      effect: "typewriter",
      text: "RAPIDSCREEN",
      fontSize: 150,
      x: 960,
      y: 540,
      startMs: 0,
      endMs: 30000,
      keyframes: layer.keyframes.map((keyframe) => ({
        ...keyframe,
        x: 960,
        y: 540,
        timeMs: keyframe.timeMs === 0 ? 0 : 30000,
      })),
    }));
    await page.locator("input[type=file]").setInputFiles({
      name: "stress.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page.waitForFunction(
      () => document.querySelector("canvas")?.width === 1920,
    );
    await page.waitForTimeout(700);
    await page.getByLabel("Export format").selectOption("mp4");
    const started = Date.now();
    const downloadPromise = page.waitForEvent("download", { timeout: 600000 });
    await page.getByRole("button", { name: "Export", exact: true }).click();
    progressTimer = setInterval(async () => {
      try {
        const label = await page
          .locator(".fx-export-button")
          .textContent({ timeout: 1000 });
        console.log(
          `[${name}] ${Math.round((Date.now() - started) / 1000)}s ${label.trim()}`,
        );
      } catch {}
    }, 20000);
    let download;
    try {
      download = await downloadPromise;
    } catch (error) {
      const alerts = await page
        .getByRole("alert")
        .allTextContents()
        .catch(() => []);
      const preserved = await page
        .evaluate(
          () =>
            JSON.parse(
              localStorage.getItem("rapidscreen-textfx-drafts-v1"),
            )?.[0]?.project?.id,
        )
        .catch(() => null);
      console.log(
        `[${name}] stress failed after ${Math.round((Date.now() - started) / 1000)}s: ${alerts.join(" | ") || error.message}; draft=${preserved}`,
      );
      return;
    }
    const file = path.join(outputDir, `${name}-stress.mp4`);
    await download.saveAs(file);
    const metadata = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=width,height,avg_frame_rate:format=duration",
          "-of",
          "json",
          file,
        ],
        { encoding: "utf8" },
      ),
    );
    const stream = metadata.streams[0];
    assert.equal(stream.width, 1920);
    assert.equal(stream.height, 1080);
    assert.equal(stream.avg_frame_rate, "30/1");
    assert.ok(
      Number(metadata.format.duration) >= 29.9 &&
        Number(metadata.format.duration) <= 30.1,
    );
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], {
      encoding: "utf8",
    });
    console.log(
      `[${name}] stress passed in ${Math.round((Date.now() - started) / 1000)}s; ${fs.statSync(file).size} bytes`,
    );
  } finally {
    clearInterval(progressTimer);
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
