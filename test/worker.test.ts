import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { app, scheduled, type Bindings } from "../src/worker";

const migrationPath = fileURLToPath(new URL("../migrations/0001_events.sql", import.meta.url));
const eventScriptPath = fileURLToPath(new URL("../public/event.js", import.meta.url));
const stylesPath = fileURLToPath(new URL("../public/styles.css", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const origin = "http://localhost";
const sessions = [
  "a2d0e2f2-66fd-4fd4-8e87-b0ef67ad194a",
  "b3d0e2f2-66fd-4fd4-8e87-b0ef67ad194b",
  "c4d0e2f2-66fd-4fd4-8e87-b0ef67ad194c",
  "d5d0e2f2-66fd-4fd4-8e87-b0ef67ad194d",
  "e6d0e2f2-66fd-4fd4-8e87-b0ef67ad194e",
  "f7d0e2f2-66fd-4fd4-8e87-b0ef67ad194f",
  "a8d0e2f2-66fd-4fd4-8e87-b0ef67ad1940",
  "b9d0e2f2-66fd-4fd4-8e87-b0ef67ad1941",
];

let miniflare: Miniflare;
let bindings: Bindings;

const headers = (session = sessions[0], key = "", qa = false) => ({
  "content-type": "application/json",
  origin,
  "x-atsumari-key": key,
  "x-atsumari-qa": qa ? "1" : "0",
  "x-atsumari-session": session,
});

const validGathering = (overrides: Record<string, unknown> = {}) => {
  const current = Math.floor(Date.now() / 1000);
  return {
    capacity: 8,
    deadlineAt: current + 3600,
    endsAt: current + 10_800,
    showNames: true,
    startsAt: current + 7200,
    summary: "入口で受付札を受け取ってください。",
    title: "西町の小さな交流会",
    venue: "西町集会室",
    website: "",
    ...overrides,
  };
};

const keyFromUrl = (url: string) =>
  new URLSearchParams(new URL(url, origin).hash.slice(1)).get("key") ?? "";

const createGathering = async (
  overrides: Record<string, unknown> = {},
  session = sessions[0],
  qa = false,
) => {
  const response = await app.request(
    "/api/gatherings",
    {
      body: JSON.stringify(validGathering(overrides)),
      headers: headers(session, "", qa),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ id: string; manageUrl: string; publicUrl: string }>();
  return { ...body, organizerKey: keyFromUrl(body.manageUrl) };
};

const respond = async (
  gatheringId: string,
  sessionIndex: number,
  overrides: Record<string, unknown> = {},
  qa = false,
) => {
  const response = await app.request(
    `/api/gatherings/${gatheringId}/respond`,
    {
      body: JSON.stringify({
        choice: "attending",
        displayName: `参加者${sessionIndex}`,
        note: "",
        partySize: 1,
        website: "",
        ...overrides,
      }),
      headers: headers(sessions[sessionIndex], "", qa),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ choice: string; id: string; replyUrl: string }>();
  return { ...body, key: keyFromUrl(body.replyUrl) };
};

beforeEach(async () => {
  miniflare = new Miniflare({
    d1Databases: { DB: "atsumari-guchi-test" },
    modules: true,
    script: "export default { fetch() { return new Response('test') } }",
  });
  const database = await miniflare.getD1Database("DB");
  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run();
  }
  bindings = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DB: database as unknown as D1Database,
  };
});

afterEach(async () => miniflare.dispose());

describe("public pages", () => {
  it.each([
    ["/", 'class="entrance-preview"', "https://atsumari-guchi.yhay81.com/"],
    ["/guide", 'class="guide-cards"', "https://atsumari-guchi.yhay81.com/guide"],
    ["/privacy", 'class="data-grid"', "https://atsumari-guchi.yhay81.com/privacy"],
  ])("%s returns a product-specific surface", async (path, marker, canonical) => {
    const response = await app.request(path, undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(marker);
    expect(html).toContain(`href="${canonical}" rel="canonical"`);
    expect(html).toContain("集まり口");
    expect(html).not.toMatch(/仮説|成功条件|市場スコア/u);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("publishes only the three indexable pages", async () => {
    const response = await app.request("/sitemap.xml", undefined, bindings);
    const xml = await response.text();
    expect(response.status).toBe(200);
    expect(xml.match(/<loc>/gu)).toHaveLength(3);
    expect(xml).not.toContain("/e/");
    expect(await (await app.request("/health", undefined, bindings)).json()).toEqual({ ok: true });
  });

  it("marks unlisted gathering screens noindex", async () => {
    const gathering = await createGathering();
    const response = await app.request(`/e/${gathering.id}`, undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('content="noindex,nofollow" name="robots"');
    expect(html).toContain('data-mode="event"');
  });
});

describe("gathering flow", () => {
  it("creates an unlisted event without leaking the organizer key", async () => {
    const gathering = await createGathering();
    const publicResponse = await app.request(
      `/api/gatherings/${gathering.id}`,
      undefined,
      bindings,
    );
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).not.toContain(gathering.organizerKey);
    const denied = await app.request(
      `/api/gatherings/${gathering.id}/manage`,
      { headers: headers() },
      bindings,
    );
    expect(denied.status).toBe(403);
    const allowed = await app.request(
      `/api/gatherings/${gathering.id}/manage`,
      { headers: headers(sessions[0], gathering.organizerKey) },
      bindings,
    );
    expect(allowed.status).toBe(200);
  });

  it("waitlists overflow and promotes the first party after space opens", async () => {
    const gathering = await createGathering({ capacity: 2 });
    const first = await respond(gathering.id, 1, { displayName: "青木", partySize: 2 });
    const second = await respond(gathering.id, 2, { displayName: "加藤", partySize: 1 });
    expect(first.choice).toBe("attending");
    expect(second.choice).toBe("waitlisted");

    const changed = await app.request(
      `/api/gatherings/${gathering.id}/respond`,
      {
        body: JSON.stringify({
          choice: "interested",
          displayName: "青木",
          note: "",
          partySize: 2,
          website: "",
        }),
        headers: headers(sessions[1], first.key),
        method: "PATCH",
      },
      bindings,
    );
    expect(changed.status).toBe(200);
    const promoted = await app.request(
      `/api/gatherings/${gathering.id}/reply`,
      { headers: headers(sessions[2], second.key) },
      bindings,
    );
    expect(await promoted.json()).toMatchObject({ reply: { choice: "attending" } });
  });

  it("does not let a later smaller party jump the waitlist", async () => {
    const gathering = await createGathering({ capacity: 4 });
    await respond(gathering.id, 1, { displayName: "先着参加", partySize: 3 });
    await respond(gathering.id, 2, { displayName: "先着待ち", partySize: 2 });
    const later = await respond(gathering.id, 3, { displayName: "後着少人数", partySize: 1 });
    expect(later.choice).toBe("waitlisted");
  });

  it("can hide participant names from the public roster", async () => {
    const gathering = await createGathering({ showNames: false });
    await respond(gathering.id, 1, { displayName: "公開しない名前" });
    const state = await (
      await app.request(`/api/gatherings/${gathering.id}`, undefined, bindings)
    ).json<{ responses: unknown[] }>();
    expect(state.responses).toEqual([]);
    const managed = await (
      await app.request(
        `/api/gatherings/${gathering.id}/manage`,
        { headers: headers(sessions[0], gathering.organizerKey) },
        bindings,
      )
    ).json<{ roster: Array<{ displayName: string }> }>();
    expect(managed.roster[0].displayName).toBe("公開しない名前");
  });

  it("prevents duplicate sessions, duplicate names, and contact details", async () => {
    const gathering = await createGathering();
    await respond(gathering.id, 1, { displayName: "青葉" });
    const duplicateSession = await app.request(
      `/api/gatherings/${gathering.id}/respond`,
      {
        body: JSON.stringify({
          choice: "attending",
          displayName: "別名",
          note: "",
          partySize: 1,
          website: "",
        }),
        headers: headers(sessions[1]),
        method: "POST",
      },
      bindings,
    );
    expect(duplicateSession.status).toBe(409);
    const duplicateName = await app.request(
      `/api/gatherings/${gathering.id}/respond`,
      {
        body: JSON.stringify({
          choice: "attending",
          displayName: "青葉",
          note: "",
          partySize: 1,
          website: "",
        }),
        headers: headers(sessions[2]),
        method: "POST",
      },
      bindings,
    );
    expect(duplicateName.status).toBe(409);
    const contact = await app.request(
      `/api/gatherings/${gathering.id}/respond`,
      {
        body: JSON.stringify({
          choice: "attending",
          displayName: "user@example.com",
          note: "",
          partySize: 1,
          website: "",
        }),
        headers: headers(sessions[3]),
        method: "POST",
      },
      bindings,
    );
    expect(contact.status).toBe(400);
  });

  it("lets the organizer update notices and close registration", async () => {
    const gathering = await createGathering();
    const denied = await app.request(
      `/api/gatherings/${gathering.id}/manage`,
      {
        body: JSON.stringify({ notice: "入口が変わりました" }),
        headers: headers(sessions[0], "0".repeat(64)),
        method: "PATCH",
      },
      bindings,
    );
    expect(denied.status).toBe(403);
    const notice = await app.request(
      `/api/gatherings/${gathering.id}/manage`,
      {
        body: JSON.stringify({ notice: "入口が変わりました" }),
        headers: headers(sessions[0], gathering.organizerKey),
        method: "PATCH",
      },
      bindings,
    );
    expect(notice.status).toBe(200);
    const closed = await app.request(
      `/api/gatherings/${gathering.id}/manage`,
      {
        body: JSON.stringify({ status: "closed" }),
        headers: headers(sessions[0], gathering.organizerKey),
        method: "PATCH",
      },
      bindings,
    );
    expect(closed.status).toBe(200);
  });

  it("withdraws a reply and promotes the waitlist", async () => {
    const gathering = await createGathering({ capacity: 2 });
    const first = await respond(gathering.id, 1, { displayName: "先着", partySize: 2 });
    const second = await respond(gathering.id, 2, { displayName: "待機", partySize: 2 });
    const withdrawn = await app.request(
      `/api/gatherings/${gathering.id}/withdraw`,
      { headers: headers(sessions[1], first.key), method: "POST" },
      bindings,
    );
    expect(withdrawn.status).toBe(200);
    const reply = await (
      await app.request(
        `/api/gatherings/${gathering.id}/reply`,
        { headers: headers(sessions[2], second.key) },
        bindings,
      )
    ).json<{ reply: { choice: string } }>();
    expect(reply.reply.choice).toBe("attending");
  });
});

describe("safety and exports", () => {
  it("protects spreadsheet formulas and exposes organizer-only exports", async () => {
    const gathering = await createGathering();
    await respond(gathering.id, 1, {
      displayName: "=SUM(A1:A2)",
      note: "-not-a-formula",
    });
    const denied = await app.request(
      `/api/gatherings/${gathering.id}/roster.csv`,
      { headers: headers() },
      bindings,
    );
    expect(denied.status).toBe(403);
    const allowed = await app.request(
      `/api/gatherings/${gathering.id}/roster.csv`,
      { headers: headers(sessions[0], gathering.organizerKey) },
      bindings,
    );
    const csv = await allowed.text();
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-disposition")).toContain("atsumari-");
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).toContain("'-not-a-formula");

    const json = await app.request(
      `/api/gatherings/${gathering.id}/roster.json`,
      { headers: headers(sessions[0], gathering.organizerKey) },
      bindings,
    );
    expect(json.status).toBe(200);
  });

  it("provides a valid calendar file without requiring a key", async () => {
    const gathering = await createGathering();
    const response = await app.request(
      `/api/gatherings/${gathering.id}/event.ics`,
      undefined,
      bindings,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/calendar");
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain(`UID:${gathering.id}@atsumari-guchi.yhay81.com`);
  });

  it("hides an event after three distinct safety reports", async () => {
    const gathering = await createGathering();
    for (let index = 1; index <= 3; index += 1) {
      const response = await app.request(
        `/api/gatherings/${gathering.id}/report`,
        {
          body: JSON.stringify({ reason: "unsafe" }),
          headers: headers(sessions[index]),
          method: "POST",
        },
        bindings,
      );
      expect(response.status).toBe(202);
    }
    const hidden = await app.request(`/api/gatherings/${gathering.id}`, undefined, bindings);
    expect(hidden.status).toBe(404);
  });

  it("rejects cross-origin mutations, honeypots, and unknown telemetry", async () => {
    const crossOrigin = await app.request(
      "/api/gatherings",
      {
        body: JSON.stringify(validGathering()),
        headers: { ...headers(), origin: "https://evil.example" },
        method: "POST",
      },
      bindings,
    );
    expect(crossOrigin.status).toBe(403);
    const honeypot = await app.request(
      "/api/gatherings",
      {
        body: JSON.stringify(validGathering({ website: "bot" })),
        headers: headers(),
        method: "POST",
      },
      bindings,
    );
    expect(honeypot.status).toBe(400);
    const telemetry = await app.request(
      "/api/telemetry",
      {
        body: JSON.stringify({ name: "display_name" }),
        headers: headers(),
        method: "POST",
      },
      bindings,
    );
    expect(telemetry.status).toBe(400);
  });

  it("keeps QA telemetry separate from real-user metrics", async () => {
    await createGathering({}, sessions[0], true);
    const rows = await bindings.DB.prepare(
      "SELECT is_qa, COUNT(*) AS count FROM product_events GROUP BY is_qa ORDER BY is_qa",
    ).all<{ count: number; is_qa: number }>();
    expect(rows.results).toEqual([{ count: 1, is_qa: 1 }]);
  });

  it("limits one session to three event creations per day", async () => {
    await createGathering();
    await createGathering();
    await createGathering();
    const response = await app.request(
      "/api/gatherings",
      {
        body: JSON.stringify(validGathering()),
        headers: headers(),
        method: "POST",
      },
      bindings,
    );
    expect(response.status).toBe(429);
  });

  it("removes expired events and old telemetry on schedule", async () => {
    const gathering = await createGathering();
    await bindings.DB.prepare("UPDATE gatherings SET expires_at = 1 WHERE id = ?")
      .bind(gathering.id)
      .run();
    await bindings.DB.prepare("UPDATE product_events SET created_at = 1").run();
    await scheduled({} as ScheduledEvent, bindings, {} as ExecutionContext);
    expect(
      await bindings.DB.prepare("SELECT id FROM gatherings WHERE id = ?")
        .bind(gathering.id)
        .first(),
    ).toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM product_events").first()).toBeNull();
  });

  it("keeps the static release surface free of unsafe rendering and giant type", async () => {
    const [eventScript, styles, wrangler] = await Promise.all([
      readFile(eventScriptPath, "utf8"),
      readFile(stylesPath, "utf8"),
      readFile(wranglerPath, "utf8"),
    ]);
    expect(eventScript).not.toMatch(/innerHTML|eval\(|new Function/u);
    expect(styles).not.toMatch(/gradient/iu);
    expect(wrangler).not.toContain("TO_BE_CREATED");
  });
});
