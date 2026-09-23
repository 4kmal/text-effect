const assert = require("node:assert/strict");
const { targets } = require("./browser-targets.cjs");

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
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
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
    project.id = `qa-cancel-${name}`;
    project.width = 320;
    project.height = 180;
    project.durationMs = 30000;
    project.layers = project.layers.slice(0, 1).map((layer) => ({
      ...layer,
      text: "CANCEL TEST",
      fontSize: 48,
      x: 160,
      y: 90,
      endMs: 30000,
      keyframes: layer.keyframes.map((keyframe) => ({
        ...keyframe,
        x: 160,
        y: 90,
        timeMs: keyframe.timeMs === 0 ? 0 : 30000,
      })),
    }));
    await page.locator("input[type=file]").setInputFiles({
      name: "cancel.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page.waitForFunction(
      () => document.querySelector("canvas")?.width === 320,
    );
    await page.waitForTimeout(700);
    await page.getByLabel("Export format").selectOption("gif");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page
      .getByRole("button", { name: /^Cancel/ })
      .waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: /^Cancel/ }).click();
    await page
      .getByRole("button", { name: "Export", exact: true })
      .waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    assert.equal(downloaded, false, `${name} downloaded a canceled export`);
    const stored = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("rapidscreen-textfx-drafts-v1"))[0]
          .project,
    );
    assert.equal(stored.id, project.id, `${name} lost the project on cancel`);
    console.log(`[${name}] cancellation passed; project retained`);
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
