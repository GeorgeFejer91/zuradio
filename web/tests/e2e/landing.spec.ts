import { expect, test } from "@playwright/test";

const companionBase = process.env.ZURADIO_COMPANION_BASE ?? "http://127.0.0.1:4173";

test("shows a safe offline landing state and rejects malformed invitations", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(companionBase);
  await expect(page.getByRole("heading", { name: "Zuradio Web Companion" })).toBeVisible();
  await expect(page.getByText("No invitation", { exact: true })).toBeVisible();
  await expect(page.getByText("Laptop offline", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Invitation link")).toBeVisible();
  await expect(page.getByLabel("Live Zuradio audio")).toBeVisible();
  await expect(page.getByLabel("Remote player controls")).toHaveCount(0);

  await page.getByLabel("Invitation link").fill("not an invitation");
  await page.getByTestId("connect").click();
  await expect(page.getByRole("alert")).toContainText("Invalid URL");
  await expect(page.getByLabel("Invitation link")).toHaveValue("not an invitation");
  expect(errors, "browser console and page errors").toEqual([]);
});
