import { expect, test } from "@playwright/test";

test("the landing page keeps working", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Forest Pulse" })).toBeVisible();
});
