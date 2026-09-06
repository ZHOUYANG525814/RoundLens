import { expect, test } from "@playwright/test";

test("mobile and tablet device signals are blocked before tool modules load", async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Desktop browser required" })).toBeVisible();
  const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  expect(resources.some((name) => /cdna\.worker|targeted-nanopore\.worker|cdna_core_wasm/.test(name))).toBeFalsy();
  expect(await page.evaluate(() => window.__CDNA_TELEMETRY__ ?? [])).toEqual([]);
  await context.close();
});

test("a narrow desktop window remains supported", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RoundLens" })).toBeVisible();
  await expect(page.getByText("Desktop browser required")).toHaveCount(0);
});
