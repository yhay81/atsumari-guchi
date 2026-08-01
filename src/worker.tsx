import { Hono } from "hono";
import type { Context } from "hono";
import { requestId } from "hono/request-id";

import {
  chooseWaitlistPromotions,
  countAttendingSeats,
  resolveRequestedChoice,
  type AttendanceChoice,
  type AttendanceRecord,
} from "./domain/attendance";

export type Bindings = {
  ASSETS: Fetcher;
  DB: D1Database;
};

type Variables = { requestId: string };
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type GatheringStatus = "cancelled" | "closed" | "hidden" | "open";

type GatheringRow = {
  capacity: number;
  created_at: number;
  creator_session_id: string;
  deadline_at: number;
  ends_at: number;
  expires_at: number;
  id: string;
  notice: string;
  organizer_token_hash: string;
  show_names: number;
  starts_at: number;
  status: GatheringStatus;
  summary: string;
  title: string;
  updated_at: number;
  venue: string;
};

type ResponseRow = {
  choice: AttendanceChoice;
  created_at: number;
  display_name: string;
  display_name_key: string;
  gathering_id: string;
  id: string;
  note: string;
  party_size: number;
  session_id: string;
  token_hash: string;
  updated_at: number;
};

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 429,
  ) {
    super(code);
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const canonicalOrigin = "https://atsumari-guchi.yhay81.com";
const idPattern = /^[0-9a-f]{32}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/iu;
const phonePattern = /(?:\+?81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/u;
const linkPattern = /(?:https?:\/\/|www\.)/iu;
const reportReasons = new Set(["other", "spam", "unsafe"]);
const responseChoices = new Set(["attending", "declined", "interested"]);
export const telemetryNames = new Set([
  "visited",
  "gathering_created",
  "response_added",
  "response_updated",
  "waitlist_joined",
  "waitlist_promoted",
  "roster_exported",
  "calendar_saved",
  "public_gathering_viewed",
  "returned",
]);

const statusLabels: Record<GatheringStatus, string> = {
  cancelled: "中止",
  closed: "受付終了",
  hidden: "非表示",
  open: "受付中",
};

const choiceLabels: Record<AttendanceChoice, string> = {
  attending: "参加",
  declined: "不参加",
  interested: "興味あり",
  waitlisted: "キャンセル待ち",
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const jstDay = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const randomHex = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const enforceSameOrigin = (c: AppContext) => {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw new ApiError("cross_site_request", 403);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    throw new ApiError("cross_site_request", 403);
  }
};

const parseJson = async (c: AppContext, maximumBytes = 4096) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError("unsupported_media_type", 415);
  }
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > maximumBytes) throw new ApiError("payload_too_large", 413);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new ApiError("payload_too_large", 413);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("invalid_json", 400);
  }
};

const objectPayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("invalid_request", 400);
  }
  return payload as Record<string, unknown>;
};

const cleanText = (
  payload: Record<string, unknown>,
  key: string,
  maximum: number,
  options: { allowEmpty?: boolean; blockContact?: boolean } = {},
) => {
  if (typeof payload[key] !== "string") throw new ApiError("invalid_" + key, 400);
  const value = payload[key].replace(/\r\n?/gu, "\n").trim();
  if ((!options.allowEmpty && value.length === 0) || value.length > maximum) {
    throw new ApiError("invalid_" + key, 400);
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if ((point < 32 && point !== 9 && point !== 10) || point === 127) {
      throw new ApiError("invalid_" + key, 400);
    }
  }
  if (
    options.blockContact &&
    (emailPattern.test(value) || phonePattern.test(value) || linkPattern.test(value))
  ) {
    throw new ApiError("contact_not_allowed_in_" + key, 400);
  }
  return value;
};

const integerValue = (
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
) => {
  const value = payload[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError("invalid_" + key, 400);
  }
  return value as number;
};

const booleanValue = (payload: Record<string, unknown>, key: string) => {
  if (typeof payload[key] !== "boolean") throw new ApiError("invalid_" + key, 400);
  return payload[key] as boolean;
};

const validateId = (value: string) => {
  if (!idPattern.test(value)) throw new ApiError("not_found", 404);
  return value;
};

const sessionId = (c: AppContext) => {
  const value = c.req.header("x-atsumari-session") ?? "";
  if (!sessionPattern.test(value)) throw new ApiError("invalid_session", 400);
  return value.toLowerCase();
};

const capability = (c: AppContext) => {
  const value = c.req.header("x-atsumari-key") ?? "";
  if (!tokenPattern.test(value)) throw new ApiError("invalid_capability", 403);
  return value;
};

const gatheringById = async (database: D1Database, id: string) => {
  const row = await database
    .prepare("SELECT * FROM gatherings WHERE id = ? AND expires_at > ?")
    .bind(id, nowSeconds())
    .first<GatheringRow>();
  if (!row || row.status === "hidden") throw new ApiError("not_found", 404);
  return row;
};

const organizerGathering = async (c: AppContext, id: string) => {
  const gathering = await gatheringById(c.env.DB, id);
  const suppliedHash = await sha256(capability(c));
  if (!constantTimeEqual(gathering.organizer_token_hash, suppliedHash)) {
    throw new ApiError("invalid_capability", 403);
  }
  return gathering;
};

const ownedResponse = async (c: AppContext, gatheringId: string) => {
  const suppliedHash = await sha256(capability(c));
  const row = await c.env.DB.prepare(
    "SELECT * FROM responses WHERE gathering_id = ? AND token_hash = ?",
  )
    .bind(gatheringId, suppliedHash)
    .first<ResponseRow>();
  if (!row || !constantTimeEqual(row.token_hash, suppliedHash)) {
    throw new ApiError("invalid_capability", 403);
  }
  return row;
};

const recordEvent = async (
  c: AppContext,
  name: string,
  gatheringId: string,
  actorSession?: string,
) => {
  if (!telemetryNames.has(name)) return;
  const actor = actorSession ?? sessionId(c);
  const qa = c.req.header("x-atsumari-qa") === "1" ? 1 : 0;
  await c.env.DB.prepare(
    "INSERT INTO product_events (name,session_id,gathering_id,day,created_at,is_qa) VALUES (?,?,?,?,?,?)",
  )
    .bind(name, actor, gatheringId, jstDay(), nowSeconds(), qa)
    .run();
};

const getResponses = async (database: D1Database, gatheringId: string) => {
  const result = await database
    .prepare("SELECT * FROM responses WHERE gathering_id = ? ORDER BY created_at, id")
    .bind(gatheringId)
    .all<ResponseRow>();
  return result.results;
};

const attendanceRecords = (responses: ResponseRow[]): AttendanceRecord[] =>
  responses.map((response) => ({
    choice: response.choice,
    createdAt: response.created_at,
    id: response.id,
    partySize: response.party_size,
  }));

const countsFrom = (responses: ResponseRow[]) => {
  const counts = {
    attendingGroups: 0,
    attendingSeats: 0,
    declinedGroups: 0,
    interestedGroups: 0,
    waitlistedGroups: 0,
    waitlistedSeats: 0,
  };
  for (const response of responses) {
    if (response.choice === "attending") {
      counts.attendingGroups += 1;
      counts.attendingSeats += response.party_size;
    } else if (response.choice === "interested") {
      counts.interestedGroups += 1;
    } else if (response.choice === "declined") {
      counts.declinedGroups += 1;
    } else {
      counts.waitlistedGroups += 1;
      counts.waitlistedSeats += response.party_size;
    }
  }
  return counts;
};

const publicState = async (database: D1Database, gathering: GatheringRow) => {
  const responses = await getResponses(database, gathering.id);
  return {
    counts: countsFrom(responses),
    gathering: {
      capacity: gathering.capacity,
      deadlineAt: gathering.deadline_at,
      endsAt: gathering.ends_at,
      id: gathering.id,
      notice: gathering.notice,
      showNames: gathering.show_names === 1,
      startsAt: gathering.starts_at,
      status: gathering.status,
      statusLabel: statusLabels[gathering.status],
      summary: gathering.summary,
      title: gathering.title,
      venue: gathering.venue,
    },
    responses:
      gathering.show_names === 1
        ? responses.map((response) => ({
            choice: response.choice,
            choiceLabel: choiceLabels[response.choice],
            displayName: response.display_name,
            partySize: response.party_size,
          }))
        : [],
  };
};

const organizerState = async (database: D1Database, gathering: GatheringRow) => {
  const state = await publicState(database, gathering);
  const responses = await getResponses(database, gathering.id);
  return {
    ...state,
    organizer: true,
    roster: responses.map((response) => ({
      choice: response.choice,
      choiceLabel: choiceLabels[response.choice],
      createdAt: response.created_at,
      displayName: response.display_name,
      id: response.id,
      note: response.note,
      partySize: response.party_size,
      updatedAt: response.updated_at,
    })),
  };
};

const promoteWaitlist = async (c: AppContext, gathering: GatheringRow) => {
  const responses = await getResponses(c.env.DB, gathering.id);
  const promoted = chooseWaitlistPromotions(attendanceRecords(responses), gathering.capacity);
  if (!promoted.length) return [];
  const timestamp = nowSeconds();
  await c.env.DB.batch(
    promoted.map((id) =>
      c.env.DB.prepare(
        "UPDATE responses SET choice = 'attending', updated_at = ? WHERE id = ? AND choice = 'waitlisted'",
      ).bind(timestamp, id),
    ),
  );
  for (const id of promoted) {
    const response = responses.find((item) => item.id === id);
    if (response) await recordEvent(c, "waitlist_promoted", gathering.id, response.session_id);
  }
  return promoted;
};

const Layout = ({
  canonical,
  children,
  description,
  noindex = false,
  script,
  title,
}: {
  canonical: string;
  children: unknown;
  description: string;
  noindex?: boolean;
  script?: string;
  title: string;
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
      <title>{title}</title>
      <meta content={description} name="description" />
      <link href={canonical} rel="canonical" />
      <meta content={noindex ? "noindex,nofollow" : "index,follow"} name="robots" />
      <meta content="website" property="og:type" />
      <meta content={title} property="og:title" />
      <meta content={description} property="og:description" />
      <meta content={canonical} property="og:url" />
      <meta content={canonicalOrigin + "/og.svg"} property="og:image" />
      <meta content="#2c4657" name="theme-color" />
      <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
      <link href="/manifest.webmanifest" rel="manifest" />
      <link href="/styles.css" rel="stylesheet" />
      {script ? <script defer src={script}></script> : null}
    </head>
    <body>
      <a class="skip-link" href="#main">
        本文へ移動
      </a>
      <header class="site-header">
        <a aria-label="集まり口 ホーム" class="brand" href="/">
          <span aria-hidden="true" class="brand-mark">
            <i />
            <i />
          </span>
          <span>集まり口</span>
        </a>
        <nav aria-label="主なページ">
          <a href="/guide">使い方</a>
          <a href="/privacy">データ</a>
        </nav>
      </header>
      {children}
      <footer>
        <span>集まり口</span>
        <span>名前だけで、小さなイベント受付</span>
        <a href="https://github.com/yhay81/atsumari-guchi">GitHub</a>
      </footer>
    </body>
  </html>
);

const EntrancePreview = () => (
  <div aria-label="参加者が受付を通って会場へ入る見本" class="entrance-preview" role="img">
    <div class="venue-board">
      <span>受付中</span>
      <strong>18 / 24</strong>
      <i />
    </div>
    <div class="gate-post left-post">
      <span />
      <span />
    </div>
    <div class="gate-light">
      <i />
      <i />
      <i />
    </div>
    <div class="gate-post right-post">
      <span />
      <span />
    </div>
    <div class="ticket-line">
      <span class="ticket ticket-one">参</span>
      <span class="ticket ticket-two">参</span>
      <span class="ticket ticket-three">興</span>
      <span class="ticket ticket-four">待</span>
    </div>
  </div>
);

const Home = () => (
  <Layout
    canonical={canonicalOrigin + "/"}
    description="Xログインもメール登録もなく、小さなイベントの参加表明、定員、キャンセル待ち、名簿を一つの受付で管理します。"
    script="/app.js"
    title="集まり口｜名前だけのイベント参加受付"
  >
    <main data-page="home" id="main">
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">EVENT ENTRANCE</p>
          <h1>参加まで、迷わせない。</h1>
          <p>
            固定日時の集まりに、名前と人数だけで参加表明。定員、キャンセル待ち、当日の名簿まで同じ入口で整います。
          </p>
          <button class="primary" data-open-create type="button">
            受付をつくる
          </button>
        </div>
        <EntrancePreview />
      </section>

      <section class="flow-strip" aria-label="受付の流れ">
        <article>
          <span class="flow-icon icon-board" />
          <b>案内を置く</b>
          <small>日時・会場・定員</small>
        </article>
        <span class="flow-arrow">→</span>
        <article>
          <span class="flow-icon icon-ticket" />
          <b>名前で答える</b>
          <small>参加・興味・不参加</small>
        </article>
        <span class="flow-arrow">→</span>
        <article>
          <span class="flow-icon icon-roster" />
          <b>名簿を出す</b>
          <small>CSV・JSON・印刷</small>
        </article>
      </section>

      <section class="create-panel" id="create-panel">
        <div class="panel-heading">
          <span class="panel-number">01</span>
          <div>
            <p class="eyebrow">OPEN THE DOOR</p>
            <h2>イベントの受付をつくる</h2>
          </div>
        </div>
        <form data-create-form novalidate>
          <input autocomplete="off" name="website" tabindex={-1} type="text" />
          <div class="form-grid">
            <label class="field field-wide">
              <span>イベント名</span>
              <input maxlength={80} name="title" placeholder="例：土曜のボードゲーム会" required />
            </label>
            <label class="field field-wide">
              <span>会場・集合場所</span>
              <input maxlength={100} name="venue" placeholder="例：市民交流室 A" required />
            </label>
            <label class="field">
              <span>開始</span>
              <input name="startsAt" required type="datetime-local" />
            </label>
            <label class="field">
              <span>終了</span>
              <input name="endsAt" required type="datetime-local" />
            </label>
            <label class="field">
              <span>参加締切</span>
              <input name="deadlineAt" required type="datetime-local" />
            </label>
            <label class="field">
              <span>定員</span>
              <input
                inputmode="numeric"
                max={100}
                min={2}
                name="capacity"
                required
                type="number"
                value="20"
              />
            </label>
            <label class="field field-wide">
              <span>案内</span>
              <textarea
                maxlength={600}
                name="summary"
                placeholder="持ち物、参加費の支払い方法、初参加の方への案内など"
              />
            </label>
            <label class="check-field field-wide">
              <input checked name="showNames" type="checkbox" />
              <span>公開ページに参加者の表示名を出す</span>
            </label>
          </div>
          <div class="form-actions">
            <small>公開検索には載りません。作成後のURLを参加者へ渡してください。</small>
            <button class="primary" type="submit">
              受付を開く
            </button>
          </div>
          <p aria-live="polite" class="form-message" data-form-message />
        </form>
      </section>

      <section class="boundary-row">
        <article>
          <span class="boundary-mark">×</span>
          <div>
            <h2>アカウントなし</h2>
            <p>X、メール、電話番号は集めません。</p>
          </div>
        </article>
        <article>
          <span class="boundary-mark">¥</span>
          <div>
            <h2>決済なし</h2>
            <p>参加費の受け渡しは会場や別の方法で。</p>
          </div>
        </article>
        <article>
          <span class="boundary-mark">14</span>
          <div>
            <h2>終了後に削除</h2>
            <p>イベント終了14日後に受付ごと消えます。</p>
          </div>
        </article>
      </section>
    </main>
  </Layout>
);

const GatheringShell = ({ id, mode }: { id: string; mode: "event" | "manage" | "reply" }) => (
  <Layout
    canonical={canonicalOrigin + "/e/" + id}
    description="イベントの案内、参加表明、定員、キャンセル待ちを確認します。"
    noindex
    script="/event.js"
    title="イベント受付｜集まり口"
  >
    <main data-gathering-id={id} data-mode={mode} id="main">
      <section class="event-loading" data-loading>
        <span class="door-loader" />
        <p>受付を開いています…</p>
      </section>
      <div data-event-app hidden>
        <section class="event-head">
          <div class="event-sign">
            <span data-status>受付中</span>
            <strong data-seat-count>0 / 0</strong>
            <small>席</small>
          </div>
          <div class="event-title-block">
            <p class="eyebrow">GATHERING DESK</p>
            <h1 data-title />
            <div class="event-meta">
              <time data-time />
              <span data-venue />
            </div>
          </div>
        </section>

        <section class="capacity-track" aria-label="定員">
          <span data-capacity-fill />
          <i class="gate-pin" />
        </section>

        <section class="event-notice" data-notice-panel hidden>
          <span class="notice-lamp" />
          <p data-notice />
        </section>

        <div class="event-grid">
          <section class="reply-desk" data-reply-desk>
            <div class="panel-heading">
              <span class="panel-number">01</span>
              <div>
                <p class="eyebrow">YOUR TICKET</p>
                <h2 data-reply-title>参加を伝える</h2>
              </div>
            </div>
            <form data-response-form novalidate>
              <input autocomplete="off" name="website" tabindex={-1} type="text" />
              <label class="field">
                <span>表示名</span>
                <input maxlength={32} name="displayName" placeholder="例：はる" required />
              </label>
              <label class="field">
                <span>人数</span>
                <select name="partySize">
                  <option value="1">1人</option>
                  <option value="2">2人</option>
                  <option value="3">3人</option>
                  <option value="4">4人</option>
                </select>
              </label>
              <fieldset class="choice-deck">
                <legend>返事</legend>
                <label>
                  <input checked name="choice" type="radio" value="attending" />
                  <span class="choice-ticket attending-ticket">参加</span>
                </label>
                <label>
                  <input name="choice" type="radio" value="interested" />
                  <span class="choice-ticket interested-ticket">興味あり</span>
                </label>
                <label>
                  <input name="choice" type="radio" value="declined" />
                  <span class="choice-ticket declined-ticket">不参加</span>
                </label>
              </fieldset>
              <label class="field">
                <span>主催者へのひとこと</span>
                <textarea
                  maxlength={120}
                  name="note"
                  placeholder="食事制限や到着予定など。連絡先は書かないでください。"
                />
              </label>
              <button class="primary full-button" type="submit">
                <span data-response-submit>返事を送る</span>
              </button>
              <p aria-live="polite" class="form-message" data-response-message />
            </form>
          </section>

          <section class="roster-board">
            <div class="panel-heading">
              <span class="panel-number">02</span>
              <div>
                <p class="eyebrow">ENTRANCE BOARD</p>
                <h2>受付のようす</h2>
              </div>
            </div>
            <div class="count-rack">
              <div>
                <span class="count-light attending-light" />
                <small>参加</small>
                <strong data-count-attending>0</strong>
              </div>
              <div>
                <span class="count-light waiting-light" />
                <small>待ち</small>
                <strong data-count-waitlisted>0</strong>
              </div>
              <div>
                <span class="count-light interested-light" />
                <small>興味</small>
                <strong data-count-interested>0</strong>
              </div>
            </div>
            <div class="roster-columns" data-roster />
            <p class="names-hidden" data-names-hidden hidden>
              参加者名は主催者だけに表示されます。
            </p>
          </section>
        </div>

        <section class="event-details">
          <div>
            <p class="eyebrow">EVENT NOTE</p>
            <h2>案内</h2>
            <p data-summary />
          </div>
          <div class="deadline-card">
            <span>参加締切</span>
            <time data-deadline />
            <a data-calendar href="#">
              カレンダーへ保存
            </a>
          </div>
        </section>

        <section class="manager-desk" data-manager hidden>
          <div class="panel-heading">
            <span class="panel-number">03</span>
            <div>
              <p class="eyebrow">ORGANIZER DESK</p>
              <h2>主催者の受付台</h2>
            </div>
          </div>
          <form class="notice-form" data-notice-form>
            <label class="field">
              <span>参加者へ見せるお知らせ</span>
              <textarea maxlength={300} name="notice" placeholder="会場変更や当日の持ち物など" />
            </label>
            <button type="submit">お知らせを更新</button>
          </form>
          <div class="manager-actions">
            <button data-copy-public type="button">
              公開URLをコピー
            </button>
            <a class="button-link" data-export-csv href="#">
              名簿CSV
            </a>
            <a class="button-link" data-export-json href="#">
              控えJSON
            </a>
            <button class="secondary" data-toggle-registration type="button">
              受付を閉じる
            </button>
            <button class="danger" data-cancel-event type="button">
              イベントを中止
            </button>
          </div>
          <div class="private-roster" data-private-roster />
          <p class="capability-note">このURLの #key は主催者だけで保管してください。</p>
        </section>

        <section class="share-strip">
          <div>
            <b>参加者へ渡すURL</b>
            <code data-public-url />
          </div>
          <button data-share type="button">
            共有
          </button>
          <button class="text-button" data-report type="button">
            問題を報告
          </button>
        </section>
      </div>
      <section class="event-error" data-error hidden>
        <span class="closed-door" />
        <h1>受付を開けませんでした。</h1>
        <p data-error-message>URLや受付期間を確認してください。</p>
        <a class="button-link" href="/">
          ホームへ
        </a>
      </section>
    </main>
  </Layout>
);

const Guide = () => (
  <Layout
    canonical={canonicalOrigin + "/guide"}
    description="集まり口でイベント受付をつくり、参加表明と名簿を扱う手順です。"
    title="使い方｜集まり口"
  >
    <main class="info-page" id="main">
      <div class="info-heading">
        <EntrancePreview />
        <div>
          <p class="eyebrow">ENTRANCE FLOW</p>
          <h1>入口をつくり、名簿を受け取る。</h1>
        </div>
      </div>
      <ol class="guide-cards">
        <li>
          <b>01</b>
          <div>
            <h2>受付を開く</h2>
            <p>イベント名、会場、日時、締切、定員を入れます。</p>
          </div>
        </li>
        <li>
          <b>02</b>
          <div>
            <h2>公開URLを渡す</h2>
            <p>X、Discord、LINEなど、主催者が選んだ場所でURLを共有します。</p>
          </div>
        </li>
        <li>
          <b>03</b>
          <div>
            <h2>名前で返事を受ける</h2>
            <p>参加者はアカウントなしで、表示名、人数、返事だけを送ります。</p>
          </div>
        </li>
        <li>
          <b>04</b>
          <div>
            <h2>当日の名簿を出す</h2>
            <p>主催者URLからCSVまたはJSONを保存し、受付に使います。</p>
          </div>
        </li>
      </ol>
      <section class="rule-card">
        <h2>定員を超えたとき</h2>
        <p>
          参加希望の人数で定員を超える場合は自動でキャンセル待ちになります。空きが出ると、受付順にまとまった人数ごと参加へ移ります。
        </p>
      </section>
    </main>
  </Layout>
);

const Privacy = () => (
  <Layout
    canonical={canonicalOrigin + "/privacy"}
    description="集まり口が保存するデータ、集めないデータ、削除時期です。"
    title="データについて｜集まり口"
  >
    <main class="info-page" id="main">
      <div class="info-heading privacy-heading">
        <span class="closed-door small-door" />
        <div>
          <p class="eyebrow">DATA BOUNDARY</p>
          <h1>連絡先を預からない受付。</h1>
        </div>
      </div>
      <div class="data-grid">
        <section class="data-card keep">
          <h2>保存する</h2>
          <ul>
            <li>イベント名・会場・日時・案内</li>
            <li>表示名・人数・返事・ひとこと</li>
            <li>照合用の鍵ハッシュ</li>
            <li>定型の匿名利用イベント</li>
          </ul>
        </section>
        <section class="data-card never">
          <h2>集めない</h2>
          <ul>
            <li>X・SNSアカウント</li>
            <li>メール・電話番号</li>
            <li>住所・年齢・写真・位置情報</li>
            <li>決済情報・個別メッセージ</li>
          </ul>
        </section>
      </div>
      <p class="retention-note">
        イベントと返事は終了14日後、匿名イベントは45日後に削除します。編集鍵そのものは保存せず、SHA-256ハッシュだけを照合します。
      </p>
    </main>
  </Layout>
);

app.use("*", requestId());
app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
});

app.get("/", (c) => c.html(<Home />));
app.get("/guide", (c) => c.html(<Guide />));
app.get("/privacy", (c) => c.html(<Privacy />));
app.get("/e/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await gatheringById(c.env.DB, id);
  return c.html(<GatheringShell id={id} mode="event" />);
});
app.get("/m/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await gatheringById(c.env.DB, id);
  return c.html(<GatheringShell id={id} mode="manage" />);
});
app.get("/r/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await gatheringById(c.env.DB, id);
  return c.html(<GatheringShell id={id} mode="reply" />);
});

app.get("/sitemap.xml", (c) => {
  c.header("Content-Type", "application/xml; charset=UTF-8");
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  const paths = ["/", "/guide", "/privacy"];
  return c.body(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      paths.map((path) => "  <url><loc>" + canonicalOrigin + path + "</loc></url>").join("\n") +
      "\n</urlset>",
  );
});

app.post("/api/telemetry", async (c) => {
  enforceSameOrigin(c);
  const payload = objectPayload(await parseJson(c, 512));
  const name = cleanText(payload, "name", 40);
  if (!telemetryNames.has(name)) throw new ApiError("invalid_event", 400);
  const gatheringId =
    typeof payload.gatheringId === "string" && idPattern.test(payload.gatheringId)
      ? payload.gatheringId
      : "";
  await recordEvent(c, name, gatheringId);
  return c.json({ ok: true }, 202);
});

app.post("/api/gatherings", async (c) => {
  enforceSameOrigin(c);
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  const title = cleanText(payload, "title", 80);
  const venue = cleanText(payload, "venue", 100);
  const summary = cleanText(payload, "summary", 600, { allowEmpty: true });
  const current = nowSeconds();
  const startsAt = integerValue(payload, "startsAt", current + 300, current + 120 * 86400);
  const endsAt = integerValue(payload, "endsAt", startsAt + 1800, startsAt + 24 * 3600);
  const deadlineAt = integerValue(payload, "deadlineAt", current, startsAt);
  const capacity = integerValue(payload, "capacity", 2, 100);
  const showNames = booleanValue(payload, "showNames");
  const recent = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM gatherings WHERE creator_session_id = ? AND created_at > ?",
  )
    .bind(actor, current - 86400)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= 3) throw new ApiError("create_rate_limited", 429);

  const id = randomHex(16);
  const token = randomHex(32);
  await c.env.DB.prepare(
    "INSERT INTO gatherings (id,organizer_token_hash,creator_session_id,title,venue,summary,starts_at,ends_at,deadline_at,capacity,show_names,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      await sha256(token),
      actor,
      title,
      venue,
      summary,
      startsAt,
      endsAt,
      deadlineAt,
      capacity,
      showNames ? 1 : 0,
      current,
      current,
      endsAt + 14 * 86400,
    )
    .run();
  await recordEvent(c, "gathering_created", id, actor);
  return c.json(
    {
      id,
      manageUrl: "/m/" + id + "#key=" + token,
      publicUrl: "/e/" + id,
    },
    201,
  );
});

app.get("/api/gatherings/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  return c.json(await publicState(c.env.DB, await gatheringById(c.env.DB, id)));
});

app.get("/api/gatherings/:id/manage", async (c) => {
  const id = validateId(c.req.param("id"));
  return c.json(await organizerState(c.env.DB, await organizerGathering(c, id)));
});

app.get("/api/gatherings/:id/reply", async (c) => {
  const id = validateId(c.req.param("id"));
  const gathering = await gatheringById(c.env.DB, id);
  const response = await ownedResponse(c, id);
  return c.json({
    ...(await publicState(c.env.DB, gathering)),
    reply: {
      choice: response.choice,
      displayName: response.display_name,
      note: response.note,
      partySize: response.party_size,
    },
  });
});

app.post("/api/gatherings/:id/respond", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const gathering = await gatheringById(c.env.DB, id);
  const current = nowSeconds();
  if (gathering.status !== "open" || gathering.deadline_at < current) {
    throw new ApiError("registration_closed", 409);
  }
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c, 2048));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  const displayName = cleanText(payload, "displayName", 32, { blockContact: true });
  const displayNameKey = displayName.normalize("NFKC").toLocaleLowerCase("ja");
  const partySize = integerValue(payload, "partySize", 1, 4);
  const requested = cleanText(payload, "choice", 12);
  if (!responseChoices.has(requested)) throw new ApiError("invalid_choice", 400);
  const note = cleanText(payload, "note", 120, { allowEmpty: true, blockContact: true });
  const responses = await getResponses(c.env.DB, id);
  if (responses.length >= 100) throw new ApiError("response_limit_reached", 409);
  const occupied = countAttendingSeats(attendanceRecords(responses));
  const hasWaitlist = responses.some((response) => response.choice === "waitlisted");
  const choice = resolveRequestedChoice(
    requested as "attending" | "declined" | "interested",
    partySize,
    gathering.capacity,
    occupied,
    hasWaitlist,
  );
  const token = randomHex(32);
  const responseId = randomHex(16);
  try {
    await c.env.DB.prepare(
      "INSERT INTO responses (id,gathering_id,session_id,token_hash,display_name,display_name_key,party_size,choice,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        responseId,
        id,
        actor,
        await sha256(token),
        displayName,
        displayNameKey,
        partySize,
        choice,
        note,
        current,
        current,
      )
      .run();
  } catch {
    throw new ApiError("already_responded_or_name_taken", 409);
  }
  await recordEvent(c, "response_added", id, actor);
  if (choice === "waitlisted") await recordEvent(c, "waitlist_joined", id, actor);
  return c.json(
    {
      choice,
      id: responseId,
      replyUrl: "/r/" + id + "#key=" + token,
    },
    201,
  );
});

app.patch("/api/gatherings/:id/respond", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const gathering = await gatheringById(c.env.DB, id);
  const current = nowSeconds();
  if (gathering.status !== "open" || gathering.deadline_at < current) {
    throw new ApiError("registration_closed", 409);
  }
  const owned = await ownedResponse(c, id);
  const payload = objectPayload(await parseJson(c, 2048));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  const displayName = cleanText(payload, "displayName", 32, { blockContact: true });
  const displayNameKey = displayName.normalize("NFKC").toLocaleLowerCase("ja");
  const partySize = integerValue(payload, "partySize", 1, 4);
  const requested = cleanText(payload, "choice", 12);
  if (!responseChoices.has(requested)) throw new ApiError("invalid_choice", 400);
  const note = cleanText(payload, "note", 120, { allowEmpty: true, blockContact: true });
  const responses = await getResponses(c.env.DB, id);
  const occupied = countAttendingSeats(
    attendanceRecords(responses.filter((response) => response.id !== owned.id)),
  );
  const hasWaitlist = responses.some(
    (response) => response.id !== owned.id && response.choice === "waitlisted",
  );
  const choice = resolveRequestedChoice(
    requested as "attending" | "declined" | "interested",
    partySize,
    gathering.capacity,
    occupied,
    hasWaitlist,
  );
  try {
    await c.env.DB.prepare(
      "UPDATE responses SET display_name = ?,display_name_key = ?,party_size = ?,choice = ?,note = ?,updated_at = ? WHERE id = ?",
    )
      .bind(displayName, displayNameKey, partySize, choice, note, current, owned.id)
      .run();
  } catch {
    throw new ApiError("name_taken", 409);
  }
  await recordEvent(c, "response_updated", id, owned.session_id);
  if (choice === "waitlisted" && owned.choice !== "waitlisted") {
    await recordEvent(c, "waitlist_joined", id, owned.session_id);
  }
  await promoteWaitlist(c, gathering);
  const updated = await c.env.DB.prepare("SELECT choice FROM responses WHERE id = ?")
    .bind(owned.id)
    .first<{ choice: AttendanceChoice }>();
  return c.json({ choice: updated?.choice ?? choice });
});

app.post("/api/gatherings/:id/withdraw", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const gathering = await gatheringById(c.env.DB, id);
  const owned = await ownedResponse(c, id);
  await c.env.DB.prepare("DELETE FROM responses WHERE id = ?").bind(owned.id).run();
  await recordEvent(c, "response_updated", id, owned.session_id);
  await promoteWaitlist(c, gathering);
  return c.json({ withdrawn: true });
});

app.patch("/api/gatherings/:id/manage", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const gathering = await organizerGathering(c, id);
  const payload = objectPayload(await parseJson(c, 2048));
  const keys = Object.keys(payload).sort();
  if (keys.length === 1 && keys[0] === "notice") {
    const notice = cleanText(payload, "notice", 300, { allowEmpty: true });
    await c.env.DB.prepare("UPDATE gatherings SET notice = ?,updated_at = ? WHERE id = ?")
      .bind(notice, nowSeconds(), id)
      .run();
    return c.json({ notice });
  }
  if (keys.length === 1 && keys[0] === "status") {
    const status = cleanText(payload, "status", 12);
    if (!new Set(["open", "closed", "cancelled"]).has(status)) {
      throw new ApiError("invalid_status", 400);
    }
    if (gathering.status === "cancelled") throw new ApiError("event_cancelled", 409);
    await c.env.DB.prepare("UPDATE gatherings SET status = ?,updated_at = ? WHERE id = ?")
      .bind(status, nowSeconds(), id)
      .run();
    return c.json({ status });
  }
  throw new ApiError("invalid_request", 400);
});

app.post("/api/gatherings/:id/report", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  await gatheringById(c.env.DB, id);
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c, 512));
  const reason = cleanText(payload, "reason", 12);
  if (!reportReasons.has(reason)) throw new ApiError("invalid_reason", 400);
  try {
    await c.env.DB.prepare(
      "INSERT INTO content_reports (gathering_id,session_id,reason,created_at) VALUES (?,?,?,?)",
    )
      .bind(id, actor, reason, nowSeconds())
      .run();
  } catch {
    throw new ApiError("already_reported", 409);
  }
  const reports = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM content_reports WHERE gathering_id = ?",
  )
    .bind(id)
    .first<{ count: number }>();
  if ((reports?.count ?? 0) >= 3) {
    await c.env.DB.prepare("UPDATE gatherings SET status = 'hidden',updated_at = ? WHERE id = ?")
      .bind(nowSeconds(), id)
      .run();
  }
  return c.json({ accepted: true }, 202);
});

const csvSafe = (value: number | string) => {
  const text = String(value ?? "");
  const protectedValue = /^[=+\-@]/u.test(text) ? "'" + text : text;
  return '"' + protectedValue.replaceAll('"', '""') + '"';
};

app.get("/api/gatherings/:id/roster.csv", async (c) => {
  const id = validateId(c.req.param("id"));
  const gathering = await organizerGathering(c, id);
  const responses = await getResponses(c.env.DB, id);
  const rows = [
    ["表示名", "人数", "返事", "ひとこと", "回答時刻", "更新時刻"],
    ...responses.map((response) => [
      response.display_name,
      response.party_size,
      choiceLabels[response.choice],
      response.note,
      new Date(response.created_at * 1000).toISOString(),
      new Date(response.updated_at * 1000).toISOString(),
    ]),
  ];
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="atsumari-' + id.slice(0, 8) + '.csv"');
  c.header("Cache-Control", "no-store");
  await recordEvent(c, "roster_exported", id, gathering.creator_session_id);
  return c.body("\uFEFF" + rows.map((row) => row.map(csvSafe).join(",")).join("\r\n"));
});

app.get("/api/gatherings/:id/roster.json", async (c) => {
  const id = validateId(c.req.param("id"));
  const gathering = await organizerGathering(c, id);
  c.header("Content-Disposition", 'attachment; filename="atsumari-' + id.slice(0, 8) + '.json"');
  c.header("Cache-Control", "no-store");
  await recordEvent(c, "roster_exported", id, gathering.creator_session_id);
  return c.json({
    exportedAt: new Date().toISOString(),
    ...(await organizerState(c.env.DB, gathering)),
  });
});

const icsEscape = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
const icsDate = (seconds: number) =>
  new Date(seconds * 1000)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".000", "");

app.get("/api/gatherings/:id/event.ics", async (c) => {
  const id = validateId(c.req.param("id"));
  const gathering = await gatheringById(c.env.DB, id);
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//yhay81//Atsumari Guchi//JA",
    "BEGIN:VEVENT",
    "UID:" + id + "@atsumari-guchi.yhay81.com",
    "DTSTAMP:" + icsDate(nowSeconds()),
    "DTSTART:" + icsDate(gathering.starts_at),
    "DTEND:" + icsDate(gathering.ends_at),
    "SUMMARY:" + icsEscape(gathering.title),
    "LOCATION:" + icsEscape(gathering.venue),
    "DESCRIPTION:" + icsEscape(gathering.summary),
    "URL:" + canonicalOrigin + "/e/" + id,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="atsumari-' + id.slice(0, 8) + '.ics"');
  return c.body(body);
});

app.get("/health", (c) => c.json({ ok: true }));

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/") || !/\.[a-z0-9]{2,8}$/iu.test(c.req.path)) {
    return c.html(
      <Layout
        canonical={canonicalOrigin + "/"}
        description="指定された受付は見つかりませんでした。"
        noindex
        title="見つかりません｜集まり口"
      >
        <main class="not-found" id="main">
          <span class="closed-door" />
          <h1>受付が見つかりません。</h1>
          <a class="primary button-link" href="/">
            ホームへ
          </a>
        </main>
      </Layout>,
      404,
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json({ error: error.code, requestId: c.get("requestId") }, error.status);
  }
  console.error("unhandled_error", {
    message: error instanceof Error ? error.message : String(error),
    requestId: c.get("requestId"),
  });
  return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});

export const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (_event, env) => {
  const timestamp = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM gatherings WHERE expires_at <= ?").bind(timestamp),
    env.DB.prepare("DELETE FROM product_events WHERE created_at <= ?").bind(timestamp - 45 * 86400),
  ]);
};

export { app, choiceLabels, statusLabels };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Bindings>;
