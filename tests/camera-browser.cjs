const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openCameraBrowser,
  probeMedia,
  saveRecordedFile,
  savedFileNames,
} = require("./camera-browser-helpers.cjs");

const browserName = process.argv[2] || "chrome";
const seconds = Math.max(2, Number(process.argv[3] || 4));
const resolution =
  process.env.CAMERA_TEST_RESOLUTION === "1080p" ? "1080p" : "720p";
const useRealDevices = process.env.CAMERA_TEST_REAL === "1";
const forceWebM = process.env.CAMERA_FORCE_WEBM === "1";
const outputDirectory = path.join(
  os.tmpdir(),
  `rapidscreen-camera-${browserName}-${Date.now()}`,
);

async function canvasDifference(page) {
  return page.evaluate(() => {
    const effected = document.querySelector(
      'canvas[aria-label="Effected camera preview"]',
    );
    const clean = document.querySelector(
      'canvas[aria-label="Clean camera preview"]',
    );
    if (
      !(effected instanceof HTMLCanvasElement) ||
      !(clean instanceof HTMLCanvasElement)
    ) {
      throw new Error("The preview canvases are missing");
    }
    const sample = document.createElement("canvas");
    sample.width = 160;
    sample.height = 90;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not sample the preview");
    context.drawImage(effected, 0, 0, sample.width, sample.height);
    const processedPixels = context.getImageData(
      0,
      0,
      sample.width,
      sample.height,
    ).data;
    context.clearRect(0, 0, sample.width, sample.height);
    context.drawImage(clean, 0, 0, sample.width, sample.height);
    const cleanPixels = context.getImageData(
      0,
      0,
      sample.width,
      sample.height,
    ).data;
    let difference = 0;
    for (let index = 0; index < processedPixels.length; index += 4) {
      difference += Math.abs(processedPixels[index] - cleanPixels[index]);
      difference += Math.abs(
        processedPixels[index + 1] - cleanPixels[index + 1],
      );
      difference += Math.abs(
        processedPixels[index + 2] - cleanPixels[index + 2],
      );
    }
    return difference / (sample.width * sample.height * 3);
  });
}

async function main() {
  const { browser, page } = await openCameraBrowser(browserName, {
    fakeDevices: !useRealDevices,
    forceWebM,
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.waitForTimeout(600);
    assert.match(
      await page.locator('meta[name="robots"]').getAttribute("content"),
      /noindex/,
    );
    assert.equal(
      await page
        .getByRole("button", { name: /record/i })
        .last()
        .isDisabled(),
      true,
    );

    await page
      .getByRole("textbox", { name: "Look name" })
      .fill("Camera QA look");
    await page.getByRole("button", { name: /save look/i }).click();
    await page
      .locator("label.camera-range-field")
      .filter({ hasText: "LOOK STRENGTH" })
      .locator('input[type="range"]')
      .press("Home");
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("label.camera-range-field")]
          .find((label) => label.textContent?.includes("LOOK STRENGTH"))
          ?.querySelector("input")?.value === "0",
    );
    assert.equal(
      await page
        .locator("label.camera-range-field")
        .filter({ hasText: "LOOK STRENGTH" })
        .locator('input[type="range"]')
        .inputValue(),
      "0",
    );
    const storedSettings = await page.evaluate(() =>
      window.localStorage.getItem("rapidscreen-camera-fx-looks-v1"),
    );
    assert.ok(
      storedSettings &&
        !/deviceId|videoBlob|audioBlob|directoryHandle/.test(storedSettings),
    );

    await page.getByRole("button", { name: resolution, exact: true }).click();
    await page
      .getByRole("button", { name: /start camera/i })
      .first()
      .click();
    await page
      .getByRole("button", { name: /stop camera/i })
      .waitFor({ timeout: 30000 });
    await page
      .locator(".camera-state-dot.is-ready")
      .waitFor({ timeout: 30000 });
    let sourceCamera = "synthetic";
    if (useRealDevices) {
      const cameraSelect = page
        .locator("label.camera-field-device select")
        .first();
      const usbValue = await cameraSelect
        .locator("option")
        .evaluateAll(
          (options) =>
            options.find((option) =>
              option.textContent?.includes("USB Live camera"),
            )?.value,
        );
      assert.ok(usbValue, "USB Live camera should be selectable");
      await cameraSelect.selectOption(usbValue);
      await page.waitForFunction(
        () =>
          document
            .querySelector("video.camera-source-video")
            ?.srcObject?.getVideoTracks()[0]
            ?.label.includes("USB Live camera"),
        undefined,
        { timeout: 30000 },
      );
      sourceCamera = "USB Live camera";
    }
    await page.waitForTimeout(1500);
    await page
      .locator("button.camera-preset-card")
      .filter({ hasText: "Clean" })
      .click();
    await page.waitForTimeout(500);
    const cleanDifference = await canvasDifference(page);
    await page
      .locator("button.camera-preset-card")
      .filter({ hasText: "ASCII Terminal" })
      .click();
    await page.waitForTimeout(500);
    const effectedDifference = await canvasDifference(page);
    assert.ok(
      effectedDifference > cleanDifference + 8,
      `Effected preview difference ${effectedDifference} should exceed clean ${cleanDifference}`,
    );

    await page.getByRole("button", { name: /choose folder/i }).click();
    await page.waitForFunction(
      () => !document.querySelector("button.camera-record-button")?.disabled,
      undefined,
      { timeout: 10000 },
    );
    await page.getByRole("button", { name: /^record$/i }).click();
    await page
      .getByRole("button", { name: /stop & save/i })
      .waitFor({ timeout: 15000 });
    await page
      .locator("button.camera-preset-card")
      .filter({ hasText: "Heat Vision" })
      .click();
    await page.waitForTimeout((seconds * 1000) / 2);
    if (seconds <= 10) {
      await page.getByRole("button", { name: /mic on/i }).click();
      await page.getByRole("button", { name: /mic muted/i }).waitFor();
    }
    await page.waitForTimeout((seconds * 1000) / 2);
    const stopButton = page.getByRole("button", { name: /stop & save/i });
    if (await stopButton.isVisible()) {
      await stopButton.click();
    }
    await page
      .getByRole("button", { name: /^record$/i })
      .waitFor({ timeout: 120000 });

    const names = await savedFileNames(page);
    assert.equal(
      names.length,
      2,
      `Expected two local files, got ${names.join(", ")}`,
    );
    assert.ok(names.some((name) => name.includes("effected")));
    assert.ok(names.some((name) => name.includes("clean")));
    fs.mkdirSync(outputDirectory, { recursive: true });
    const results = {};
    for (const name of names) {
      const destination = path.join(outputDirectory, name);
      await saveRecordedFile(page, name, destination);
      const probe = probeMedia(destination);
      assert.equal(probe.video.width, resolution === "1080p" ? 1920 : 1280);
      assert.equal(probe.video.height, resolution === "1080p" ? 1080 : 720);
      assert.ok(probe.audio, `${name} should include microphone audio`);
      assert.ok(
        probe.duration >= seconds - (seconds >= 600 ? 3 : 0.5),
        `${name} duration ${probe.duration}`,
      );
      assert.ok(
        probe.decodedFrames > 0,
        `${name} should contain decoded frames`,
      );
      execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", destination, "-f", "null", "-"],
        {
          stdio: "pipe",
          timeout: 300000,
        },
      );
      results[name] = {
        ...probe,
        measuredFrameRate: probe.decodedFrames / probe.duration,
      };
    }
    const durations = Object.values(results).map((result) => result.duration);
    assert.ok(
      Math.abs(durations[0] - durations[1]) < 0.5,
      `Clip durations differ: ${durations}`,
    );
    if (forceWebM) {
      assert.ok(names.every((name) => name.endsWith(".webm")));
      await page.getByRole("button", { name: /convert mp4/i }).click();
      await page.getByText(/mp4 ready/i).waitFor({ timeout: 180000 });
      const convertedNames = (await savedFileNames(page)).filter((name) =>
        name.endsWith(".mp4"),
      );
      assert.equal(convertedNames.length, 2);
      for (const name of convertedNames) {
        const destination = path.join(outputDirectory, name);
        await saveRecordedFile(page, name, destination);
        const probe = probeMedia(destination);
        assert.equal(probe.video.codec_name, "h264");
        assert.ok(probe.audio, `${name} should include microphone audio`);
      }
    }
    assert.deepEqual(pageErrors, []);
    console.log(
      JSON.stringify(
        {
          browserName,
          resolution,
          useRealDevices,
          forceWebM,
          sourceCamera,
          outputDirectory,
          cleanDifference,
          effectedDifference,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
