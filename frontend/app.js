// Base URL of the backend API. When the frontend and backend are served from
// different origins (the local dev case), point this at the backend directly.
// CORS is open on the backend so the browser can call it cross-origin.
const API_BASE = "http://localhost:8000";

// How often the dashboard re-fetches state (ms). The backend itself pings
// URLs once a minute; polling more often just keeps the table fresh.
const REFRESH_MS = 10000;

const $ = (id) => document.getElementById(id);
const rowsEl = $("rows");
const msgEl = $("msg");

// --- helpers --------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function timeAgo(iso) {
  if (!iso) return "never";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

function showMsg(text, kind) {
  msgEl.textContent = text;
  msgEl.className = "msg" + (kind ? " " + kind : "");
  if (kind === "ok") setTimeout(() => { if (msgEl.textContent === text) msgEl.textContent = ""; }, 3000);
}

// --- rendering ------------------------------------------------------------

function statusBadge(latest) {
  if (!latest) return `<span class="badge pending"><span class="dot"></span>Pending</span>`;
  return latest.up
    ? `<span class="badge up"><span class="dot"></span>Up</span>`
    : `<span class="badge down"><span class="dot"></span>Down</span>`;
}

function render(urls) {
  const up = urls.filter((u) => u.latest && u.latest.up).length;
  const down = urls.filter((u) => u.latest && !u.latest.up).length;
  $("stat-total").textContent = urls.length;
  $("stat-up").textContent = up;
  $("stat-down").textContent = down;

  if (urls.length === 0) {
    rowsEl.innerHTML = `<tr><td colspan="6" class="empty">No URLs yet. Add one above to start monitoring.</td></tr>`;
    return;
  }

  rowsEl.innerHTML = urls.map((u) => {
    const l = u.latest;
    const code = l && l.status_code != null ? l.status_code : "—";
    const rt = l && l.response_time_ms != null ? `${Math.round(l.response_time_ms)} ms` : "—";
    const checked = l ? timeAgo(l.checked_at) : "never";
    const safeUrl = escapeHtml(u.url);
    return `
      <tr>
        <td>${statusBadge(l)}</td>
        <td class="url-cell"><a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a></td>
        <td class="mono">${code}</td>
        <td class="mono">${rt}</td>
        <td class="muted">${checked}</td>
        <td><button class="del-btn" data-id="${u.id}" data-url="${safeUrl}">Delete</button></td>
      </tr>`;
  }).join("");
}

// --- API calls ------------------------------------------------------------

async function load() {
  try {
    const res = await fetch(`${API_BASE}/urls`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    rowsEl.innerHTML = `<tr><td colspan="6" class="empty">Cannot reach backend at ${API_BASE}. Is it running?</td></tr>`;
  }
}

async function addUrl(url) {
  const res = await fetch(`${API_BASE}/urls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (res.status === 201) return { ok: true };
  if (res.status === 409) return { ok: false, msg: "That URL is already being monitored." };
  if (res.status === 422) return { ok: false, msg: "Invalid URL — must start with http:// or https://" };
  return { ok: false, msg: `Failed to add URL (HTTP ${res.status}).` };
}

async function deleteUrl(id) {
  const res = await fetch(`${API_BASE}/urls/${id}`, { method: "DELETE" });
  return res.status === 204;
}

// --- events ---------------------------------------------------------------

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("url-input");
  const url = input.value.trim();
  if (!url) return;

  const btn = $("add-btn");
  btn.disabled = true;
  const result = await addUrl(url);
  btn.disabled = false;

  if (result.ok) {
    input.value = "";
    showMsg("URL added — running first check…", "ok");
    load();
  } else {
    showMsg(result.msg, "error");
  }
});

rowsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".del-btn");
  if (!btn) return;
  if (!confirm(`Stop monitoring ${btn.dataset.url}?`)) return;
  btn.disabled = true;
  if (await deleteUrl(btn.dataset.id)) {
    load();
  } else {
    showMsg("Failed to delete URL.", "error");
    btn.disabled = false;
  }
});

// --- boot -----------------------------------------------------------------

load();
setInterval(load, REFRESH_MS);
