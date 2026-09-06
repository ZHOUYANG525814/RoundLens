import { expect, test } from "@playwright/test";

test("tools load independently and publish structured cold-start telemetry", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RoundLens" })).toBeVisible();

  await expect.poll(async () => page.evaluate(() =>
    (window.__CDNA_TELEMETRY__ ?? []).some((entry) =>
      entry.toolId === "cdna-display" && entry.phase === "tool-import" && entry.status === "ok"
    ),
  )).toBeTruthy();
  const firstResources = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  expect(firstResources.some((name) => name.includes("targeted-nanopore.worker"))).toBeFalsy();
  await page.evaluate(() => window.__CDNA_BENCHMARK__!.initializeWorker("cdna-display"));
  await expect.poll(async () => page.evaluate(() =>
    (window.__CDNA_TELEMETRY__ ?? []).some((entry) =>
      entry.toolId === "cdna-display" && entry.phase === "worker-initialization" && entry.status === "ok"
    ),
  )).toBeTruthy();
  const afterCdnaWorker = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  expect(afterCdnaWorker.some((name) => name.includes("cdna.worker"))).toBeTruthy();
  expect(afterCdnaWorker.some((name) => name.includes("targeted-nanopore.worker"))).toBeFalsy();

  await page.getByRole("button", { name: "Nanopore" }).click();
  await expect(page.getByRole("heading", { name: "RoundLens" })).toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    (window.__CDNA_TELEMETRY__ ?? []).some((entry) =>
      entry.toolId === "nanopore-targeted" && entry.phase === "tool-import" && entry.status === "ok"
    ),
  )).toBeTruthy();
  const beforeTargeted = await page.evaluate(() => performance.getEntriesByType("resource").length);
  await page.evaluate(() => window.__CDNA_BENCHMARK__!.initializeWorker("nanopore-targeted"));
  const targetedResources = await page.evaluate(
    (start) => performance.getEntriesByType("resource").slice(start).map((entry) => entry.name),
    beforeTargeted,
  );
  expect(targetedResources.some((name) => name.includes("targeted-nanopore.worker"))).toBeTruthy();
  expect(targetedResources.some((name) => name.includes("cdna.worker"))).toBeFalsy();
});

test("records browser streaming capabilities for the frozen environment", async ({ page }, testInfo) => {
  await page.goto("/");
  const capabilities = await page.evaluate(() => ({
    readableStream: typeof ReadableStream !== "undefined",
    decompressionStream: typeof DecompressionStream !== "undefined",
    blob: typeof Blob !== "undefined",
    userAgent: navigator.userAgent,
  }));
  await testInfo.attach("browser-capabilities.json", {
    body: JSON.stringify(capabilities, null, 2),
    contentType: "application/json",
  });
  expect(capabilities.readableStream).toBeTruthy();
  expect(capabilities.decompressionStream).toBeTruthy();
  expect(capabilities.blob).toBeTruthy();
});
