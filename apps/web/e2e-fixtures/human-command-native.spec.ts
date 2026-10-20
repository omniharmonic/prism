import { test, expect } from "@playwright/test";
/** Run with the fixture Vite process VITE_PRISM_NATIVE=1; no native build/install. */
test("native transport preserves the device bearer alongside a capability query", async ({
  page,
}) => {
  test.skip(
    process.env.PRISM_TEST_NATIVE !== "1",
    "Requires native-mode fixture Vite process; not a native installed-app test.",
  );
  await page.addInitScript(() => {
    (window as any).__PRISM_HOST__ = {
      apiOrigin: location.origin,
      getToken: () => "pd_fictional_device_token",
    };
  });
  await page.goto("/e2e-fixtures/human-command-helpers.html");
  await page.context().addCookies([
    {
      name: "fixture_cookie",
      value: "not-sent-native",
      url: new URL(page.url()).origin,
    },
  ]);
  await expect(page.locator(".tiptap")).toHaveCount(1);
  let headers: Record<string, string> = {};
  let capability = "";
  await page.route("**/api/collab/**", async (route) => {
    headers = await route.request().allHeaders();
    capability = new URL(route.request().url()).searchParams.get("t") ?? "";
    const c = route.request().postDataJSON();
    await route.fulfill({
      json: {
        requestId: c.requestId,
        kind: "suggest",
        suggestionId: "fixture_confirmed",
      },
    });
  });
  await page.evaluate(async () => {
    const f = (window as any).humanFixture;
    f.setAudience();
    await f.send(
      JSON.stringify({
        kind: "suggest",
        requestId: crypto.randomUUID(),
        createdAt: Date.now(),
        revision: "a".repeat(64),
        from: 1,
        to: 6,
        quote: "Alpha",
        text: "Better",
      }),
    );
  });
  expect(headers.authorization).toBe("Bearer pd_fictional_device_token");
  expect(capability).toBe("fixture-link-token");
  expect(headers.cookie).toBeUndefined();
  expect(
    await page.evaluate(() => (window as any).humanFixture.credentials),
  ).toBe("omit");
});
