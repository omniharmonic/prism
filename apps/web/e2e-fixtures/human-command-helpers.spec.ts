import { test, expect } from "@playwright/test";
const url = "/e2e-fixtures/human-command-helpers.html";
const command = {
  kind: "suggest",
  requestId: "11111111-1111-4111-8111-111111111111",
  createdAt: Date.now(),
  revision: "a".repeat(64),
  from: 1,
  to: 6,
  quote: "Alpha",
  text: "Better",
};
const body = JSON.stringify(command);
async function ready(page: import("@playwright/test").Page, path = url) {
  await page.goto(path);
  await expect(page.locator(".tiptap")).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => (window as any).humanFixture.html()))
    .toContain("<p>");
}

test("real read-only editor captures explicit range/boundary positions without modifying content", async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).humanFixture;
    const before = f.html();
    f.select(1, 6);
    const a = await f.capture("replace"),
      b = await f.capture("before"),
      c = await f.capture("after");
    return {
      before,
      after: f.html(),
      replace: { from: a.from, to: a.to, quote: a.quote },
      insertBefore: {
        from: b.from,
        to: b.to,
        quote: b.quote,
        original: b.originalQuote,
      },
      insertAfter: { from: c.from, to: c.to },
      revision: a.revision,
      current: await f.revision(),
    };
  });
  expect(result.before).toBe(result.after);
  expect(result.replace).toEqual({ from: 1, to: 6, quote: "Alpha" });
  expect(result.insertBefore).toEqual({
    from: 1,
    to: 1,
    quote: "",
    original: "Alpha",
  });
  expect(result.insertAfter).toEqual({ from: 6, to: 6 });
  expect(result.revision).toBe(result.current);
  await expect(page.locator(".tiptap")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  const problem = await page.evaluate(async () => {
    const f = (window as any).humanFixture;
    f.select(3);
    try {
      await f.capture("before");
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(problem).toContain("Select text first");
});

test("selection validation refuses cross-block, code, hardbreak and pending suggestion ranges", async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const f = (window as any).humanFixture;
    const doc = f.json();
    let pos = 0;
    const blocks = doc.content.map((n: any) => {
      const start = pos + 1;
      const length = (n.content ?? []).reduce(
        (sum: number, c: any) => sum + (c.text?.length ?? 1),
        0,
      );
      pos += length + 2;
      return { start, end: start + length };
    });
    return {
      cross: f.problem(blocks[0].start, blocks[1].end),
      code: f.problem(blocks[2].start, blocks[2].end),
      br: f.problem(blocks[3].start, blocks[3].end),
      pending: f.problem(blocks[4].start, blocks[4].end),
    };
  });
  expect(result.cross).toContain("one paragraph");
  expect(result.code).toContain("inline code");
  expect(result.br).toContain("line breaks");
  expect(result.pending).toContain("pending suggestion");
});

test("seeded empty document has an explicit insertion position and comments change revision", async ({
  page,
}) => {
  await ready(page, url + "?empty");
  const result = await page.evaluate(async () => {
    const f = (window as any).humanFixture;
    const anchor = await f.capture("empty");
    f.comment();
    return {
      from: anchor.from,
      to: anchor.to,
      quote: anchor.quote,
      changed: anchor.revision !== (await f.revision()),
      space: f.suggestionTextProblem(anchor, " leading"),
    };
  });
  expect(result).toMatchObject({ from: 1, to: 1, quote: "", changed: true });
  expect(result.space).toContain("edge space");
});

test("text and strict payload validation preserve Unicode, reject unsupported text and never accept author fields", async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate((body) => {
    const f = (window as any).humanFixture;
    return {
      invalid: [
        "a\nb",
        "a\tb",
        "a  b",
        " ",
        String.fromCharCode(0xd800),
        "a\u0001b",
      ].map((t) => f.textProblem(t, "suggest")),
      unicode: f.textProblem("Café 🌈", "suggest"),
      comment: f.textProblem("Line one\n\tLine two", "comment"),
      valid: !!f.parseHumanCommand(body),
      spoof: f.parseHumanCommand(
        JSON.stringify({ ...JSON.parse(body), author: "Admin" }),
      ),
      tooLong: f.parseHumanCommand(
        JSON.stringify({
          ...JSON.parse(body),
          kind: "comment",
          text: "x".repeat(4001),
        }),
      ),
    };
  }, body);
  expect(result.invalid.every(Boolean)).toBe(true);
  expect(result.unicode).toBeNull();
  expect(result.comment).toBeNull();
  expect(result.valid).toBe(true);
  expect(result.spoof).toBeNull();
  expect(result.tooLong).toBeNull();
});

test("receipt survives reload byte-for-byte, cannot be replaced, and clears only its own body", async ({
  page,
}) => {
  await ready(page);
  const spaced = JSON.stringify(command, null, 2);
  await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    await f.reserve(f.receiptKey, { version: 1, body });
  }, spaced);
  await page.reload();
  await expect(page.locator(".tiptap")).toHaveCount(1);
  const result = await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    const a = f.read(f.receiptKey);
    const b = await f.reserve(f.receiptKey, { version: 1, body });
    const wrong = await f.clear(f.receiptKey, { version: 1, body });
    return { a, b, wrong };
  }, body);
  expect(result.a.receipt.body).toBe(spaced);
  expect(result.b.receipt.body).toBe(spaced);
  expect(result.wrong).toBe(false);
  await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    await f.clear(f.receiptKey, { version: 1, body });
  }, spaced);
  expect(
    await page.evaluate(() => {
      const f = (window as any).humanFixture;
      return f.read(f.receiptKey).receipt;
    }),
  ).toBeNull();
});

test("simultaneous windows reserve only one request and external clear cannot resurrect an in-memory copy", async ({
  page,
  context,
}) => {
  await ready(page);
  const second = await context.newPage();
  await ready(second);
  const other = JSON.stringify({
    ...command,
    requestId: "22222222-2222-4222-8222-222222222222",
  });
  const reserve = (p: typeof page, b: string) =>
    p.evaluate(async (body) => {
      const f = (window as any).humanFixture;
      return f.reserve(f.receiptKey, { version: 1, body });
    }, b);
  const [a, b] = await Promise.all([
    reserve(page, body),
    reserve(second, other),
  ]);
  expect(a.receipt.body).toBe(b.receipt.body);
  await second.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    await f.clear(f.receiptKey, { version: 1, body });
  }, a.receipt.body);
  expect(
    await page.evaluate(() => {
      const f = (window as any).humanFixture;
      return f.read(f.receiptKey).receipt;
    }),
  ).toBeNull();
});

test("storage denial and missing locks block new submissions and keep exact recovery bytes available", async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw Error("denied");
    };
    const value = await f.reserve(f.receiptKey, { version: 1, body });
    Storage.prototype.setItem = set;
    return value;
  }, body);
  expect(result.blocked).toBe(true);
  expect(result.receipt.body).toBe(body);
  await page.reload();
  await expect(page.locator(".tiptap")).toHaveCount(1);
  const noLocks = await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    });
    return f.reserve(f.receiptKey, { version: 1, body });
  }, body);
  expect(noLocks.blocked).toBe(true);
  expect(noLocks.receipt).toBeNull();
});

test("transport keeps unavailable identity closed and sends exact bytes with capability plus normal authentication", async ({
  page,
}) => {
  await ready(page);
  await page.context().addCookies([
    {
      name: "fixture_session",
      value: "fictional-cookie",
      url: new URL(page.url()).origin,
    },
  ]);
  let count = 0;
  let sent = "";
  let headers: Record<string, string> = {};
  let query = "";
  await page.route("**/api/collab/**", async (route) => {
    count++;
    sent = route.request().postData()!;
    headers = await route.request().allHeaders();
    query = new URL(route.request().url()).searchParams.get("t") ?? "";
    await route.fulfill({
      json: {
        requestId: command.requestId,
        kind: "suggest",
        suggestionId: "suggestion_1",
      },
    });
  });
  const unavailable = await page.evaluate(async (body) => {
    try {
      await (window as any).humanFixture.send(body);
    } catch (e) {
      return (e as any).code;
    }
  }, body);
  expect(unavailable).toBe("identity_unavailable");
  expect(count).toBe(0);
  await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    f.setAudience();
    await f.send(body);
  }, body);
  expect(sent).toBe(body);
  expect(query).toBe("fixture-link-token");
  expect(headers.authorization).toBeUndefined();
  expect(
    await page.evaluate(() => (window as any).humanFixture.credentials),
  ).toBe("include");
  expect(
    (await page.context().cookies(page.url())).some(
      (cookie) => cookie.name === "fixture_session",
    ),
  ).toBe(true);
  // WebKit does not expose its final Cookie header on intercepted fixture requests.
  if (headers.cookie)
    expect(headers.cookie).toContain("fixture_session=fictional-cookie");
  expect(headers["x-prism-vault"]).toBe("fixture-vault");
  expect(headers["x-prism-workspace"]).toBe("fixture-workspace");
  expect(count).toBe(1);
});

test("uncertain responses preserve classification and middleware rate limit has useful fallback", async ({
  page,
}) => {
  await ready(page);
  let scenario = "lost";
  await page.route("**/api/collab/**", async (route) => {
    if (scenario === "lost") return route.abort();
    if (scenario === "malformed")
      return route.fulfill({
        json: { kind: "suggest", requestId: "wrong", suggestionId: "x" },
      });
    if (scenario === "rate")
      return route.fulfill({
        status: 429,
        headers: { "Retry-After": "5" },
        json: { error: "rate_limited", retryAfter: 5 },
      });
    return route.fulfill({
      status: 503,
      json: { error: "not_confirmed", message: "Not durable yet", retry: true },
    });
  });
  await page.evaluate(() => (window as any).humanFixture.setAudience());
  const send = () =>
    page.evaluate(async (body) => {
      try {
        await (window as any).humanFixture.send(body);
        return null;
      } catch (e) {
        const x = e as any;
        return {
          code: x.code,
          outcome: x.outcome,
          message: x.message,
          retryAt: x.retryAt,
        };
      }
    }, body);
  expect((await send())?.outcome).toBe("unknown");
  scenario = "malformed";
  expect((await send())?.code).toBe("invalid_response");
  scenario = "save";
  expect(await send()).toMatchObject({
    code: "not_confirmed",
    outcome: "unknown",
    message: "Not durable yet",
  });
  scenario = "rate";
  const rate = await send();
  expect(rate?.code).toBe("rate_limited");
  expect(rate?.retryAt).toBeGreaterThan(Date.now());
  expect(rate?.message).toContain("Wait");
});

test("audience changes before dispatch and during response suppress writes or late confirmation", async ({
  page,
}) => {
  await ready(page);
  let requests = 0;
  await page.route("**/api/collab/**", async (route) => {
    requests++;
    await page.evaluate(() => {
      (window as any).humanFixture.audience.audience.actorId = "h_other";
    });
    await route.fulfill({
      json: {
        requestId: command.requestId,
        kind: "suggest",
        suggestionId: "x",
      },
    });
  });
  const before = await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    f.setAudience();
    f.refresh = async () => null;
    try {
      await f.send(body);
    } catch (e) {
      return (e as any).outcome;
    }
  }, body);
  expect(before).toBe("not-sent");
  expect(requests).toBe(0);
  const after = await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    f.setAudience();
    f.refresh = null;
    try {
      await f.send(body);
    } catch (e) {
      return (e as any).outcome;
    }
  }, body);
  expect(after).toBe("unknown");
  expect(requests).toBe(1);
});

test("a dropped response followed by reload resends exactly the original durable bytes", async ({
  page,
}) => {
  await ready(page);
  const sent: string[] = [];
  let fail = true;
  await page.route("**/api/collab/**", async (route) => {
    sent.push(route.request().postData()!);
    if (fail) return route.abort();
    return route.fulfill({
      json: {
        requestId: command.requestId,
        kind: "suggest",
        suggestionId: "confirmed_after_reload",
      },
    });
  });
  const spaced = JSON.stringify(command, null, 2);
  await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    f.setAudience();
    await f.reserve(f.receiptKey, { version: 1, body });
    try {
      await f.send(body);
    } catch {
      /* unknown outcome stays recorded */
    }
  }, spaced);
  await ready(page);
  fail = false;
  const result = await page.evaluate(async () => {
    const f = (window as any).humanFixture;
    f.setAudience();
    const receipt = f.read(f.receiptKey).receipt;
    const result = await f.send(receipt.body);
    await f.clear(f.receiptKey, receipt);
    return result;
  });
  expect(sent).toEqual([spaced, spaced]);
  expect(result.suggestionId).toBe("confirmed_after_reload");
});

test("malformed recovery blocks replacement and another audience never sees the saved receipt", async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async (body) => {
    const f = (window as any).humanFixture;
    await f.reserve(f.receiptKey, { version: 1, body });
    const other = f.read(f.receiptKey + "other");
    localStorage.setItem(f.receiptKey, "broken-record");
    const blocked = await f.reserve(f.receiptKey, { version: 1, body });
    return { other, blocked, raw: localStorage.getItem(f.receiptKey) };
  }, body);
  expect(result.other.receipt).toBeNull();
  expect(result.blocked.blocked).toBe(true);
  expect(result.raw).toBe("broken-record");
});

test("thread command receipts require matching kind, target and confirmed item ids", async ({
  page,
}) => {
  await ready(page);
  let mismatch = true;
  await page.route("**/api/collab/**", async (route) => {
    const request = route.request().postDataJSON();
    await route.fulfill({
      json: {
        requestId: request.requestId,
        kind: request.kind,
        threadId: mismatch ? "other_thread" : request.threadId,
        commentId: "comment_id",
        resolved: request.resolved,
      },
    });
  });
  const request = JSON.stringify({
    kind: "reply",
    requestId: command.requestId,
    createdAt: command.createdAt,
    revision: command.revision,
    threadId: "thread_id",
    text: "A reply",
  });
  const send = () =>
    page.evaluate(async (body) => {
      const f = (window as any).humanFixture;
      f.setAudience();
      try {
        return { result: await f.send(body) };
      } catch (e) {
        return { error: (e as any).code };
      }
    }, request);
  expect(await send()).toEqual({ error: "invalid_response" });
  mismatch = false;
  expect((await send()).result).toMatchObject({
    threadId: "thread_id",
    commentId: "comment_id",
  });
});

test("capture keeps the original selection and revision inputs across asynchronous hashing", async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).humanFixture;
    f.select(1, 6);
    const expected = f.revision();
    const capture = f.capture("replace");
    f.select(7, 11);
    f.comment();
    const anchor = await capture;
    return {
      from: anchor.from,
      to: anchor.to,
      quote: anchor.quote,
      revision: anchor.revision,
      expected: await expected,
      current: await f.revision(),
    };
  });
  expect(result).toMatchObject({ from: 1, to: 6, quote: "Alpha" });
  expect(result.revision).toBe(result.expected);
  expect(result.revision).not.toBe(result.current);
});
