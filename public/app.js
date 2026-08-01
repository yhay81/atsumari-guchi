const sessionKey = "atsumari_guchi_session";
const seenKey = "atsumari_guchi_seen";
const automatedQa =
  new URLSearchParams(window.location.search).get("qa") === "1" || navigator.webdriver === true;

function sessionId() {
  if (automatedQa) return crypto.randomUUID();
  const existing = localStorage.getItem(sessionKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(sessionKey, created);
  return created;
}

const session = sessionId();

async function recordEvent(name, gatheringId = "") {
  const headers = {
    "Content-Type": "application/json",
    "X-Atsumari-Session": session,
  };
  if (automatedQa) headers["X-Atsumari-QA"] = "1";
  try {
    await fetch("/api/telemetry", {
      body: JSON.stringify({ gatheringId, name }),
      headers,
      keepalive: true,
      method: "POST",
    });
  } catch {
    // 計測できない場合も受付作成は利用できます。
  }
}

function localDateTime(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
}

function prepareDates(form) {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(13, 0, 0, 0);
  const end = new Date(start);
  end.setHours(16, 0, 0, 0);
  const deadline = new Date(start);
  deadline.setHours(10, 0, 0, 0);
  form.elements.startsAt.value = localDateTime(start);
  form.elements.endsAt.value = localDateTime(end);
  form.elements.deadlineAt.value = localDateTime(deadline);
}

const errorMessages = {
  create_rate_limited: "1日に作れる受付は3件までです。",
  cross_site_request: "安全確認に失敗しました。ページを開き直してください。",
  invalid_capacity: "定員は2〜100人で入力してください。",
  invalid_deadlineAt: "参加締切は現在から開始時刻までの間にしてください。",
  invalid_endsAt: "終了は開始の30分後〜24時間後にしてください。",
  invalid_startsAt: "開始は5分後〜120日後にしてください。",
  invalid_title: "イベント名を80文字以内で入力してください。",
  invalid_venue: "会場・集合場所を100文字以内で入力してください。",
};

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "request_failed");
    error.code = body.error || "request_failed";
    throw error;
  }
  return body;
}

const form = document.querySelector("[data-create-form]");
prepareDates(form);

document.querySelector("[data-open-create]").addEventListener("click", () => {
  document.querySelector("#create-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.title.focus({ preventScroll: true });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  const message = form.querySelector("[data-form-message]");
  message.textContent = "";
  submit.disabled = true;
  submit.textContent = "受付を準備中…";
  const startsAt = Math.floor(new Date(form.elements.startsAt.value).valueOf() / 1000);
  const endsAt = Math.floor(new Date(form.elements.endsAt.value).valueOf() / 1000);
  const deadlineAt = Math.floor(new Date(form.elements.deadlineAt.value).valueOf() / 1000);

  try {
    const result = await requestJson("/api/gatherings", {
      body: JSON.stringify({
        capacity: Number(form.elements.capacity.value),
        deadlineAt,
        endsAt,
        showNames: form.elements.showNames.checked,
        startsAt,
        summary: form.elements.summary.value,
        title: form.elements.title.value,
        venue: form.elements.venue.value,
        website: form.elements.website.value,
      }),
      headers: {
        "Content-Type": "application/json",
        "X-Atsumari-QA": automatedQa ? "1" : "0",
        "X-Atsumari-Session": session,
      },
      method: "POST",
    });
    message.textContent = "受付を開きました。主催者ページへ移動します。";
    window.location.assign(result.manageUrl);
  } catch (error) {
    message.textContent =
      errorMessages[error.code] || "受付を作れませんでした。入力と通信状態を確認してください。";
    submit.disabled = false;
    submit.textContent = "受付を開く";
  }
});

void recordEvent("visited");
if (!automatedQa && localStorage.getItem(seenKey) === "1") void recordEvent("returned");
if (!automatedQa) localStorage.setItem(seenKey, "1");
