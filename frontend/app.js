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
      <tr class="url-row" data-id="${u.id}" data-url="${safeUrl}" title="Click to view history">
        <td>${statusBadge(l)}</td>
        <td class="url-cell">${safeUrl}</td>
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
  if (btn) {
    if (!confirm(`Stop monitoring ${btn.dataset.url}?`)) return;
    btn.disabled = true;
    if (await deleteUrl(btn.dataset.id)) {
      load();
    } else {
      showMsg("Failed to delete URL.", "error");
      btn.disabled = false;
    }
    return;
  }
  const row = e.target.closest(".url-row");
  if (row) openDetail(row.dataset.id, row.dataset.url);
});

// --- detail view (uptime + response-time history) -------------------------

const modal = $("modal");
const modalBody = $("modal-body");

function fmtTime(iso) {
  return new Date(iso).toLocaleString();
}

function barTitle(l) {
  const state = l.up ? "Up" : "Down";
  const code = l.status_code != null ? l.status_code : (l.error || "unreachable");
  const rt = l.response_time_ms != null ? `${Math.round(l.response_time_ms)} ms` : "—";
  return `${fmtTime(l.checked_at)}\n${state} · ${code} · ${rt}`;
}

function renderDetail(url, logs) {
  if (logs.length === 0) {
    return `<h2 class="modal-title">${escapeHtml(url)}</h2>
      <p class="muted">No checks recorded yet. Give it a minute and reopen.</p>`;
  }

  // API returns newest-first; show oldest -> newest like a status page.
  const chrono = logs.slice().reverse();
  const upCount = chrono.filter((l) => l.up).length;
  const uptime = ((upCount / chrono.length) * 100).toFixed(2);
  const rts = chrono.filter((l) => l.response_time_ms != null).map((l) => l.response_time_ms);
  const avgRt = rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null;
  const maxRt = Math.max(...rts, 1);
  const latest = chrono[chrono.length - 1];

  const uptimeBars = chrono
    .map((l) => `<span class="ubar ${l.up ? "up" : "down"}" title="${barTitle(l)}"></span>`)
    .join("");

  const rtBars = chrono
    .map((l) => {
      const h = l.response_time_ms != null ? Math.max(4, (l.response_time_ms / maxRt) * 100) : 4;
      return `<span class="rtbar ${l.up ? "up" : "down"}" style="height:${h}%" title="${barTitle(l)}"></span>`;
    })
    .join("");

  return `
    <h2 class="modal-title">
      <span class="badge ${latest.up ? "up" : "down"}"><span class="dot"></span>${latest.up ? "Up" : "Down"}</span>
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
    </h2>

    <div class="detail-stats">
      <div class="dstat"><span class="dstat-num">${uptime}%</span><span class="dstat-label">Uptime</span></div>
      <div class="dstat"><span class="dstat-num">${avgRt != null ? avgRt + " ms" : "—"}</span><span class="dstat-label">Avg response</span></div>
      <div class="dstat"><span class="dstat-num">${chrono.length}</span><span class="dstat-label">Checks</span></div>
    </div>

    <div class="detail-section">
      <div class="detail-head"><span>Uptime</span><span class="muted">${uptime}% uptime</span></div>
      <div class="ustrip">${uptimeBars}</div>
      <div class="detail-axis"><span>oldest</span><span>now</span></div>
    </div>

    <div class="detail-section">
      <div class="detail-head"><span>Response time</span><span class="muted">max ${Math.round(maxRt)} ms</span></div>
      <div class="rtstrip">${rtBars}</div>
      <div class="detail-axis"><span>oldest</span><span>now</span></div>
    </div>`;
}

async function openDetail(id, url) {
  modalBody.innerHTML = `<p class="muted">Loading history…</p>`;
  modal.hidden = false;
  try {
    const res = await fetch(`${API_BASE}/urls/${id}/logs?limit=100`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    modalBody.innerHTML = renderDetail(url, await res.json());
  } catch (err) {
    modalBody.innerHTML = `<p class="msg error">Could not load history (${escapeHtml(err.message)}).</p>`;
  }
}

function closeDetail() {
  modal.hidden = true;
  modalBody.innerHTML = "";
}

$("modal-close").addEventListener("click", closeDetail);
modal.addEventListener("click", (e) => { if (e.target === modal) closeDetail(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeDetail(); });

// --- boot -----------------------------------------------------------------

load();
setInterval(load, REFRESH_MS);
