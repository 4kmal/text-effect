import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { importModelProjectBundle } from "../components/modeler/core";

const baseUrl = process.env.MODELER_TEST_URL ?? "http://localhost:3000";
const channel = (process.env.MODELER_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge";
test.use({ viewport: { width: 1500, height: 900 }, acceptDownloads: true, channel });

test("model studio loads V2, poses both figures, saves, exports, and keeps V1 imports working", async ({ page }, testInfo) => {
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
  // Local draft storage can contain a V1 scene from an earlier run. Start the
  // browser assertion from the explicit V2 preset so the contract is stable.
  await page.locator(".modeler-preset").filter({ hasText: "VITRUVIAN" }).first().click();
  const canvas = page.locator(".modeler-canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBeGreaterThan(320);
  await expect(page.locator(".modeler-list-button").filter({ hasText: "Vitruvian V2 assembly" }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("modeler-starter.png"), fullPage: true });
  const restPose = await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());

  await page.getByRole("button", { name: "Pose", exact: true }).click();
  const primary = page.locator(".modeler-list-button").filter({ hasText: "Primary figure" }).first();
  await primary.click();
  const primaryBone = await page.getByLabel("Bone", { exact: true }).evaluate((node) =>
    Array.from((node as HTMLSelectElement).options).find((option) => option.value.startsWith("primary_"))?.value ?? "",
  );
  expect(primaryBone).toMatch(/^primary_/);
  await page.getByLabel("Bone", { exact: true }).selectOption(primaryBone);
  await page.getByLabel("Rotation ° X").last().fill("14");
  await expect.poll(() => canvas.evaluate((node, prior) => (node as HTMLCanvasElement).toDataURL() !== prior, restPose)).toBe(true);
  await page.getByLabel("Keyframe property").selectOption("boneRotation");
  await page.getByRole("button", { name: "Add key" }).click();
  await expect(page.getByText(new RegExp(`boneRotation / ${primaryBone}`))).toBeVisible();

  const ghost = page.locator(".modeler-list-button").filter({ hasText: "Second pose" }).first();
  await ghost.click();
  const ghostBone = await page.getByLabel("Bone", { exact: true }).evaluate((node) =>
    Array.from((node as HTMLSelectElement).options).find((option) => option.value.startsWith("ghost_"))?.value ?? "",
  );
  expect(ghostBone).toMatch(/^ghost_/);
  await page.getByLabel("Bone", { exact: true }).selectOption(ghostBone);
  await page.getByLabel("Rotation ° X").last().fill("-10");
  await page.getByRole("button", { name: "Add key" }).click();
  await expect(page.getByText(new RegExp(`boneRotation / ${ghostBone}`))).toBeVisible();

  await page.getByRole("button", { name: "sphere", exact: false }).click();
  await expect(page.locator(".modeler-list-button").filter({ hasText: "Sphere" })).toBeVisible();
  const projectDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save bundle" }).click();
  const bundle = await projectDownload;
  expect(bundle.suggestedFilename()).toMatch(/\.rsm$/);
  const bundlePath = testInfo.outputPath("vitruvian-scene.rsm");
  await bundle.saveAs(bundlePath);
  const imported = await importModelProjectBundle(await readFile(bundlePath));
  expect(imported.project.objects).toHaveLength(5);
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
  const nodeNames: string[] = [];
  loaded.scene.traverse((node) => nodeNames.push(node.name));
  expect(nodeNames).toEqual(expect.arrayContaining(["vitruvian-primary", "vitruvian-ghost", "vitruvian-ring"]));
  const trackNames = loaded.animations.flatMap((clip) => clip.tracks.map((track) => track.name));
  expect(trackNames.some((name) => name.includes(primaryBone))).toBe(true);
  expect(trackNames.some((name) => name.includes(ghostBone))).toBe(true);

  // A V1 GLB still loads through the local import path and is represented as
  // the original single figure, so saved legacy projects remain usable.
  await page.locator('input[type="file"][accept*=".glb"]').setInputFiles(resolve("public/modeler/vitruvian.glb"));
  await expect(page.locator(".modeler-list-button").filter({ hasText: "vitruvian" }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("modeler-studio.png"), fullPage: true });
  expect(errors).toEqual([]);
});
