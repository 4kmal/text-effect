const assert = require("node:assert/strict");
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

async function cameraDenied() {
  const { browser, page } = await openCameraBrowser(browserName, {
    permissions: [],
  });
  try {
    await page.waitForTimeout(600);
    await page
      .getByRole("button", { name: /start camera/i })
      .first()
      .click();
    await page
      .locator(".camera-state-dot.is-error")
      .waitFor({ timeout: 15000 });
    const alert = await page.locator(".camera-alert-bar").textContent();
    assert.match(alert || "", /permission|denied|notallowed/i);
    assert.equal(await savedFileNames(page).then((names) => names.length), 0);
    return alert;
  } finally {
    await browser.close();
  }
}

async function microphoneDenied() {
  const { browser, context, page } = await openCameraBrowser(browserName, {
    permissions: ["camera"],
  });
  const outputDirectory = path.join(
    os.tmpdir(),
    `rapidscreen-video-only-${browserName}-${Date.now()}`,
  );
  try {
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "720p", exact: true }).click();
    await page
      .getByRole("button", { name: /start camera/i })
      .first()
      .click();
    await page
      .locator(".camera-state-dot.is-ready")
      .waitFor({ timeout: 30000 });
    assert.match(
      (await page.locator(".camera-alert-bar").textContent()) || "",
      /microphone|video-only/i,
    );
    await page.getByRole("button", { name: /mic muted/i }).click();
    await page.getByRole("button", { name: /mic muted/i }).waitFor();
    await context.grantPermissions(["camera", "microphone"], {
      origin: "http://localhost:3000",
    });
    await page.getByRole("button", { name: /mic muted/i }).click();
    await page.getByRole("button", { name: /mic on/i }).waitFor();
    await page.getByRole("button", { name: /mic on/i }).click();
    await page.getByRole("button", { name: /mic muted/i }).waitFor();
    await page.getByRole("button", { name: /choose folder/i }).click();
    await page.waitForFunction(
      () => !document.querySelector("button.camera-record-button")?.disabled,
    );
    await page.getByRole("button", { name: /^record$/i }).click();
    await page.getByRole("button", { name: /stop & save/i }).waitFor();
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: /stop & save/i }).click();
    await page
      .getByRole("button", { name: /^record$/i })
      .waitFor({ timeout: 30000 });
    const names = await savedFileNames(page);
    assert.equal(names.length, 2);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const clips = [];
    for (const name of names) {
      const destination = path.join(outputDirectory, name);
      await saveRecordedFile(page, name, destination);
      const media = probeMedia(destination);
      assert.equal(media.audio, undefined);
      clips.push({
        name,
        duration: media.duration,
        decodedFrames: media.decodedFrames,
      });
    }
    return { outputDirectory, clips };
  } finally {
    await browser.close();
  }
}

Promise.all([cameraDenied(), microphoneDenied()])
  .then(([cameraDenial, videoOnly]) =>
    console.log(
      JSON.stringify({ browserName, cameraDenial, videoOnly }, null, 2),
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
