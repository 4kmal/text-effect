import { expect, test } from "@playwright/test";

const baseUrl = process.env.MODELER_TEST_URL ?? "http://localhost:3000";
const channel = (process.env.MODELER_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge";

test.use({ viewport: { width: 1400, height: 900 }, channel });

test("writes a transparent 60-frame PNG sequence", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const state = window as typeof window & { modelerArchive?: Blob };
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async () => ({
        createWritable: async () => {
          const chunks: BlobPart[] = [];
          return {
            write: async (part: BlobPart) => { chunks.push(part); },
            close: async () => { state.modelerArchive = new Blob(chunks); },
            abort: async () => { chunks.length = 0; },
          };
        },
      }),
    });
  });
  await page.goto(baseUrl + "/modeler", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Ready to sculpt, pose, and render.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "EMPTY SCENE build from shapes" }).click();
  await page.getByRole("button", { name: "sphere", exact: false }).click();
  await page.getByLabel("Canvas resolution").selectOption("1280x720");
  await page.getByLabel("Duration").fill("1");
  await page.getByLabel("Format").selectOption("png-sequence");
  await page.getByRole("button", { name: "Render clip" }).click();
  await expect(page.getByText("PNG frames saved.")).toBeVisible({ timeout: 160_000 });

  const archive = await page.evaluate(async () => {
    const blob = (window as typeof window & { modelerArchive?: Blob }).modelerArchive;
    if (!blob) throw new Error("The save picker received no archive.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const firstNameLength = view.getUint16(26, true);
    const firstSize = view.getUint32(18, true);
    const firstPng = bytes.slice(30 + firstNameLength, 30 + firstNameLength + firstSize);
    const image = await createImageBitmap(new Blob([firstPng], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hasOpaque = false;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 0) { hasOpaque = true; break; }
    }
    const end = bytes.length - 22;
    return {
      localHeader: view.getUint32(0, true),
      endHeader: view.getUint32(end, true),
      frameCount: view.getUint16(end + 10, true),
      width: image.width,
      height: image.height,
      cornerAlpha: data[3],
      hasOpaque,
    };
  });
  expect(archive).toEqual({
    localHeader: 0x04034b50,
    endHeader: 0x06054b50,
    frameCount: 60,
    width: 1280,
    height: 720,
    cornerAlpha: 0,
    hasOpaque: true,
  });
});
