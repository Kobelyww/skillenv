/**
 * Pantheon client — embedded single-page app for the round-table GUI.
 * Client JS deliberately avoids template literals so the whole page can live
 * inside one TypeScript template string.
 */

export interface PageGod {
  name: string;
  persona: string;
  provider: string;
  model: string;
  skills: { name: string; description: string }[];
}

export interface PageState {
  gods: PageGod[];
  providers: string[];
}

const STYLE = `
:root {
  --bg: #07070d; --panel: #10101a; --panel2: #14141f; --line: #262637;
  --gold: #d4af37; --gold-dim: #9a7d2e; --text: #e9e5d9; --dim: #8d8a7d;
  --ok: #4e9a6a; --err: #c05a52; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  background: radial-gradient(1200px 600px at 70% -10%, #12122a 0%, var(--bg) 60%);
  color: var(--text); font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
}
body::before {
  content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .5;
  background-image:
    radial-gradient(1px 1px at 12% 20%, #fff8 0%, transparent 100%),
    radial-gradient(1px 1px at 40% 8%, #fff6 0%, transparent 100%),
    radial-gradient(1.5px 1.5px at 68% 26%, #ffe9a033 0%, transparent 100%),
    radial-gradient(1px 1px at 85% 12%, #fff5 0%, transparent 100%),
    radial-gradient(1px 1px at 25% 62%, #fff4 0%, transparent 100%),
    radial-gradient(1px 1px at 92% 58%, #fff5 0%, transparent 100%);
}
header {
  display: flex; align-items: center; gap: 16px; padding: 10px 18px;
  border-bottom: 1px solid var(--line); background: #0a0a12e6; z-index: 2;
}
.title { font-family: "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
  font-size: 20px; letter-spacing: 6px; color: var(--gold); white-space: nowrap; }
.subtitle { color: var(--dim); font-size: 12px; letter-spacing: 2px; white-space: nowrap; }
.meander { height: 6px; flex: 1; opacity: .55;
  background: repeating-linear-gradient(90deg, var(--gold-dim) 0 2px, transparent 2px 10px, var(--gold-dim) 10px 12px, transparent 12px 22px); }
.mode { display: flex; gap: 6px; }
.mode button, .ghost {
  background: transparent; border: 1px solid var(--line); color: var(--dim);
  padding: 5px 12px; cursor: pointer; font: inherit; letter-spacing: 1px;
}
.mode button.active { border-color: var(--gold); color: var(--gold); }
select, input, textarea {
  background: var(--panel2); border: 1px solid var(--line); color: var(--text);
  font: inherit; padding: 6px 8px; outline: none;
}
select:focus, input:focus, textarea:focus { border-color: var(--gold-dim); }
.layout { display: flex; flex: 1; min-height: 0; }
aside {
  width: 250px; border-right: 1px solid var(--line); padding: 12px;
  overflow-y: auto; background: #0b0b13; flex-shrink: 0;
}
aside h3 { font-family: Palatino, Georgia, serif; color: var(--gold); font-size: 12px;
  letter-spacing: 3px; margin: 14px 0 6px; }
aside h3:first-child { margin-top: 0; }
.god-chip { display: block; width: 100%; text-align: left; background: transparent;
  border: 1px solid var(--line); color: var(--text); padding: 7px 9px; margin-bottom: 6px;
  cursor: pointer; font: inherit; position: relative; }
.god-chip.active { border-color: var(--gold); }
.god-chip .g-model { display: block; color: var(--dim); font-size: 11px; }
.badge { position: absolute; right: 8px; top: 7px; background: var(--gold); color: #000;
  font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 700; }
.skill { display: inline-block; border: 1px solid #33334a; color: var(--dim); font-size: 11px;
  padding: 2px 7px; margin: 0 4px 4px 0; }
#memory { font-family: var(--mono); font-size: 11px; color: var(--dim); white-space: pre-wrap;
  max-height: 160px; overflow-y: auto; border: 1px solid var(--line); padding: 6px; background: var(--panel); }
.inbox-item { border-left: 2px solid var(--gold-dim); padding: 4px 8px; margin-bottom: 6px; font-size: 12px; }
.inbox-item .from { color: var(--gold); }
.inbox-item .subj { color: var(--text); }
main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.columns { flex: 1; display: flex; gap: 10px; padding: 12px; overflow: auto; min-height: 0; }
.god-col { flex: 1; min-width: 240px; display: flex; flex-direction: column;
  border: 1px solid var(--line); background: var(--panel); min-height: 0; }
.god-col.solo { max-width: 860px; margin: 0 auto; width: 100%; flex: unset; }
.god-head { padding: 8px 12px; border-bottom: 1px solid var(--line); }
.god-head .g-name { font-family: Palatino, Georgia, serif; color: var(--gold); letter-spacing: 2px; }
.god-head .g-persona { color: var(--dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 100%; }
.stream { flex: 1; overflow-y: auto; padding: 10px 12px; min-height: 0; }
.stream p { margin: 0 0 8px; white-space: pre-wrap; }
.tool-card { border: 1px solid var(--line); border-left: 3px solid var(--gold-dim);
  background: #0c0c14; font-family: var(--mono); font-size: 11.5px; padding: 6px 8px;
  margin: 6px 0; color: var(--dim); overflow-wrap: anywhere; }
.tool-card .t-name { color: var(--gold); }
.tool-card .t-ok { color: var(--ok); }
.tool-card .t-err { color: var(--err); }
.phase { text-align: center; color: var(--gold-dim); font-family: Palatino, Georgia, serif;
  letter-spacing: 3px; font-size: 12px; margin: 10px 0; }
.synthesis { border: 1px solid var(--gold-dim); margin: 10px 12px; padding: 10px 14px; background: #12101a; }
.synthesis .s-head { color: var(--gold); font-family: Palatino, Georgia, serif; letter-spacing: 3px; margin-bottom: 6px; }
.synthesis .s-body { white-space: pre-wrap; }
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); background: #0a0a12; }
.composer textarea { flex: 1; resize: none; height: 64px; }
.composer button { background: var(--gold); color: #100c02; border: none; font-weight: 700;
  padding: 0 22px; cursor: pointer; letter-spacing: 2px; font: inherit; }
.composer button:disabled { opacity: .45; cursor: default; }
.err-line { color: var(--err); font-family: var(--mono); font-size: 12px; margin: 4px 0; }
`;

const SCRIPT = `
var STATE = window.__STATE__;
var mode = "roundtable";
var selectedGod = STATE.gods.length ? STATE.gods[0].name : null;
var streaming = false;
var colIndex = {};

function $(id) { return document.getElementById(id); }
function esc(t) { return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function godNames() { return STATE.gods.map(function (g) { return g.name; }); }

function renderColumns() {
  var area = $("columns");
  area.innerHTML = "";
  colIndex = {};
  var list = mode === "roundtable" ? STATE.gods : STATE.gods.filter(function (g) { return g.name === selectedGod; });
  if (list.length === 0) list = STATE.gods.slice(0, 1);
  list.forEach(function (g) {
    var col = el("div", "god-col" + (mode === "solo" ? " solo" : ""));
    col.appendChild(el("div", "god-head",
      '<span class="g-name">' + esc(g.name.toUpperCase()) + '</span>' +
      '<div class="g-persona">' + esc(g.provider + " · " + g.model) + '</div>'));
    var stream = el("div", "stream"); stream.id = "stream-" + g.name;
    col.appendChild(stream);
    area.appendChild(col);
    colIndex[g.name] = stream;
  });
  var syn = el("div", "god-col solo"); syn.id = "synthesis-col"; syn.style.display = "none";
  syn.appendChild(el("div", "god-head", '<span class="g-name">SYNTHESIS · 综合结论</span>'));
  var sStream = el("div", "stream"); sStream.id = "stream-synthesis";
  syn.appendChild(sStream);
  area.appendChild(syn);
  colIndex["synthesis"] = sStream;
}

function renderSidebar() {
  var chips = $("god-chips"); chips.innerHTML = "";
  STATE.gods.forEach(function (g) {
    var b = el("button", "god-chip" + (g.name === selectedGod ? " active" : ""),
      esc(g.name) + (g.unread ? '<span class="badge">' + g.unread + '</span>' : "") +
      '<span class="g-model">' + esc(g.provider + " · " + g.model) + '</span>');
    b.onclick = function () { selectedGod = g.name; if (mode === "solo") renderColumns(); refreshSidebar(); };
    chips.appendChild(b);
  });
  var sel = STATE.gods.filter(function (g) { return g.name === selectedGod; })[0] || STATE.gods[0];
  var skills = $("skills"); skills.innerHTML = "";
  if (sel) (sel.skills || []).forEach(function (s) {
    skills.appendChild(el("span", "skill", esc(s.name)));
  });
  if (sel) fetch("/api/memory?god=" + encodeURIComponent(sel.name))
    .then(function (r) { return r.json(); })
    .then(function (d) { $("memory").textContent = d.memory || "(empty)"; })
    .catch(function () {});
  refreshInbox(sel);
}

function refreshInbox(sel) {
  var box = $("inbox"); box.innerHTML = "";
  var god = sel || STATE.gods.filter(function (g) { return g.name === selectedGod; })[0];
  if (!god) return;
  fetch("/api/inbox?god=" + encodeURIComponent(god.name))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      (d.messages || []).slice(0, 6).forEach(function (m) {
        box.appendChild(el("div", "inbox-item",
          '<span class="from">' + esc(m.from) + '</span> <span class="subj">' + esc(m.subject) + '</span>' +
          '<div>' + esc(m.body.slice(0, 120)) + '</div>'));
      });
      if ((d.messages || []).length === 0) box.appendChild(el("div", "", "(empty)"));
    }).catch(function () {});
}

function streamFor(god) { return colIndex[god] || colIndex["synthesis"]; }

function appendDelta(god, text) {
  var stream = streamFor(god);
  if (!stream) return;
  var last = stream.lastChild;
  if (!last || last.tagName !== "P") { last = el("p"); stream.appendChild(last); }
  last.textContent += text;
  stream.scrollTop = stream.scrollHeight;
}
function appendToolCard(god, name, args) {
  var stream = streamFor(god); if (!stream) return;
  stream.appendChild(el("div", "tool-card",
    '<span class="t-name">⚙ ' + esc(name) + '</span> ' + esc(String(args).slice(0, 140))));
  stream.scrollTop = stream.scrollHeight;
}
function appendToolResult(god, name, ok, preview) {
  var stream = streamFor(god); if (!stream) return;
  var cards = stream.querySelectorAll(".tool-card");
  var card = cards[cards.length - 1];
  if (card) card.appendChild(el("div", ok ? "t-ok" : "t-err", (ok ? "✓ " : "✗ ") + esc(String(preview).slice(0, 200))));
  stream.scrollTop = stream.scrollHeight;
}
function addPhase(text) {
  godNames().concat(["synthesis"]).forEach(function (g) {
    var s = colIndex[g]; if (s) s.appendChild(el("div", "phase", "— " + text + " —"));
  });
}
function addError(god, message) {
  var s = streamFor(god || "synthesis"); if (!s) return;
  s.appendChild(el("div", "err-line", "✗ " + esc(message)));
}

function parseSSE(reader, onEvent) {
  var buffer = "";
  function pump() {
    return reader.read().then(function (r) {
      if (r.done) return;
      buffer += new TextDecoder().decode(r.value, { stream: true });
      var idx;
      while ((idx = buffer.indexOf("\\n\\n")) !== -1) {
        var block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
        var event = "message"; var data = "";
        block.split("\\n").forEach(function (line) {
          if (line.indexOf("event:") === 0) event = line.slice(6).trim();
          if (line.indexOf("data:") === 0) data += line.slice(5).trim();
        });
        if (data) { try { onEvent(event, JSON.parse(data)); } catch (e) {} }
      }
      return pump();
    });
  }
  return pump();
}

function send() {
  if (streaming) return;
  var box = $("prompt"); var prompt = box.value.trim();
  if (!prompt) return;
  box.value = ""; streaming = true; $("send").disabled = true;
  renderColumns();
  var path = mode === "roundtable" ? "/api/roundtable" : "/api/solo";
  var payload = { prompt: prompt,
    provider: $("provider").value || null, model: $("model").value.trim() || null,
    god: selectedGod, rounds: Number($("rounds").value) || 1 };
  addPhase(mode === "roundtable" ? "ROUND TABLE CONVENES" : "SOLO AUDIENCE · " + selectedGod.toUpperCase());
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || r.status); });
      return parseSSE(r.body.getReader(), function (event, data) {
        if (event === "god-delta") appendDelta(data.god, data.text);
        else if (event === "god-tool") appendToolCard(data.god, data.name, data.args);
        else if (event === "god-tool-result") appendToolResult(data.god, data.name, data.ok, data.preview);
        else if (event === "phase") addPhase(data.phase.toUpperCase() + (data.round > 1 ? " · R" + data.round : ""));
        else if (event === "god-error") addError(data.god, data.message);
        else if (event === "error") addError(null, data.message);
        else if (event === "done") addPhase("ADJOURNED");
      });
    })
    .catch(function (e) { addError(null, e.message); })
    .then(function () { streaming = false; $("send").disabled = false; renderSidebar(); });
}

function resetSession() {
  var god = mode === "roundtable" ? null : selectedGod;
  var targets = god ? [god] : godNames();
  Promise.all(targets.map(function (name) {
    return fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ god: name }) });
  })).then(function () { renderColumns(); });
}

function setMode(m) {
  mode = m;
  $("btn-roundtable").className = m === "roundtable" ? "active" : "";
  $("btn-solo").className = m === "solo" ? "active" : "";
  $("rounds").style.display = m === "roundtable" ? "" : "none";
  renderColumns();
}

document.addEventListener("DOMContentLoaded", function () {
  $("btn-roundtable").onclick = function () { setMode("roundtable"); };
  $("btn-solo").onclick = function () { setMode("solo"); };
  $("send").onclick = send;
  $("reset").onclick = resetSession;
  $("prompt").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  var prov = $("provider");
  STATE.providers.forEach(function (id) {
    var o = document.createElement("option"); o.value = id; o.textContent = id; prov.appendChild(o);
  });
  renderColumns(); renderSidebar();
});
`;

export function renderPage(state: PageState): string {
  const godChips = state.gods
    .map((god) => `<span class="skill">${escapeHtml(god.name)}</span>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>PANTHEON · skillenv</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <span class="title">⚔ PANTHEON</span>
  <span class="subtitle">SKILLENV · HERMES HARNESS · 众神圆桌</span>
  <div class="meander"></div>
  <div class="mode">
    <button id="btn-roundtable" class="active">圆桌</button>
    <button id="btn-solo">单神</button>
    <select id="rounds" title="辩论轮数"><option value="1">1 轮</option><option value="2">2 轮</option><option value="3">3 轮</option></select>
    <select id="provider" title="provider"></select>
    <input id="model" placeholder="model (可留空)" style="width:150px">
    <button id="reset" class="ghost">新会话</button>
  </div>
</header>
<div class="layout">
  <aside>
    <h3>GODS · 众神</h3>
    <div id="god-chips">${godChips}</div>
    <h3>SKILLS · 技能</h3>
    <div id="skills"></div>
    <h3>MEMORY · 记忆</h3>
    <div id="memory">(empty)</div>
    <h3>INBOX · 信箱</h3>
    <div id="inbox"></div>
  </aside>
  <main>
    <div class="columns" id="columns"></div>
    <div class="composer">
      <textarea id="prompt" placeholder="向万神殿提问…（Enter 发送；每位神都是完全隔离的 harness）"></textarea>
      <button id="send">召集</button>
    </div>
  </main>
</div>
<script>window.__STATE__ = ${JSON.stringify(state)};</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
