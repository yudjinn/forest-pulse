// Service core journeys: a researcher signs in and watches a real sensor's event arrive in the live log, and a visitor
// watches the public demo.
import { expect, test } from "@playwright/test";
import { devVars, showDevices, showEventLog } from "../fixtures/dashboard.ts";
import { referenceClip, replay, sensorName, uniqueSensorId } from "../fixtures/sensor.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const clockTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

test("a researcher signs in and sees a replayed chainsaw arrive in the live log", async ({ page, context, request }) => {
  // Signed out, the dashboard and its data are closed.
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect((await request.get("/dashboard/api/events")).status()).toBe(401);
  // Dashboard pages, the rewritten sign-in page included, carry the dashboard's own script policy.
  const policy = (await request.get("/signin")).headers()["content-security-policy"];
  expect(policy).toContain("script-src 'self'");
  expect(policy).not.toContain("form-action 'none'");

  // A wrong password is refused and stays on the sign-in page.
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong password")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // The right one opens the log, with a 7-day session cookie.
  await page.getByLabel("Password").fill(devVars().DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => u.pathname === "/" && !u.search);
  await showEventLog(page);
  await expect(page.getByRole("tabpanel", { name: "Event log" })).toBeVisible();
  expect((await page.request.get("/")).headers()["content-security-policy"]).toContain("script-src 'self'");
  const signedInAt = Date.now() / 1000;
  const [cookie] = (await context.cookies()).filter((c) => c.name === "fp_session");
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  expect(cookie.expires - signedInAt).toBeGreaterThan(7 * 86400 - 60);
  expect(cookie.expires - signedInAt).toBeLessThan(7 * 86400 + 60);

  // A sensor (the library's replay with an angle) hears a chainsaw; the row appears within about 2 s.
  const sensorId = uniqueSensorId("log");
  const heardFrom = Date.now();
  const out = await replay({ sensorId, wavs: [referenceClip("chainsaw.wav")], angle: 37 });
  expect(out).toContain("0 event(s) still queued");
  const delivered = Date.now();
  // The log names the sensor as the plan does.
  const name = await sensorName(page.request, sensorId);
  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });
  await expect(row).toHaveCount(1, { timeout: 3000 });
  await expect(row).toContainText("Chainsaw");
  await expect(row).toContainText("37°");
  const cells = await row.getByRole("cell").allTextContents();
  expect(cells[3]).toMatch(/^\d{2,3}%$/);
  const times = new Set<string>();
  for (let t = heardFrom - 1000; t <= delivered + 1000; t += 500) times.add(clockTime(t));
  expect(times).toContain(cells[0]);
});

test("anyone can watch the demo at /dashboard/ without signing in, and it never touches the researchers' data", async ({ page }) => {
  // Every demo reply comes from the page itself: no request for researcher data leaves the browser.
  const dataRequests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/dashboard/api/")) dataRequests.push(r.url());
  });
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await expect(page).toHaveTitle("Forest Pulse demo");
  await expect(page.getByRole("note")).toContainText("This is a demo with simulated sounds.");

  // The scripted forest: an owl already placed, then logging that raises the alert a few seconds in.
  const activities = page.getByRole("list", { name: "Activities" });
  await expect(activities.getByRole("listitem").filter({ hasText: "Boreal owl" })).toContainText("m from Sensor 1");
  await expect(page.getByRole("region", { name: "Logging alert" })).toContainText("Logging detected near Sensor 1, Sensor 3",
    { timeout: 15_000 });
  await expect(page.getByRole("img", { name: "Direction from Sensor 3" }).first()).toBeAttached();

  // What it is for is to be watched: nothing on it changes anything.
  await expect(page.getByRole("switch", { name: "Chainsaw" })).toBeHidden();
  for (const name of ["Teach a new sound", "Play sounds", "Send warning", "Dismiss"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
  }
  await showDevices(page);
  await expect(page.getByRole("list", { name: "Sensors" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Calibrate" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Remove Sensor 1" })).toBeHidden();
  await showEventLog(page);
  await expect(page.getByRole("row").filter({ hasText: "Chainsaw" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear events" })).toBeHidden();
  expect(dataRequests).toEqual([]);
});
