import { test, expect, type Page } from "@playwright/test";

async function setup(
  page: Page,
  identity: () => string = () => "owner@test.local",
) {
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        email: identity(),
        isOwner: true,
        vaultId: route.request().headers()["x-prism-vault"] ?? "v1",
        workspace: { id: "w1", name: "Test workspace" },
      },
    }),
  );
  await page.goto("/e2e-fixtures/harness.html");
  await page.evaluate(async () => {
    const path = "/src/config.ts";
    const config = await import(path);
    config.setActiveVault("v1");
    await config.fetchMe();
  });
}
async function queue(
  page: Page,
  method = "PATCH",
  path = "/notes/n1",
  body = { content: "local change", if_updated_at: "revision-1" },
  options = {},
) {
  await page.evaluate(
    async ({ method, path, body, options }) => {
      const modulePath = "/src/offline/outbox.ts";
      const scopePath = "/src/offline/writeScope.ts";
      const outbox = await import(modulePath);
      const context = await (await import(scopePath)).captureWriteContext();
      await outbox.enqueue(
        method,
        path,
        JSON.stringify(body),
        context,
        options,
      );
    },
    { method, path, body, options },
  );
}
async function flush(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/offline/outbox.ts";
    await (await import(path)).flush();
  });
}
async function rows(
  page: Page,
): Promise<
  Array<{ state: string; body: string; scope?: { actor: string }; id: number }>
> {
  return page.evaluate(async () => {
    const path = "/src/offline/outbox.ts";
    return (await import(path)).allQueued();
  });
}

test("offline write stays with its original vault and preserves the revision", async ({
  page,
}) => {
  await setup(page);
  const requests: Array<{
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  await page.route("**/api/notes/**", (route) => {
    requests.push({
      headers: route.request().headers(),
      body: route.request().postDataJSON(),
    });
    return route.fulfill({ json: { id: "n1" } });
  });
  await queue(page);
  await page.evaluate(async () => {
    const path = "/src/config.ts";
    const c = await import(path);
    c.setActiveVault("v2");
    await c.fetchMe();
  });
  await flush(page);
  expect(requests).toHaveLength(0);
  expect(await rows(page)).toHaveLength(1);
  await page.evaluate(async () => {
    const path = "/src/config.ts";
    const c = await import(path);
    c.setActiveVault("v1");
    await c.fetchMe();
  });
  await flush(page);
  expect(requests).toHaveLength(1);
  expect(requests[0].headers["x-prism-vault"]).toBe("v1");
  expect(requests[0].headers["x-prism-workspace"]).toBe("w1");
  expect(requests[0].headers["x-prism-write-actor"]).toBe(
    "user:owner@test.local",
  );
  expect(requests[0].body).toEqual({
    content: "local change",
    if_updated_at: "revision-1",
  });
  expect(await rows(page)).toHaveLength(0);
});

test("switching accounts cannot replay another actor's saved changes", async ({
  page,
}) => {
  let email = "owner@test.local";
  await setup(page, () => email);
  let writes = 0;
  await page.route("**/api/notes/**", (route) => {
    writes++;
    return route.fulfill({ json: {} });
  });
  await queue(page);
  email = "another@test.local";
  await flush(page);
  expect(writes).toBe(0);
  expect((await rows(page))[0].scope?.actor).toBe("user:owner@test.local");
});

for (const [status, state] of [
  [409, "conflict"],
  [404, "missing"],
  [410, "missing"],
  [403, "blocked"],
  [502, "unknown"],
] as const) {
  test(`${status} retains the draft and never forces or blindly retries`, async ({
    page,
  }) => {
    await setup(page);
    let writes = 0;
    await page.route("**/api/notes/**", (route) => {
      writes++;
      return route.fulfill({ status, json: { error: "fixture" } });
    });
    await queue(page);
    await flush(page);
    await flush(page);
    expect(writes).toBe(1);
    const saved = await rows(page);
    expect(saved).toHaveLength(1);
    expect(saved[0].state).toBe(state);
    expect(JSON.parse(saved[0].body)).toEqual({
      content: "local change",
      if_updated_at: "revision-1",
    });
  });
}

test("connection loss after dispatch becomes unknown, not an automatic second write", async ({
  page,
}) => {
  await setup(page);
  let writes = 0;
  await page.route("**/api/notes/**", (route) => {
    writes++;
    return route.abort("failed");
  });
  await queue(page);
  await flush(page);
  await flush(page);
  expect(writes).toBe(1);
  expect((await rows(page))[0].state).toBe("unknown");
});

test("legacy unscoped records are quarantined without replay", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("prism-web", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("outbox", {
            keyPath: "id",
            autoIncrement: true,
          });
        request.onsuccess = () => {
          const tx = request.result.transaction("outbox", "readwrite");
          tx.objectStore("outbox").add({
            method: "PATCH",
            path: "/notes/n1",
            body: '{"content":"older draft"}',
            queuedAt: 1,
          });
          tx.oncomplete = () => {
            request.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await flush(page);
  const saved = await rows(page);
  expect(saved).toHaveLength(1);
  expect(saved[0].state).toBe("quarantined");
});

test("a reviewed conflict uses the reviewed revision instead of force", async ({
  page,
}) => {
  await setup(page);
  let calls = 0;
  let applied: unknown;
  await page.route("**/api/notes/**", (route) => {
    calls++;
    applied = route.request().postDataJSON();
    return route.fulfill({
      status: calls === 1 ? 409 : 200,
      json: { id: "n1" },
    });
  });
  await queue(page);
  await flush(page);
  const [saved] = await rows(page);
  await page.evaluate(async (id) => {
    const path = "/src/offline/outbox.ts";
    await (
      await import(path)
    ).resolveConflict(
      id,
      '{"content":"reviewed","force":true}',
      "reviewed-revision",
    );
  }, saved.id);
  expect(applied).toEqual({
    content: "reviewed",
    if_updated_at: "reviewed-revision",
  });
  expect(await rows(page)).toHaveLength(0);
});

test("two tabs cannot both claim a queued operation", async ({
  page,
  context,
}) => {
  await setup(page);
  const second = await context.newPage();
  await setup(second);
  let writes = 0;
  await context.route("**/api/notes/**", (route) => {
    writes++;
    return route.fulfill({ json: { id: "n1" } });
  });
  await queue(page);
  await Promise.all([flush(page), flush(second)]);
  expect(writes).toBe(1);
  expect(await rows(page)).toHaveLength(0);
});

test("an offline create resolves dependent note IDs before replay", async ({
  page,
}) => {
  await setup(page);
  const paths: string[] = [];
  await page.route("**/api/notes**", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: { id: "real-note", updatedAt: "created-revision" },
    });
  });
  await queue(
    page,
    "POST",
    "/notes",
    { content: "new note", if_updated_at: "" },
    { temporaryId: "offline-local" },
  );
  await queue(page, "PATCH", "/notes/offline-local", {
    content: "continued draft",
    if_updated_at: "created-revision",
  });
  await flush(page);
  expect(paths).toEqual(["/api/notes", "/api/notes/real-note"]);
  expect(await rows(page)).toHaveLength(0);
});

test("unguarded content replacement is retained for review", async ({
  page,
}) => {
  await setup(page);
  await queue(page, "PATCH", "/notes/n1", {
    content: "unsaved",
    if_updated_at: "",
  });
  await flush(page);
  expect((await rows(page))[0].state).toBe("conflict");
});

test("offline-created notes remain readable after reload with later local edits", async ({
  page,
}) => {
  await setup(page);
  await queue(
    page,
    "POST",
    "/notes",
    { content: "first draft", if_updated_at: "" },
    { temporaryId: "offline-local" },
  );
  await queue(page, "PATCH", "/notes/offline-local", {
    content: "continued writing",
    if_updated_at: "",
  });
  await page.reload();
  await page.evaluate(async () => {
    const path = "/src/config.ts";
    await (await import(path)).fetchMe();
  });
  const draft = await page.evaluate(async () => {
    const path = "/src/parachute/rest.ts";
    return (await import(path)).getNote("offline-local");
  });
  expect(draft.content).toBe("continued writing");
  expect(draft.id).toBe("offline-local");
});

test("recovery shows an actual conflict, requires review, and applies a guarded change", async ({
  page,
}) => {
  await setup(page);
  let writes = 0;
  await page.route("**/api/notes/n1", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          id: "n1",
          content: "Another collaborator's edit",
          updatedAt: "review-version",
        },
      });
    writes++;
    if (writes === 2)
      expect(route.request().postDataJSON()).toEqual({
        content: "local change",
        if_updated_at: "review-version",
      });
    return route.fulfill({
      status: writes === 1 ? 409 : 200,
      json: { id: "n1" },
    });
  });
  await queue(page);
  await flush(page);
  await page.evaluate(async () => {
    const path = "/e2e-fixtures/recovery.tsx";
    await import(path);
  });
  await page
    .getByRole("button", { name: "1 saved change needs review" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Saved changes" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review against current note" })
    .click();
  await expect(
    page.getByText("Another collaborator's edit", { exact: false }),
  ).toBeVisible();
  const apply = page.getByRole("button", { name: "Apply reviewed change" });
  await expect(apply).toBeDisabled();
  await page.getByRole("checkbox").check();
  await apply.click();
  await expect(
    page.getByText("No pending changes for this account and workspace."),
  ).toBeVisible();
  expect(writes).toBe(2);
});

test("an account's cached note is never used as another account's offline fallback", async ({
  page,
  context,
}) => {
  let email = "owner@test.local";
  await setup(page, () => email);
  await page.route("**/api/notes/n1", (route) =>
    route.fulfill({
      json: {
        id: "n1",
        content: "first account's private draft",
        updatedAt: "r1",
      },
    }),
  );
  await page.evaluate(async () => {
    const path = "/src/parachute/rest.ts";
    await (await import(path)).getNote("n1");
  });
  email = "second@test.local";
  await page.evaluate(async () => {
    const path = "/src/config.ts";
    await (await import(path)).fetchMe();
  });
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    const path = "/src/parachute/rest.ts";
    try {
      return (await (await import(path)).getNote("n1")).content;
    } catch {
      return "no cached note";
    }
  });
  expect(result).toBe("no cached note");
});
