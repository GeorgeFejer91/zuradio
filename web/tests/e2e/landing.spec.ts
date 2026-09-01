import { expect, test } from "@playwright/test";

const companionBase = process.env.ZURADIO_COMPANION_BASE ?? "http://127.0.0.1:4173";

test("shows three URL-free connection modes and prompts for a password", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(companionBase);
  await expect(page.getByText("ZURADIO", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Web Companion" })).toBeVisible();
  await expect(page.getByTestId("connect-listen")).toBeVisible();
  await expect(page.getByTestId("connect-control")).toBeVisible();
  await expect(page.getByTestId("connect-upload")).toBeVisible();
  await expect(page.getByText(/invitation/i)).toHaveCount(0);
  await expect(page.locator('input[type="url"]')).toHaveCount(0);
  await expect(page.getByLabel("Live Zuradio audio")).toHaveCount(0);
  await expect(page.getByLabel("Remote player controls")).toHaveCount(0);

  await page.getByTestId("connect-listen").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("password")).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors, "browser console and page errors").toEqual([]);
});
