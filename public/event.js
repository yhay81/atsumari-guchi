const root = document.querySelector("[data-gathering-id]");
const gatheringId = root.dataset.gatheringId;
const mode = root.dataset.mode;
const sessionKey = "atsumari_guchi_session";
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
const key = new URLSearchParams(window.location.hash.slice(1)).get("key") || "";
let currentState;

const errorMessages = {
  already_responded_or_name_taken: "この端末では回答済みか、同じ表示名が使われています。",
  contact_not_allowed_in_displayName: "表示名にメール、電話番号、URLは入れられません。",
  contact_not_allowed_in_note: "ひとことにメール、電話番号、URLは入れられません。",
  invalid_capability: "編集鍵を確認できません。保存した専用URLから開いてください。",
  invalid_choice: "返事を選んでください。",
  invalid_displayName: "表示名を32文字以内で入力してください。",
  invalid_note: "ひとことを120文字以内で入力してください。",
  invalid_partySize: "人数は1〜4人で選んでください。",
  name_taken: "同じ表示名が使われています。",
  registration_closed: "この受付は締め切られています。",
  response_limit_reached: "この受付は回答上限に達しました。",
};

function privateHeaders(contentType = false) {
  const headers = {
    "X-Atsumari-QA": automatedQa ? "1" : "0",
    "X-Atsumari-Session": session,
  };
  if (key) headers["X-Atsumari-Key"] = key;
  if (contentType) headers["Content-Type"] = "application/json";
  return headers;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "request_failed");
    error.code = body.error || "request_failed";
    error.status = response.status;
    throw error;
  }
  return body;
}

async function recordEvent(name) {
  try {
    await fetch("/api/telemetry", {
      body: JSON.stringify({ gatheringId, name }),
      headers: privateHeaders(true),
      keepalive: true,
      method: "POST",
    });
  } catch {
    // 計測できない場合も受付は利用できます。
  }
}

function formatDate(seconds, includeYear = true) {
  return new Intl.DateTimeFormat("ja-JP", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "long",
    weekday: "short",
    year: includeYear ? "numeric" : undefined,
  }).format(new Date(seconds * 1000));
}

function setText(selector, value) {
  document.querySelector(selector).textContent = String(value);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function makePerson(response, privateMode = false) {
  const item = document.createElement("article");
  item.className = "person-slip";
  item.dataset.choice = response.choice;
  const ticket = document.createElement("span");
  ticket.className = "person-ticket";
  ticket.textContent =
    response.choice === "attending"
      ? "参"
      : response.choice === "waitlisted"
        ? "待"
        : response.choice === "interested"
          ? "興"
          : "欠";
  const details = document.createElement("div");
  const name = document.createElement("b");
  name.textContent = response.displayName;
  const size = document.createElement("small");
  size.textContent = response.partySize + "人 · " + (response.choiceLabel || "");
  details.append(name, size);
  item.append(ticket, details);
  if (privateMode && response.note) {
    const note = document.createElement("p");
    note.textContent = response.note;
    item.append(note);
  }
  return item;
}

function renderPublicRoster(state) {
  const roster = document.querySelector("[data-roster]");
  roster.replaceChildren();
  const hidden = document.querySelector("[data-names-hidden]");
  hidden.hidden = state.gathering.showNames;
  if (!state.gathering.showNames) return;
  const choices = ["attending", "waitlisted", "interested"];
  for (const choice of choices) {
    const column = document.createElement("section");
    column.className = "roster-column";
    const heading = document.createElement("h3");
    heading.textContent =
      choice === "attending" ? "参加" : choice === "waitlisted" ? "キャンセル待ち" : "興味あり";
    column.append(heading);
    const responses = state.responses.filter((response) => response.choice === choice);
    if (!responses.length) {
      const empty = document.createElement("p");
      empty.className = "empty-column";
      empty.textContent = "まだいません";
      column.append(empty);
    } else {
      for (const response of responses) column.append(makePerson(response));
    }
    roster.append(column);
  }
}

function renderPrivateRoster(state) {
  const container = document.querySelector("[data-private-roster]");
  container.replaceChildren();
  if (!state.roster?.length) {
    const empty = document.createElement("p");
    empty.className = "empty-private";
    empty.textContent = "まだ返事はありません。";
    container.append(empty);
    return;
  }
  for (const response of state.roster) container.append(makePerson(response, true));
}

function fillReply(response) {
  const form = document.querySelector("[data-response-form]");
  form.elements.displayName.value = response.displayName;
  form.elements.partySize.value = String(response.partySize);
  const editableChoice = response.choice === "waitlisted" ? "attending" : response.choice;
  const choice = form.querySelector('input[name="choice"][value="' + editableChoice + '"]');
  if (choice) choice.checked = true;
  form.elements.note.value = response.note;
  setText("[data-reply-title]", "返事を直す");
  setText("[data-response-submit]", "変更を保存");
  if (!form.querySelector("[data-withdraw]")) {
    const button = document.createElement("button");
    button.className = "text-button withdraw-button";
    button.dataset.withdraw = "";
    button.type = "button";
    button.textContent = "返事を取り消す";
    button.addEventListener("click", withdrawResponse);
    form.append(button);
  }
}

function render(state) {
  currentState = state;
  const gathering = state.gathering;
  setText("[data-status]", gathering.statusLabel);
  setText("[data-seat-count]", state.counts.attendingSeats + " / " + gathering.capacity);
  setText("[data-title]", gathering.title);
  setText(
    "[data-time]",
    formatDate(gathering.startsAt) + " 〜 " + formatDate(gathering.endsAt, false),
  );
  setText("[data-venue]", gathering.venue);
  setText("[data-count-attending]", state.counts.attendingSeats);
  setText("[data-count-waitlisted]", state.counts.waitlistedSeats);
  setText("[data-count-interested]", state.counts.interestedGroups);
  setText("[data-summary]", gathering.summary || "主催者からの追加案内はありません。");
  setText("[data-deadline]", formatDate(gathering.deadlineAt));
  setText("[data-public-url]", window.location.origin + "/e/" + gatheringId);

  const percent = Math.min(
    100,
    Math.round((state.counts.attendingSeats / gathering.capacity) * 100),
  );
  document.querySelector("[data-capacity-fill]").style.width = percent + "%";
  document.querySelector("[data-capacity-fill]").dataset.full =
    state.counts.attendingSeats >= gathering.capacity ? "true" : "false";

  const noticePanel = document.querySelector("[data-notice-panel]");
  noticePanel.hidden = !gathering.notice;
  setText("[data-notice]", gathering.notice);
  renderPublicRoster(state);

  const registrationOpen =
    gathering.status === "open" && gathering.deadlineAt >= Math.floor(Date.now() / 1000);
  const responseForm = document.querySelector("[data-response-form]");
  responseForm.querySelectorAll("input,select,textarea,button").forEach((control) => {
    if (!control.matches("[data-withdraw]")) control.disabled = !registrationOpen;
  });
  if (!registrationOpen) {
    setText("[data-response-message]", "この受付は締め切られています。");
  }

  const calendar = document.querySelector("[data-calendar]");
  calendar.href = "/api/gatherings/" + gatheringId + "/event.ics";

  if (mode === "manage") {
    document.querySelector("[data-reply-desk]").hidden = true;
    root.classList.add("manager-mode");
    document.querySelector("[data-manager]").hidden = false;
    document.querySelector("[data-notice-form]").elements.notice.value = gathering.notice;
    document.querySelector("[data-toggle-registration]").textContent =
      gathering.status === "open" ? "受付を閉じる" : "受付を再開";
    renderPrivateRoster(state);
  } else if (mode === "reply" && state.reply) {
    fillReply(state.reply);
  }

  document.querySelector("[data-loading]").hidden = true;
  document.querySelector("[data-event-app]").hidden = false;
}

async function loadState() {
  const suffix = mode === "manage" ? "/manage" : mode === "reply" ? "/reply" : "";
  try {
    const state = await requestJson("/api/gatherings/" + gatheringId + suffix, {
      headers: privateHeaders(),
    });
    render(state);
    if (mode === "event") void recordEvent("public_gathering_viewed");
  } catch (error) {
    document.querySelector("[data-loading]").hidden = true;
    document.querySelector("[data-error]").hidden = false;
    setText(
      "[data-error-message]",
      errorMessages[error.code] || "URL、受付期間、専用の編集鍵を確認してください。",
    );
  }
}

document.querySelector("[data-response-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = form.querySelector("[data-response-message]");
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  message.textContent = "";
  const method = mode === "reply" ? "PATCH" : "POST";
  try {
    const result = await requestJson("/api/gatherings/" + gatheringId + "/respond", {
      body: JSON.stringify({
        choice: form.elements.choice.value,
        displayName: form.elements.displayName.value,
        note: form.elements.note.value,
        partySize: Number(form.elements.partySize.value),
        website: form.elements.website.value,
      }),
      headers: privateHeaders(true),
      method,
    });
    if (mode !== "reply") {
      message.textContent =
        result.choice === "waitlisted"
          ? "キャンセル待ちで受け付けました。専用ページへ移動します。"
          : "返事を受け付けました。専用ページへ移動します。";
      window.location.assign(result.replyUrl);
      return;
    }
    message.textContent =
      result.choice === "waitlisted"
        ? "変更し、キャンセル待ちになりました。"
        : "返事を更新しました。";
    await loadState();
  } catch (error) {
    message.textContent =
      errorMessages[error.code] || "返事を送れませんでした。入力を確認してください。";
  } finally {
    submit.disabled = false;
  }
});

async function withdrawResponse() {
  if (!window.confirm("このイベントへの返事を取り消しますか？")) return;
  try {
    await requestJson("/api/gatherings/" + gatheringId + "/withdraw", {
      headers: privateHeaders(true),
      method: "POST",
    });
    window.location.assign("/e/" + gatheringId);
  } catch (error) {
    setText("[data-response-message]", errorMessages[error.code] || "取り消せませんでした。");
  }
}

document.querySelector("[data-calendar]").addEventListener("click", () => {
  void recordEvent("calendar_saved");
});

document.querySelector("[data-share]").addEventListener("click", async () => {
  const publicUrl = window.location.origin + "/e/" + gatheringId;
  if (navigator.share) {
    await navigator.share({
      title: currentState?.gathering.title || "イベント受付",
      url: publicUrl,
    });
  } else {
    await copyText(publicUrl);
  }
});

document.querySelector("[data-copy-public]").addEventListener("click", async (event) => {
  await copyText(window.location.origin + "/e/" + gatheringId);
  event.currentTarget.textContent = "コピーしました";
});

document.querySelector("[data-notice-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await requestJson("/api/gatherings/" + gatheringId + "/manage", {
      body: JSON.stringify({ notice: event.currentTarget.elements.notice.value }),
      headers: privateHeaders(true),
      method: "PATCH",
    });
    await loadState();
  } catch {
    window.alert("お知らせを更新できませんでした。");
  }
});

async function updateStatus(status) {
  await requestJson("/api/gatherings/" + gatheringId + "/manage", {
    body: JSON.stringify({ status }),
    headers: privateHeaders(true),
    method: "PATCH",
  });
  await loadState();
}

document.querySelector("[data-toggle-registration]").addEventListener("click", async () => {
  try {
    await updateStatus(currentState.gathering.status === "open" ? "closed" : "open");
  } catch {
    window.alert("受付状態を変更できませんでした。");
  }
});

document.querySelector("[data-cancel-event]").addEventListener("click", async () => {
  if (!window.confirm("イベントを中止表示にしますか？再開はできません。")) return;
  try {
    await updateStatus("cancelled");
  } catch {
    window.alert("中止へ変更できませんでした。");
  }
});

async function downloadPrivate(kind) {
  const response = await fetch("/api/gatherings/" + gatheringId + "/roster." + kind, {
    headers: privateHeaders(),
  });
  if (!response.ok) throw new Error("download_failed");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = "atsumari-" + gatheringId.slice(0, 8) + "." + kind;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.querySelector("[data-export-csv]").addEventListener("click", async (event) => {
  event.preventDefault();
  await downloadPrivate("csv").catch(() => window.alert("CSVを書き出せませんでした。"));
});

document.querySelector("[data-export-json]").addEventListener("click", async (event) => {
  event.preventDefault();
  await downloadPrivate("json").catch(() => window.alert("JSONを書き出せませんでした。"));
});

document.querySelector("[data-report]").addEventListener("click", async () => {
  if (!window.confirm("迷惑・危険な受付として報告しますか？")) return;
  try {
    await requestJson("/api/gatherings/" + gatheringId + "/report", {
      body: JSON.stringify({ reason: "unsafe" }),
      headers: privateHeaders(true),
      method: "POST",
    });
    window.alert("報告を受け付けました。");
  } catch {
    window.alert("報告済みか、送信できませんでした。");
  }
});

void loadState();
