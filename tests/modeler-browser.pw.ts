import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { importModelProjectBundle } from "../components/modeler/core";

const baseUrl = process.env.MODELER_TEST_URL ?? "http://localhost:3000";
const channel = (process.env.MODELER_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge";
test.use({ viewport: { width: 1500, height: 900 }, acceptDownloads: true, channel });

test("model studio loads, edits, saves, and exports the first figure", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === new URL(baseUrl).origin) {
      errors.push(request.url() + ": " + request.failure()?.errorText);
    }
  });
  await page.goto(baseUrl + "/modeler", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Ready to sculpt, pose, and render.")).toBeVisible({ timeout: 20_000 }).catch((error) => {
    console.error("Page errors:", errors);
    throw error;
  });
  const canvas = page.locator(".modeler-canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBeGreaterThan(320);
  await expect(page.locator(".modeler-list-button").filter({ hasText: "Vitruvian figure" }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("modeler-starter.png"), fullPage: true });
  const restPose = await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());

  await page.getByRole("button", { name: "Pose", exact: true }).click();
  await page.getByLabel("Bone", { exact: true }).selectOption("arm-left-upper");
  await page.getByLabel("Rotation ° X").last().fill("14");
  await expect.poll(() => canvas.evaluate((node, prior) => (node as HTMLCanvasElement).toDataURL() !== prior, restPose)).toBe(true);
  await page.getByLabel("Keyframe property").selectOption("boneRotation");
  await page.getByRole("button", { name: "Add key" }).click();
  await expect(page.getByText("boneRotation / arm-left-upper")).toBeVisible();

  await page.getByRole("button", { name: "sphere", exact: false }).click();
  await expect(page.locator(".modeler-list-button").filter({ hasText: "Sphere" })).toBeVisible();
  const projectDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save bundle" }).click();
  const bundle = await projectDownload;
  expect(bundle.suggestedFilename()).toMatch(/\.rsm$/);
  const bundlePath = testInfo.outputPath("vitruvian-scene.rsm");
  await bundle.saveAs(bundlePath);
  const imported = await importModelProjectBundle(await readFile(bundlePath));
  expect(imported.project.objects).toHaveLength(2);
  expect(Object.keys(imported.assets)).toHaveLength(1);

  const glbDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "GLB", exact: true }).click();
  const glb = await glbDownload;
  expect(glb.suggestedFilename()).toMatch(/\.glb$/);
  const glbPath = testInfo.outputPath("vitruvian-scene.glb");
  await glb.saveAs(glbPath);
  const bytes = await readFile(glbPath);
  const loaded = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "",
  );
  expect(loaded.animations.length).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("modeler-studio.png"), fullPage: true });
  expect(errors).toEqual([]);
});
