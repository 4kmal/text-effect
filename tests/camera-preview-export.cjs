const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openCameraBrowser,
  saveRecordedFile,
  savedFileNames,
} = require("./camera-browser-helpers.cjs");

const browserName = process.argv[2] || "chrome";
const sampleWidth = 160;
const sampleHeight = 90;

async function samplePreview(page, label) {
  return page.evaluate(
    ({ label, width, height }) => {
      const source = document.querySelector(`canvas[aria-label="${label}"]`);
      if (!(source instanceof HTMLCanvasElement)) {
        throw new Error(`Missing ${label}`);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(source, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const rgb = [];
      for (let index = 0; index < pixels.length; index += 4) {
        rgb.push(pixels[index], pixels[index + 1], pixels[index + 2]);
      }
      return rgb;
    },
    { label, width: sampleWidth, height: sampleHeight },
  );
}

function decodedFrame(file) {
  const frame = execFileSync(
    "ffmpeg",
    [
      "-v", "error", "-ss", "1", "-i", file,
      "-frames:v", "1", "-vf", `scale=${sampleWidth}:${sampleHeight}`,
      "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ],
    { maxBuffer: sampleWidth * sampleHeight * 4 },
  );
  assert.equal(frame.length, sampleWidth * sampleHeight * 3);
  return frame;
}

function meanError(left, right) {
  assert.equal(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += Math.abs(left[index] - right[index]);
  }
  return sum / left.length;
}

async function main() {
  const { browser, page } = await openCameraBrowser(browserName, {
    staticVideo: true,
  });
  const outputDirectory = path.join(
    os.tmpdir(),
    `rapidscreen-preview-export-${browserName}-${Date.now()}`,
  );
  try {
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "720p", exact: true }).click();
    await page.getByRole("button", { name: /start camera/i }).first().click();
    await page.locator(".camera-state-dot.is-ready").waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: /choose folder/i }).click();
    await page.waitForFunction(
      () => !document.querySelector("button.camera-record-button")?.disabled,
    );
    await page.getByRole("button", { name: /^record$/i }).click();
    await page.getByRole("button", { name: /stop & save/i }).waitFor();
    await page.waitForTimeout(1300);
    const preview = {
      effected: await samplePreview(page, "Effected camera preview"),
      clean: await samplePreview(page, "Clean camera preview"),
    };
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: /stop & save/i }).click();
    await page.locator(".camera-state-dot.is-ready").waitFor({ timeout: 30000 });
    const names = await savedFileNames(page);
    assert.equal(names.length, 2);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const video = {};
    for (const name of names) {
      const kind = name.includes("effected") ? "effected" : "clean";
      const file = path.join(outputDirectory, name);
      await saveRecordedFile(page, name, file);
      video[kind] = decodedFrame(file);
    }
    const direct = {
      effected: meanError(preview.effected, video.effected),
      clean: meanError(preview.clean, video.clean),
    };
    const crossed = {
      effected: meanError(preview.effected, video.clean),
      clean: meanError(preview.clean, video.effected),
    };
    assert.ok(direct.effected < 30, JSON.stringify({ direct, crossed }));
    assert.ok(direct.clean < 20, JSON.stringify({ direct, crossed }));
    assert.ok(direct.effected < crossed.effected, JSON.stringify({ direct, crossed }));
    assert.ok(direct.clean < crossed.clean, JSON.stringify({ direct, crossed }));
    console.log(JSON.stringify({ browserName, direct, crossed, outputDirectory }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
