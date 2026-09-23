const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { targets } = require("./browser-targets.cjs");

const baseUrl = process.env.TEXTFX_URL || "http://localhost:3000/editor";
const screenshotDir = path.join(os.tmpdir(), "textfx-browser-qa");

async function currentProject(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("rapidscreen-textfx-drafts-v1");
    return raw ? JSON.parse(raw)[0]?.project : null;
  });
}

async function waitForDraft(page, predicate) {
  await page.waitForFunction(
    (source) => {
      const raw = localStorage.getItem("rapidscreen-textfx-drafts-v1");
      if (!raw) return false;
      const project = JSON.parse(raw)[0]?.project;
      return source === "two-layers"
        ? project?.layers?.length === 2
        : project?.layers?.some((layer) => layer.text === "HELLO WORLD");
    },
    predicate,
    { timeout: 10000 },
  );
}

async function checkBrowser(name, browserType, options = {}) {
  console.log(`[${name}] launching`);
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page
      .getByRole("heading", { name: "Text treatments" })
      .waitFor({ timeout: 20000 });
    await page.waitForTimeout(100);
    const canvas = page.locator("canvas").first();
    const firstFrame = await canvas.evaluate((element) => element.toDataURL());
    await page.getByRole("button", { name: "Jump to end" }).click();
    await page.waitForTimeout(100);
    await page.getByRole("button", { name: "Go to start" }).click();
    await page.waitForTimeout(100);
    assert.equal(
      await canvas.evaluate((element) => element.toDataURL()),
      firstFrame,
      "scrubbing changed a seeded frame",
    );

    await page.getByRole("button", { name: "Add text layer" }).first().click();
    await waitForDraft(page, "two-layers");
    assert.equal((await currentProject(page)).layers.length, 2);
    const addedLayerId = (await currentProject(page)).layers[1].id;
    await page.getByRole("button", { name: "Move layer down" }).click();
    await page.waitForFunction(
      (id) =>
        JSON.parse(localStorage.getItem("rapidscreen-textfx-drafts-v1"))?.[0]
          ?.project?.layers?.[0]?.id === id,
      addedLayerId,
    );
    await page.getByRole("button", { name: "Move layer up" }).click();
    await page.waitForFunction(
      (id) =>
        JSON.parse(localStorage.getItem("rapidscreen-textfx-drafts-v1"))?.[0]
          ?.project?.layers?.[1]?.id === id,
      addedLayerId,
    );

    await page.locator(".fx-panel-right textarea").fill("HELLO WORLD");
    await waitForDraft(page, "edited-text");
    const beforeDrag = await currentProject(page);
    const box = await canvas.boundingBox();
    assert.ok(box, "canvas is visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 30,
      box.y + box.height / 2 + 20,
    );
    await page.mouse.up();
    await page.waitForTimeout(700);
    const afterDrag = await currentProject(page);
    assert.notEqual(
      afterDrag.layers[1].x,
      beforeDrag.layers[1].x,
      "canvas drag did not change x",
    );
    assert.notEqual(
      afterDrag.layers[1].y,
      beforeDrag.layers[1].y,
      "canvas drag did not change y",
    );

    await page.getByRole("button", { name: "Add X position keyframe" }).click();
    await page.waitForTimeout(700);
    const keyed = await currentProject(page);
    assert.ok(keyed.layers[1].keyframes.length > 0, "keyframe not saved");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForTimeout(700);
    const undone = await currentProject(page);
    assert.equal(
      undone.layers[1].keyframes.length,
      0,
      "undo did not remove keyframe",
    );
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.waitForTimeout(700);
    const redone = await currentProject(page);
    assert.ok(
      redone.layers[1].keyframes.length > 0,
      "redo did not restore keyframe",
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: "Text treatments" })
      .waitFor({ timeout: 20000 });
    assert.equal(
      (await currentProject(page)).layers[1].text,
      "HELLO WORLD",
      "draft did not reload",
    );
    const jsonDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    const jsonDownload = await jsonDownloadPromise;
    const jsonPath = path.join(screenshotDir, `${name}-project.json`);
    await jsonDownload.saveAs(jsonPath);
    assert.equal(
      JSON.parse(require("node:fs").readFileSync(jsonPath, "utf8")).layers[1]
        .text,
      "HELLO WORLD",
    );

    await page.locator(".fx-draft-trigger").click();
    await page.getByLabel("Draft name").fill("QA Draft A");
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("rapidscreen-textfx-drafts-v1"))?.[0]
          ?.name === "QA Draft A",
    );
    await page.getByRole("button", { name: "New draft" }).click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("rapidscreen-textfx-drafts-v1"))
          ?.length >= 2,
    );
    await page.locator(".fx-draft-trigger").click();
    await page.getByLabel("Draft name").fill("QA Draft B");
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("rapidscreen-textfx-drafts-v1"))?.[0]
          ?.name === "QA Draft B",
    );
    await page
      .locator(".fx-draft-option")
      .filter({ hasText: "QA Draft A" })
      .click();
    await page.locator(".fx-layer-row .fx-layer-select").first().click();
    assert.equal(
      await page.locator(".fx-panel-right textarea").inputValue(),
      "HELLO WORLD",
      "switching drafts lost edits",
    );
    await page.screenshot({
      path: path.join(screenshotDir, `${name}.png`),
      fullPage: true,
    });
    assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
    console.log(
      `[${name}] editing, timeline, JSON, and multiple drafts passed`,
    );
  } finally {
    await browser.close();
  }
}

async function main() {
  const fs = require("node:fs");
  fs.mkdirSync(screenshotDir, { recursive: true });
  for (const [name, { browserType, options }] of Object.entries(targets)) {
    await checkBrowser(name, browserType, options);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
