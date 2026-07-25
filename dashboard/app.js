'use strict';

/* ==========================================================================
 * State
 * ======================================================================== */

const state = {
  view: 'universe',    // 'universe' | 'workspace' — top-level view switch
  metaphor: 'orbit',   // universe rendering: 'orbit' (planets) | 'network' (nodes)
  hoverId: null,       // workspace id under the cursor in the universe view
  workspaces: [],      // workspace summaries (active one gets the full shape)
  activeId: null,      // id of the workspace being viewed
  tasks: [],           // tasks of the active workspace
  messages: [],        // bus messages of the active workspace (newest last)
  events: [],          // events of the active workspace (newest last)
  tab: 'comms',        // 'comms' | 'activity'
  wsRetry: 0,          // consecutive failed WS attempts (drives backoff)
  hadConnection: false, // true once a WS connection has ever opened
  panelCollapsed: false, // right panel drawn in/out (persisted)
  unread: 0,           // comms/activity frames received while collapsed
  models: null,        // model catalog from GET /api/state (null until it lands)
  setup: null,         // first-run status from GET /api/state (null until it lands)
  setupDismissed: false // user closed the setup screen this session
};

// The catalog is server-owned and config-driven; MODELS is only the offline fallback used
// before /api/state answers (or if it ever answers without one). Labels mirror the server's
// DEFAULT_MODEL_CATALOG so the pre-answer render reads the same as the answered one.
const MODELS = [
  { id: 'sonnet', label: 'Claude-Sonnet-5' },
  { id: 'fable', label: 'Claude-Fable-5' },
  { id: 'opus', label: 'Claude-Opus-5' },
  { id: 'haiku', label: 'Claude-Haiku-4.5' }
];
const KNOWN_ROLES = ['lead', 'builder', 'designer', 'reviewer', 'grunt'];
const DEFAULT_ROLES = ['lead', 'builder', 'reviewer'];

// Catalog entries arrive as {id,label} objects; plain strings are tolerated.
function modelEntry(m) {
  const id = String((m && typeof m === 'object' ? m.id : m) ?? '').trim();
  const label = String((m && typeof m === 'object' ? m.label : '') || '').trim();
  return { id, label: label || id };
}

function modelCatalog(models) {
  const src = Array.isArray(models) && models.length ? models : (state.models || MODELS);
  return (Array.isArray(src) && src.length ? src : MODELS).map(modelEntry).filter((m) => m.id);
}

// Display name for a model id. Falls back to the raw id for anything the catalog no longer
// lists, so a retired agent's model is never blanked out or renamed to something it never ran.
function modelLabel(id) {
  const want = String(id || '').trim();
  if (!want) return '';
  const hit = modelCatalog().find((m) => m.id === want);
  return hit ? hit.label : want;
}

// Role defaults mirror the server's: grunt runs haiku, everyone else sonnet. A catalog that
// omits the default falls back to its first entry rather than selecting nothing.
function defaultModelFor(role) {
  const list = modelCatalog();
  const want = role === 'grunt' ? 'haiku' : 'sonnet';
  if (list.some((m) => m.id === want)) return want;
  return list.length ? list[0].id : want;
}

const STATUSES = ['inbox', 'todo', 'in_progress', 'review', 'done', 'blocked'];
const STATUS_LABELS = {
  inbox: 'Inbox', todo: 'To do', in_progress: 'In progress',
  review: 'Review', done: 'Done', blocked: 'Blocked'
};
const FEED_MAX = 200;

const $ = (sel) => document.querySelector(sel);

function activeWorkspace() {
  return state.workspaces.find((w) => w && w.id === state.activeId) || null;
}

/* ==========================================================================
 * Small helpers
 * ======================================================================== */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '--:--';
  const d = new Date(n);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// Shared magnitude split (thresholds + rounding) for the HUD and JARVIS
// speech, so fmtTokens and spokenTokens can never drift apart.
function tokenParts(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return { num: (v / 1000000).toFixed(v >= 100000000 ? 0 : 1), unit: 'M' };
  if (v >= 1000) return { num: (v / 1000).toFixed(v >= 100000 ? 0 : 1), unit: 'k' };
  return { num: String(v), unit: '' };
}

function fmtTokens(n) {
  const p = tokenParts(n);
  return p.num + p.unit;
}

function fmtDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '—';
  return v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms';
}

function upsertById(list, item) {
  if (!item || item.id === undefined || item.id === null) return;
  const i = list.findIndex((x) => x && x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
}

function trimFeed(list) {
  if (list.length > FEED_MAX) list.splice(0, list.length - FEED_MAX);
}

// localStorage can be unavailable (private mode) — swallow uniformly.
function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* private mode */ }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

let toastTimer = null;
let jarvisTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* ==========================================================================
 * API
 * ======================================================================== */

// Low-level fetch: never throws, returns { ok, status, data, error }.
// On non-2xx it extracts the server's error message from the JSON body.
async function request(path, opts) {
  try {
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      return { ok: false, status: res.status, data, error: String(msg) };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    console.error('Request failed:', path, err);
    return { ok: false, status: 0, data: null, error: 'Network error — is the server running?' };
  }
}

// Convenience wrapper: toast on failure, return parsed body (or null).
async function api(path, opts) {
  const r = await request(path, opts);
  if (!r.ok) {
    console.error('API request failed:', path, r.status, r.error);
    toast('Request failed: ' + r.error);
    return null;
  }
  return r.data;
}

function jsonOpts(method, body) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function postJSON(path, body) {
  return api(path, jsonOpts('POST', body));
}

/* ==========================================================================
 * Data loading
 * ======================================================================== */

async function refreshWorkspaceList() {
  const data = await api('/api/state');
  if (!data) { renderAll(); return; }
  // Server is the source of truth for the model catalog; keep the last good one on a bad payload.
  if (Array.isArray(data.known_models) && data.known_models.length) state.models = data.known_models;
  if (data.setup) state.setup = data.setup;
  const incoming = Array.isArray(data.workspaces) ? data.workspaces : [];
  // Keep the richer detail object for the active workspace if we have it.
  const currentActive = activeWorkspace();
  state.workspaces = incoming.map((w) =>
    (currentActive && w && w.id === currentActive.id)
      ? Object.assign({}, currentActive, w)
      : w
  );
  if (state.activeId && !activeWorkspace()) state.activeId = null;
  renderAll();
}

async function loadState() {
  // Land on the universe view — workspaces render as planets; none auto-selected.
  await refreshWorkspaceList();
}

async function selectWorkspace(id) {
  if (id === undefined || id === null) return;
  state.activeId = id;
  state.tasks = [];
  state.messages = [];
  state.events = [];
  state.unread = 0;
  renderAll();

  const data = await api('/api/workspaces/' + encodeURIComponent(id));
  if (!data || state.activeId !== id) return; // stale response or failure
  upsertById(state.workspaces, data.workspace);
  state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
  state.messages = Array.isArray(data.messages) ? data.messages : [];
  state.events = Array.isArray(data.events) ? data.events : [];
  renderAll();
}

// Keep the active workspace's task_counts fresh (feeds the universe hover card).
function syncTaskCounts() {
  const ws = activeWorkspace();
  if (!ws) return;
  const counts = {};
  for (const s of STATUSES) counts[s] = 0;
  for (const t of state.tasks) {
    if (t && counts[t.status] !== undefined) counts[t.status] += 1;
  }
  ws.task_counts = counts;
}

/* ==========================================================================
 * WebSocket
 * ======================================================================== */

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let ws;
  try {
    ws = new WebSocket(proto + location.host + '/ws');
  } catch (err) {
    console.error('WS construction failed:', err);
    scheduleReconnect();
    return;
  }
  let settled = false; // guards against double-scheduling reconnects

  ws.onopen = () => {
    state.wsRetry = 0;
    setConnected(true);
    if (state.hadConnection) {
      // Re-sync after an outage: we may have missed frames.
      loadState();
      if (state.activeId) selectWorkspace(state.activeId);
    }
    state.hadConnection = true;
  };
  ws.onmessage = (e) => {
    let frame;
    try { frame = JSON.parse(e.data); } catch { return; }
    handleFrame(frame);
  };
  ws.onclose = () => {
    if (settled) return;
    settled = true;
    setConnected(false);
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

function scheduleReconnect() {
  const delay = Math.min(10000, 500 * Math.pow(2, state.wsRetry));
  state.wsRetry += 1;
  setTimeout(connectWS, delay);
}

// LINK indicators live in both the universe HUD bar and the detail rail.
function setConnected(on) {
  for (const el of document.querySelectorAll('.conn-status')) {
    el.classList.toggle('conn-on', on);
    el.classList.toggle('conn-off', !on);
  }
  for (const el of document.querySelectorAll('.conn-label')) {
    el.textContent = on ? 'live' : 'offline';
  }
}

function handleFrame(frame) {
  if (!frame || typeof frame !== 'object') return;

  // Workspace frames update the sidebar for any workspace, and the strip/header
  // when it is the one being viewed.
  if (frame.type === 'workspace') {
    const w = frame.workspace;
    if (!w || w.id === undefined) return;
    upsertById(state.workspaces, w);
    renderUniverse();
    if (w.id === state.activeId) {
      renderRail();
      renderAgents();
      renderBottomBar();
    }
    return;
  }

  if (frame.workspace_id !== state.activeId) return;

  switch (frame.type) {
    case 'event':
      if (!frame.event) return;
      upsertById(state.events, frame.event);
      trimFeed(state.events);
      if (frame.event.type === 'goal_posted') renderDirective();
      if (state.panelCollapsed) { state.unread += 1; renderUnread(); }
      else if (state.tab === 'activity') renderPanel();
      break;
    case 'message':
      if (!frame.message) return;
      upsertById(state.messages, frame.message);
      trimFeed(state.messages);
      if (state.panelCollapsed) { state.unread += 1; renderUnread(); }
      else if (state.tab === 'comms') renderPanel();
      break;
    case 'task':
      if (!frame.task) return;
      upsertById(state.tasks, frame.task);
      syncTaskCounts();
      renderBoard();
      renderUniverse();
      break;
    case 'agent': {
      if (!frame.agent) return;
      const ws = activeWorkspace();
      if (!ws) return;
      if (!Array.isArray(ws.agents)) ws.agents = [];
      upsertById(ws.agents, frame.agent);
      renderAgents();
      renderBottomBar();
      renderUniverse();
      break;
    }
    default:
      break;
  }
}

/* ==========================================================================
 * View switch — universe (planet picker) ⇄ workspace detail
 * ======================================================================== */

const REDUCED_MOTION_MQ = window.matchMedia('(prefers-reduced-motion: reduce)');
function motionOK() {
  return !REDUCED_MOTION_MQ.matches; // .matches is live — one MQL for all reads
}

function setView(view) {
  state.view = view;
  $('#universe-view').hidden = view !== 'universe';
  $('#detail-view').hidden = view !== 'workspace';
  if (view === 'universe') {
    renderUniverse();
    startUniverseFX();
  } else {
    clearHover();
    stopUniverseFX();
  }
}

function enterWorkspace(id) {
  clearHover();
  setView('workspace');
  selectWorkspace(id);
  writeRoute();
}

// Ruling #17: universe → workspace warp-in. The universe layer dives toward the
// clicked orb (scale 2.4, translate derived from its rendered % position) and
// the view switches at 620ms; the design has no reverse warp on the way back.
let warpTimer = 0;

function warpToWorkspace(id) {
  if (warpTimer) return; // orb clicks are ignored while a warp is in flight
  if (!motionOK()) { enterWorkspace(id); return; } // reduced motion: instant, no timeout
  const list = state.workspaces.filter(Boolean);
  const i = list.findIndex((w) => w.id === id);
  const layer = $('#universe-layer');
  if (i < 0 || !layer) { enterWorkspace(id); return; }
  const POSITIONS = state.metaphor === 'network' ? NET_POSITIONS : ORB_POSITIONS;
  const pos = POSITIONS[i % POSITIONS.length];
  clearHover();
  layer.style.setProperty('--warp-tx', ((50 - pos.x) * 2.2) + '%');
  layer.style.setProperty('--warp-ty', ((52 - pos.y) * 2.2) + '%');
  layer.classList.add('warping'); // starfield FX keeps running until the switch
  warpTimer = setTimeout(() => {
    warpTimer = 0;
    enterWorkspace(id);
    // Removing .warping also removes the transition, so this reset is instant.
    layer.classList.remove('warping');
    layer.style.removeProperty('--warp-tx');
    layer.style.removeProperty('--warp-ty');
  }, 620);
}

function backToUniverse() {
  // Keep activeId + WS subscription so re-entry is instant.
  setView('universe');
  writeRoute();
}

/* ==========================================================================
 * Route — the URL hash records which screen is open ('#/' or '#/ws/<id>') so a
 * browser refresh, and back/forward, land where the user was instead of always
 * resetting to the fleet view. Writes go through history.pushState/replaceState,
 * which never fire hashchange, so there is no write→read feedback loop; only
 * popstate is listened for. Restores are direct (no warp) — the warp-in of
 * ruling #17 stays a response to clicking an orb, not to reloading a page.
 * ======================================================================== */

let applyingRoute = false; // suppresses route writes while a route is being applied

function currentRoute() {
  return state.view === 'workspace' && state.activeId != null
    ? '#/ws/' + encodeURIComponent(state.activeId)
    : '#/';
}

function routeWorkspaceId() {
  const m = /^#\/ws\/(.+)$/.exec(location.hash);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; } // malformed %-escape
}

function writeRoute(replace) {
  if (applyingRoute) return; // the URL already says this; don't echo it back
  const next = currentRoute();
  if ((location.hash || '#/') === next) return;
  try {
    history[replace ? 'replaceState' : 'pushState'](null, '', next);
  } catch {
    location.hash = next; // history blocked (e.g. file://) — hash still persists the view
  }
}

// Boot + back/forward: make the view match the URL. An id that no longer exists
// (deleted workspace, hand-typed hash) falls back to the fleet view.
function applyRoute() {
  const id = routeWorkspaceId();
  const known = id !== null && state.workspaces.some((w) => w && String(w.id) === id);
  applyingRoute = true;
  try {
    if (known) {
      if (state.view !== 'workspace' || String(state.activeId) !== id) enterWorkspace(id);
    } else if (state.view !== 'universe') {
      backToUniverse();
    }
  } finally {
    applyingRoute = false;
  }
  if (id !== null && !known) writeRoute(true); // drop the stale id from the URL
}

/* ==========================================================================
 * Render — universe (planets / network nodes, HUD bar, hover telemetry)
 * ======================================================================== */

// Deterministic planet placement: design anchors for the first four, then the
// design's overflow positions. Stable per list order.
const ORB_POSITIONS = [
  { x: 27, y: 33 }, { x: 73, y: 29 }, { x: 76, y: 70 }, { x: 25, y: 71 },
  { x: 50, y: 18 }, { x: 14, y: 48 }, { x: 86, y: 48 }, { x: 50, y: 86 }
];
const NET_POSITIONS = [
  { x: 22, y: 31 }, { x: 71, y: 24 }, { x: 79, y: 67 }, { x: 29, y: 74 },
  { x: 50, y: 16 }, { x: 12, y: 46 }, { x: 88, y: 46 }, { x: 50, y: 88 }
];

// Stable hue per workspace, derived from its id (spec §G) — the fallback when none was chosen.
function wsHue(id) {
  let h = 0;
  for (const c of String(id)) h = ((h * 31) + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

// Preset planet colours offered when creating or editing a workspace.
const HUE_CHOICES = [
  { hue: 150, label: 'Jade' },
  { hue: 190, label: 'Cyan' },
  { hue: 210, label: 'Azure' },
  { hue: 272, label: 'Violet' },
  { hue: 320, label: 'Magenta' },
  { hue: 0, label: 'Crimson' },
  { hue: 38, label: 'Amber' },
  { hue: 95, label: 'Lime' },
];

/**
 * The workspace's planet colour: an explicitly chosen `hue`, else the id-derived one.
 * Takes the workspace object rather than an id so an unset hue keeps the old behaviour
 * for every workspace that predates the picker.
 */
function wsHueOf(w) {
  const h = Number(w && w.hue);
  return Number.isFinite(h) && h >= 0 && h < 360 ? h : wsHue(w && w.id);
}

/** Render the swatch radiogroup. `selected` is a hue, or null for "auto (from name)". */
function renderHuePicker(sel, selected) {
  const el = $(sel);
  if (!el) return;
  const opts = [{ hue: null, label: 'Auto' }].concat(HUE_CHOICES);
  el.innerHTML = opts
    .map((o) => {
      const on = (o.hue === null && selected === null) || o.hue === selected;
      const style = o.hue === null
        ? 'background:linear-gradient(135deg,hsl(150 55% 52%),hsl(272 55% 52%),hsl(38 55% 52%));'
        : 'background:radial-gradient(circle at 36% 32%, hsl(' + o.hue + ' 60% 72%), hsl(' + o.hue + ' 55% 52%) 52%, hsl(' + o.hue + ' 60% 26%) 100%);';
      return '<button type="button" class="hue-swatch' + (on ? ' is-on' : '') + '"' +
        ' role="radio" aria-checked="' + (on ? 'true' : 'false') + '"' +
        ' data-hue="' + (o.hue === null ? '' : o.hue) + '"' +
        ' title="' + esc(o.label) + '" aria-label="' + esc(o.label) + '"><span style="' + style + '"></span></button>';
    })
    .join('');
}

/** Currently selected hue for a picker: a number, or null for auto. */
function selectedHue(sel) {
  const on = document.querySelector(sel + ' .hue-swatch.is-on');
  if (!on) return null;
  const v = on.getAttribute('data-hue');
  return v === '' ? null : Number(v);
}

/** Click delegation for a swatch row — moves the selection to the clicked swatch. */
function wireHuePicker(sel) {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.hue-swatch');
    if (!btn || !el.contains(btn)) return;
    for (const b of el.querySelectorAll('.hue-swatch')) {
      const on = b === btn;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  });
}

function wsAgents(w) {
  return w && Array.isArray(w.agents) ? w.agents.filter(Boolean) : [];
}

function wsLiveAgents(w) {
  return wsAgents(w).filter((a) => a.status !== 'retired');
}

// Planet/node glow color — one recipe for both universe metaphors.
function wsGlow(hue, alpha) {
  return 'hsla(' + hue + ',70%,55%,' + alpha + ')';
}

// Cumulative spend: total tokens (input + output), every agent row counts,
// retired generations included (ruling #15; tokens-never-dollars per #11).
// ||0 keeps this correct while the server predates total_input_tokens.
function wsTokenSpend(w) {
  return wsAgents(w).reduce(
    (s, a) => s + (Number(a.total_input_tokens) || 0) + (Number(a.total_output_tokens) || 0),
    0,
  );
}

function workingCount(w) {
  return wsAgents(w).filter((a) => a.status === 'working').length;
}

// Moons: every live agent, plus the most recent retired ones up to a cap.
// Real workspaces accumulate retired generations (50+ rows) — a moon per row
// would be an unreadable solid ring; the design assumed a ~5-agent crew.
const MOON_MAX = 12;
function moonAgents(w) {
  const live = wsLiveAgents(w);
  const retired = wsAgents(w).filter((a) => a.status === 'retired');
  return live.slice(0, MOON_MAX).concat(retired.slice(-Math.max(0, MOON_MAX - live.length)));
}

// Context-meter cutoffs (lead ruling #7) — hover card and agent strip share them.
function burnClass(ratio) {
  return ratio > 0.9 ? 'crit' : ratio > 0.7 ? 'warn' : 'ok';
}

// Mean context burn across live (non-retired) agents.
function avgCtx(w) {
  const live = wsLiveAgents(w).filter((a) => Number(a.context_limit) > 0);
  if (!live.length) return { pct: 0, cls: 'ok' };
  const ratio = live.reduce((s, a) =>
    s + Math.min((Number(a.context_tokens) || 0) / Number(a.context_limit), 1), 0) / live.length;
  return { pct: Math.round(ratio * 100), cls: burnClass(ratio) };
}

function moonClass(status) {
  return status === 'working' ? 'moon-working' : status === 'retired' ? 'moon-retired' : 'moon-idle';
}

function wsStatusMeta(w) {
  const running = w.running !== false;
  const act = workingCount(w);
  const n = wsLiveAgents(w).length; // live crew size, not every retired generation
  return {
    label: running ? (n + ' AGENTS · ' + (act ? act + ' ACTIVE' : 'IDLE')) : (n + ' AGENTS · PAUSED'),
    cls: running ? (act ? 'st-active' : 'st-idle') : 'st-paused'
  };
}

function orbHTML(w, i) {
  const pos = ORB_POSITIONS[i % ORB_POSITIONS.length];
  const crew = wsLiveAgents(w);
  const hue = wsHueOf(w);
  const size = 96 + Math.min(crew.length, 5) * 10;
  const body = Math.round(size * 0.62);
  const moonR = Math.round(body / 2 + 17);
  const orbit = moonR * 2;
  const reticle = orbit + 24;
  const dim = w.running === false;
  const meta = wsStatusMeta(w);
  const spin = 26 + Math.min(crew.length, 8) * 3;
  const floatDur = 7 + (String(w.id).length % 4);
  const floatDelay = (String(w.id).length % 5) * 0.6;
  const moonList = moonAgents(w);
  const moons = moonList.map((a, j) =>
    '<span class="moon ' + moonClass(a.status) + '" style="transform:translate(-50%,-50%) rotate(' +
    Math.round(j * (360 / moonList.length)) + 'deg) translateY(-' + moonR + 'px)"></span>'
  ).join('');
  const glow = wsGlow(hue, dim ? 0.25 : 0.5);
  const glowSoft = wsGlow(hue, dim ? 0.08 : 0.18);
  return (
    '<button type="button" class="orb" data-ws="' + esc(w.id) + '"' +
    ' aria-label="Enter workspace ' + esc(w.name || w.id) + '"' +
    ' style="left:' + pos.x + '%;top:' + pos.y + '%;width:' + size + 'px;height:' + size + 'px;' +
    '--float-dur:' + floatDur + 's;--float-delay:' + floatDelay + 's;' + (dim ? 'opacity:.72;' : '') + '">' +
    '<span class="orb-reticle" aria-hidden="true" style="width:' + reticle + 'px;height:' + reticle + 'px">' +
    '<span class="orb-reticle-ring"></span></span>' +
    '<span class="orb-ring" aria-hidden="true" style="width:' + orbit + 'px;height:' + orbit + 'px"></span>' +
    '<span class="orb-moons" aria-hidden="true" style="width:' + orbit + 'px;height:' + orbit + 'px;' +
    '--spin:' + spin + 's">' + moons + '</span>' +
    '<span class="orb-body" aria-hidden="true" style="width:' + body + 'px;height:' + body + 'px;' +
    'background:radial-gradient(circle at 36% 32%, hsl(' + hue + ' 60% 72%), hsl(' + hue + ' 55% 52%) 52%, hsl(' + hue + ' 60% 26%) 100%);' +
    'box-shadow:inset -8px -10px 26px rgba(0,0,0,0.55),0 0 34px ' + glow + ',0 0 78px ' + glowSoft + '"></span>' +
    '<span class="orb-label" aria-hidden="true">' +
    '<span class="orb-name">' + esc(w.name || w.id) + '</span>' +
    '<span class="orb-stat mono ' + meta.cls + '">' + esc(meta.label) + '</span>' +
    '</span></button>'
  );
}

function netNodeHTML(w, i) {
  const pos = NET_POSITIONS[i % NET_POSITIONS.length];
  const agents = wsLiveAgents(w);
  const hue = wsHueOf(w);
  const dim = w.running === false;
  const act = workingCount(w);
  const counts = w.task_counts || {};
  const meta = wsStatusMeta(w);
  const stat = w.running !== false
    ? (act ? act + ' ACTIVE · ' + (Number(counts.in_progress) || 0) + ' TASKS' : 'ONLINE · IDLE')
    : 'PAUSED';
  const glow = wsGlow(hue, dim ? 0.28 : 0.6);
  const glowSoft = wsGlow(hue, dim ? 0.08 : 0.2);
  return (
    '<button type="button" class="net-node" data-ws="' + esc(w.id) + '"' +
    ' aria-label="Enter workspace ' + esc(w.name || w.id) + '"' +
    ' style="left:' + pos.x + '%;top:' + pos.y + '%">' +
    '<span class="net-diamond" aria-hidden="true" style="--spin:' + (20 + agents.length * 2) + 's"></span>' +
    '<span class="net-pulse" aria-hidden="true" style="border-color:hsla(' + hue + ',70%,62%,0.55);' +
    'box-shadow:0 0 18px ' + glow + '"></span>' +
    '<span class="net-core" aria-hidden="true" style="background:radial-gradient(circle at 38% 32%, hsl(' +
    hue + ' 60% 74%), hsl(' + hue + ' 55% 50%) 70%);box-shadow:0 0 16px ' + glow + ',0 0 34px ' + glowSoft + ';' +
    (dim ? 'opacity:.7;' : '') + '"></span>' +
    '<span class="orb-label" aria-hidden="true">' +
    '<span class="orb-name net-name">' + esc(w.name || w.id) + '</span>' +
    '<span class="orb-stat mono ' + meta.cls + '">' + esc(stat) + '</span>' +
    '</span></button>'
  );
}

// Signature of everything that affects universe-layer DOM; skipping no-op
// rebuilds keeps the CSS orbit/float animations from restarting on frames.
let universeSig = '';

function renderUniverse() {
  if (state.view !== 'universe') return;

  const list = state.workspaces.filter(Boolean);
  const online = list.filter((w) => w.running !== false).length;
  const active = list.reduce((s, w) => s + workingCount(w), 0);
  $('#hud-online').textContent = list.length ? online + '/' + list.length : '—';
  $('#hud-agents').textContent = String(active);
  $('#core-online').textContent = online + '/' + list.length + ' WORKSPACES';
  // SPEND = fleet total-token figure (input + output), all generations incl. retired (ruling #15).
  const spendEl = $('#hud-spend');
  spendEl.textContent = fmtTokens(list.reduce((s, w) => s + wsTokenSpend(w), 0));
  spendEl.title = 'Total tokens (input + output, incl. cache reads), all workspaces & generations';

  const isNet = state.metaphor === 'network';
  $('#orb-layer').hidden = isNet;
  $('#net-layer').hidden = !isNet;
  $('#orbit-legend').hidden = isNet;
  $('#metaphor-btn').textContent = isNet ? '◉ Orbit' : '⬡ Network';

  const sig = state.metaphor + '|' + list.map((w) =>
    [w.id, w.name, w.running !== false, wsAgents(w).map((a) => a.status).join(''),
      (w.task_counts && w.task_counts.in_progress) || 0].join(':')
  ).join(';');
  if (sig !== universeSig) {
    universeSig = sig;
    if (isNet) $('#net-layer').innerHTML = list.map(netNodeHTML).join('');
    else $('#orb-layer').innerHTML = list.map(orbHTML).join('');
  }

  // Re-apply hover state across rebuilds (or drop it if the planet is gone).
  if (state.hoverId) {
    const orb = document.querySelector('[data-ws="' + CSS.escape(state.hoverId) + '"]');
    if (orb) { orb.classList.add('hovered'); renderHoverCard(); }
    else clearHover();
  }
}

/* ---- hover telemetry card ------------------------------------------------ */

function setHover(id, e) {
  state.hoverId = id;
  for (const el of document.querySelectorAll('.orb.hovered, .net-node.hovered')) {
    el.classList.remove('hovered');
  }
  const orb = document.querySelector('[data-ws="' + CSS.escape(id) + '"]');
  if (orb) orb.classList.add('hovered');
  renderHoverCard();
  if (e) positionHoverCard(e.clientX, e.clientY);
}

function clearHover() {
  state.hoverId = null;
  for (const el of document.querySelectorAll('.orb.hovered, .net-node.hovered')) {
    el.classList.remove('hovered');
  }
  $('#hover-card').hidden = true;
}

function renderHoverCard() {
  const card = $('#hover-card');
  const w = state.workspaces.find((x) => x && x.id === state.hoverId);
  if (!w) { card.hidden = true; return; }
  const running = w.running !== false;
  const act = workingCount(w);
  const total = wsLiveAgents(w).length;
  const counts = w.task_counts || {};
  const ctx = avgCtx(w);
  card.innerHTML =
    '<div class="hcard">' +
    '<div class="hcard-head">' +
    '<span class="hcard-name">' + esc(w.name || w.id) + '</span>' +
    '<span class="hcard-status mono ' + (running ? 'st-active' : 'st-paused') + '">' +
    (running ? 'ONLINE' : 'PAUSED') + '</span>' +
    '</div>' +
    '<div class="hcard-path mono">' + esc(w.path || '') + '</div>' +
    '<div class="hcard-rule"></div>' +
    '<div class="hcard-grid">' +
    '<div><div class="hcard-lbl mono">ACTIVE AGENTS</div>' +
    '<div class="hcard-fig"><span class="hcard-act">' + act + '</span><span class="hcard-total">/' + total + '</span></div></div>' +
    '<div><div class="hcard-lbl mono">TOKEN SPEND</div>' +
    '<div class="hcard-fig hcard-spend" title="Total tokens (input + output, incl. cache reads), all generations">' + fmtTokens(wsTokenSpend(w)) + '</div></div>' +
    '<div><div class="hcard-lbl mono">CONTEXT BURN</div>' +
    '<div class="hcard-burn"><span class="hcard-bar"><span class="hcard-fill ' + ctx.cls + '" style="width:' + ctx.pct + '%"></span></span>' +
    '<span class="hcard-pct mono ' + ctx.cls + '">' + ctx.pct + '%</span></div></div>' +
    '<div><div class="hcard-lbl mono">TASK FLOW</div>' +
    '<div class="hcard-flow mono">' +
    '<span class="tf-prog" title="in progress">▸' + (Number(counts.in_progress) || 0) + '</span>' +
    '<span class="tf-blocked" title="blocked">■' + (Number(counts.blocked) || 0) + '</span>' +
    '<span class="tf-done" title="done">✓' + (Number(counts.done) || 0) + '</span>' +
    '</div></div>' +
    '</div>' +
    '<div class="hcard-cta mono">▸ CLICK TO ENTER WORKSPACE</div>' +
    '</div>';
  card.hidden = false;
}

function positionHoverCard(x, y) {
  const card = $('#hover-card');
  card.style.left = x + 'px';
  card.style.top = y + 'px';
  card.classList.toggle('flip', x > window.innerWidth * 0.6);
}

/* ---- starfield canvas + parallax (reduced-motion gated) ------------------ */

const universe = { stars: null, raf: 0, mx: 0, my: 0 };

function initStars() {
  universe.stars = [];
  for (let i = 0; i < 520; i++) {
    universe.stars.push({
      x: Math.random(), y: Math.random(),
      z: 0.22 + Math.random() * 0.95,
      r: Math.random() * 1.5 + 0.35,
      tw: Math.random() * 6.28
    });
  }
}

function starPalette() {
  return document.documentElement.classList.contains('theme-light')
    ? { star: '58,91,109', line: '20,120,160' }
    : { star: '191,230,245', line: '90,200,235' };
}

function drawStars(t) {
  const c = $('#star-canvas');
  if (!c) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const P = starPalette();

  if (universe.stars) {
    for (const s of universe.stars) {
      const px = s.x * w + universe.mx * 40 * s.z;
      const py = s.y * h + universe.my * 40 * s.z;
      const a = (0.35 + 0.4 * Math.sin(t * 0.0012 + s.tw)) * s.z;
      ctx.beginPath();
      ctx.arc(px, py, s.r * s.z, 0, 6.28);
      ctx.fillStyle = 'rgba(' + P.star + ',' + a.toFixed(3) + ')';
      ctx.fill();
    }
  }

  // Bus connection lines: hub ↔ each live workspace (+ ring links in network mode).
  const isNet = state.metaphor === 'network';
  const POSITIONS = isNet ? NET_POSITIONS : ORB_POSITIONS;
  const off = isNet ? 16 : 22;
  const hub = { x: 0.5 * w, y: 0.52 * h };
  const list = state.workspaces.filter(Boolean);
  const link = (a, b, live) => {
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    const base = live ? P.line : '90,110,120';
    grad.addColorStop(0, 'rgba(' + base + ',0.30)');
    grad.addColorStop(1, 'rgba(' + base + ',0.06)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    if (live && motionOK()) {
      const prog = ((t * 0.00016) + ((a.x + b.y) * 0.0007)) % 1;
      ctx.beginPath();
      ctx.arc(a.x + (b.x - a.x) * prog, a.y + (b.y - a.y) * prog, 2.2, 0, 6.28);
      ctx.fillStyle = 'rgba(' + P.line + ',0.9)';
      ctx.fill();
    }
  };
  const pos = list.map((wsp, i) => {
    const L = POSITIONS[i % POSITIONS.length];
    return { x: L.x / 100 * w + universe.mx * off, y: L.y / 100 * h + universe.my * off, running: wsp.running !== false };
  });
  for (const p of pos) link(hub, p, p.running);
  if (isNet && pos.length > 1) {
    for (let i = 0; i < pos.length; i++) {
      const a = pos[i], b = pos[(i + 1) % pos.length];
      if (pos.length === 2 && i === 1) break; // avoid drawing the same pair twice
      link(a, b, a.running && b.running);
    }
  }
}

function starLoop(t) {
  drawStars(t);
  universe.raf = requestAnimationFrame(starLoop);
}

function startUniverseFX() {
  stopUniverseFX();
  if (state.view !== 'universe') return;
  if (!universe.stars) initStars();
  if (motionOK()) universe.raf = requestAnimationFrame(starLoop);
  else drawStars(0); // reduced motion: one static frame, no rAF
}

function stopUniverseFX() {
  if (universe.raf) cancelAnimationFrame(universe.raf);
  universe.raf = 0;
}

function onUniverseMove(e) {
  if (state.view !== 'universe') return;
  if (motionOK()) {
    universe.mx = (e.clientX / window.innerWidth - 0.5) * 2;
    universe.my = (e.clientY / window.innerHeight - 0.5) * 2;
    $('#orb-layer').style.transform =
      'translate(' + (universe.mx * 22) + 'px,' + (universe.my * 22) + 'px)';
    $('#net-layer').style.transform =
      'translate(' + (universe.mx * 16) + 'px,' + (universe.my * 16) + 'px)';
  }
  if (state.hoverId) positionHoverCard(e.clientX, e.clientY);
}

function toggleMetaphor() {
  state.metaphor = state.metaphor === 'network' ? 'orbit' : 'network';
  clearHover();
  renderUniverse();
}

/* ==========================================================================
 * Render — detail rail (identity block) + directive banner
 * ======================================================================== */

function renderRail() {
  const ws = activeWorkspace();
  const running = !!ws && ws.running !== false;
  $('#hdr-ws-name').textContent = ws ? (ws.name || ws.id) : 'No workspace';
  $('#hdr-ws-path').textContent = ws ? (ws.path || '') : '';
  const pill = $('#ws-status');
  pill.classList.toggle('ws-running', running);
  pill.classList.toggle('ws-paused', !running);
  $('#ws-status-label').textContent = ws ? (running ? 'RUNNING' : 'PAUSED') : '—';
  const btn = $('#pause-btn');
  btn.disabled = !ws;
  btn.textContent = !ws || running ? '❚❚ Pause' : '▶ Resume';
  btn.classList.toggle('btn-resume', !!ws && !running);
  $('#settings-btn').disabled = !ws;
  $('#delete-btn').disabled = !ws;
}

// Latest posted goal, surfaced read-only from the goal_posted event feed.
function renderDirective() {
  let text = '';
  for (let i = state.events.length - 1; i >= 0; i--) {
    const ev = state.events[i];
    if (ev && ev.type === 'goal_posted' && ev.payload && ev.payload.text) {
      text = String(ev.payload.text);
      break;
    }
  }
  const el = $('#directive-text');
  el.textContent = text || 'No directive posted yet — set one below.';
  el.classList.toggle('directive-empty', !text);
}

/* ==========================================================================
 * Render — agent strip
 * ======================================================================== */

function renderAgents() {
  const wrap = $('#agent-cards');
  const ws = activeWorkspace();
  const agents = ws && Array.isArray(ws.agents) ? ws.agents : [];
  $('#team-count').textContent = String(agents.length);
  if (!ws) { wrap.innerHTML = '<div class="strip-empty">Select a workspace to see its crew.</div>'; return; }
  if (!agents.length) { wrap.innerHTML = '<div class="strip-empty">No agents in this workspace yet.</div>'; return; }

  // Ruling #13: live lead pinned first, then working > idle > retired; ties keep
  // server order (sort() is stable). Display-only — never mutate ws.agents.
  const isLiveLead = (a) => !!(a && a.role === 'lead' && a.status !== 'retired');
  const statusRank = (a) => {
    const s = a && (a.status === 'working' || a.status === 'retired') ? a.status : 'idle';
    return s === 'working' ? 0 : s === 'idle' ? 1 : 2;
  };
  const ordered = agents.slice().sort((x, y) =>
    (isLiveLead(y) - isLiveLead(x)) || (statusRank(x) - statusRank(y)));

  wrap.innerHTML = ordered.map((a) => {
    if (!a) return '';
    const status = a.status === 'working' || a.status === 'retired' ? a.status : 'idle';
    const tokens = Number(a.context_tokens) || 0;
    const limit = Number(a.context_limit) || 0;
    const ratio = limit > 0 ? Math.min(tokens / limit, 1) : 0;
    const pct = Math.round(ratio * 100);
    const meterCls = burnClass(ratio);
    // Retired agents keep a static label; live agents get a quick model switch.
    const current = String(a.model || '');
    const modelHTML = status === 'retired'
      ? '<div class="agent-sub mono">' + esc(modelLabel(current)) + '</div>'
      : '<select class="agent-model mono" data-role="' + esc(a.role || '') + '"' +
        ' aria-label="Model for ' + esc(a.role || 'agent') + '" title="Switch model">' +
        modelOptionsHTML(current, state.models) +
        '</select>';
    return (
      '<div class="agent-card st-' + status + '" data-agent="' + esc(a.id) + '"' +
      ' role="button" tabindex="0" title="View turn history">' +
      '<div class="agent-top">' +
      '<span class="agent-role">' + esc(a.role || 'agent') + '</span>' +
      '<span class="agent-gen mono">G' + (Number(a.generation) || 1) + '</span>' +
      '</div>' +
      '<div class="agent-name">' + esc(a.name || a.id) + '</div>' +
      modelHTML +
      '<div class="status-pill sp-' + status + '"><span class="pill-dot"></span>' + esc(status) + '</div>' +
      '<div class="meter" title="Context: ' + fmtTokens(tokens) + ' / ' + fmtTokens(limit) + '">' +
      '<div class="meter-fill ' + meterCls + '" style="width:' + pct + '%"></div>' +
      '</div>' +
      '<div class="agent-stats mono">' + fmtTokens(tokens) + '/' + fmtTokens(limit) +
      ' ctx · ' + (Number(a.turns) || 0) + ' turns</div>' +
      '</div>'
    );
  }).join('');
}

async function changeAgentModel(role, model) {
  const ws = activeWorkspace();
  if (!ws || !role) return;
  const res = await api(
    '/api/workspaces/' + encodeURIComponent(ws.id) + '/roles/' + encodeURIComponent(role),
    jsonOpts('PATCH', { model })
  );
  if (res && res.id !== undefined) upsertById(ws.agents, res); // updated agent object
  // On failure api() has already toasted; re-rendering reverts the select.
  renderAgents();
}

/* ==========================================================================
 * Render — task board
 * ======================================================================== */

function renderBoard() {
  const wrap = $('#board-columns');
  const ws = activeWorkspace();
  if (!ws) {
    wrap.innerHTML =
      '<div class="board-empty"><div class="board-empty-title">Nothing on the board</div>' +
      '<div class="board-empty-sub">' +
      (state.workspaces.length
        ? 'Select a workspace from the sidebar.'
        : 'No workspaces are registered with the server yet. Start one and it will show up on the left.') +
      '</div></div>';
    return;
  }

  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = [];
  for (const t of state.tasks) {
    if (t && byStatus[t.status]) byStatus[t.status].push(t);
  }
  for (const s of STATUSES) {
    byStatus[s].sort((a, b) =>
      (Number(a.priority) || 2) - (Number(b.priority) || 2) ||
      (Number(a.created_at) || 0) - (Number(b.created_at) || 0));
  }

  wrap.innerHTML = STATUSES.map((s) => (
    '<div class="board-col col-' + s + '">' +
    '<div class="col-head"><span class="col-name">' + esc(STATUS_LABELS[s]) + '</span>' +
    '<span class="col-count mono">' + byStatus[s].length + '</span></div>' +
    '<div class="col-cards">' +
    (byStatus[s].map(taskCardHTML).join('') || '<div class="col-empty">—</div>') +
    '</div></div>'
  )).join('');
}

function taskCardHTML(t) {
  const prio = Number(t.priority) || 2;
  const options = STATUSES.map((s) =>
    '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' +
    esc(STATUS_LABELS[s]) + '</option>').join('');
  return (
    '<div class="task-card prio-' + prio + '">' +
    '<div class="task-title">' + esc(t.title || '(untitled)') + '</div>' +
    (t.description ? '<div class="task-desc">' + esc(t.description) + '</div>' : '') +
    '<div class="task-meta">' +
    (t.assignee_role ? '<span class="chip chip-role">' + esc(t.assignee_role) + '</span>' : '') +
    '<span class="chip chip-prio p' + prio + '">P' + prio + '</span>' +
    '<span class="task-time mono">' + fmtTime(t.updated_at || t.created_at) + '</span>' +
    '</div>' +
    '<select class="status-select" data-task="' + esc(t.id) + '" aria-label="Task status">' +
    options + '</select>' +
    '</div>'
  );
}

/* ==========================================================================
 * Render — right panel (Comms / Activity)
 * ======================================================================== */

let panelLastTab = null; // last tab rendered into #panel-feed; a change forces a pin

function renderPanel(opts) {
  $('#tab-comms').classList.toggle('active', state.tab === 'comms');
  $('#tab-comms').setAttribute('aria-selected', String(state.tab === 'comms'));
  $('#tab-activity').classList.toggle('active', state.tab === 'activity');
  $('#tab-activity').setAttribute('aria-selected', String(state.tab === 'activity'));

  // Composer is Comms-only (ruling #16). It is a SIBLING of #panel-feed, so
  // the innerHTML swap below never touches it (typing/focus survive re-renders).
  const composer = $('#msg-form');
  composer.hidden = state.tab !== 'comms';
  if (composer.hidden) closeMentionPopup();

  const feed = $('#panel-feed');
  const tabChanged = panelLastTab !== state.tab;
  panelLastTab = state.tab;
  // Sticky-bottom: only live-tail when the reader was already at (or near) the
  // bottom; otherwise hold their reading position. Content appends at the
  // bottom, so restoring the old scrollTop is stable.
  const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 40;
  const prevScrollTop = feed.scrollTop;
  feed.innerHTML = state.tab === 'comms' ? commsHTML() : activityHTML();
  if ((opts && opts.pin) || tabChanged || wasAtBottom) {
    feed.scrollTop = feed.scrollHeight; // newest last, pin to bottom
  } else {
    feed.scrollTop = prevScrollTop;
  }
  renderUnread();
}

function renderUnread() {
  const badge = $('#unread-badge');
  if (state.panelCollapsed && state.unread > 0) {
    badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function setPanelCollapsed(collapsed) {
  state.panelCollapsed = !!collapsed;
  lsSet('mc.panelCollapsed', collapsed ? '1' : '0');
  document.body.classList.toggle('panel-collapsed', state.panelCollapsed);
  const toggle = $('#panel-toggle');
  toggle.setAttribute('aria-expanded', String(!state.panelCollapsed));
  toggle.setAttribute('aria-label', state.panelCollapsed ? 'Expand panel' : 'Collapse panel');
  $('#panel-chevron').textContent = state.panelCollapsed ? '‹' : '›';
  if (!state.panelCollapsed) state.unread = 0; // expanding clears unread
  renderPanel({ pin: true });
}

/* ==========================================================================
 * Panel resize — drag handle on the panel's left edge (ruling #18)
 * ======================================================================== */

const PANEL_W_MIN = 280;

function panelWMax() {
  return Math.round(window.innerWidth * 0.6); // ruling #18 clamp: [280px, 60vw]
}

function currentPanelWidth() {
  const inline = $('#detail-view').style.getPropertyValue('--panel-w');
  if (inline) return parseInt(inline, 10);
  const w = $('#right-panel').getBoundingClientRect().width;
  return w || 340;
}

function syncPanelResizeAria(w) {
  const handle = $('#panel-resize');
  handle.setAttribute('aria-valuemin', String(PANEL_W_MIN));
  handle.setAttribute('aria-valuemax', String(panelWMax()));
  handle.setAttribute('aria-valuenow', String(Math.round(w != null ? w : currentPanelWidth())));
}

function setPanelWidth(px, opts) {
  const w = Math.max(PANEL_W_MIN, Math.min(panelWMax(), Math.round(px)));
  $('#detail-view').style.setProperty('--panel-w', w + 'px');
  // Skip the sync localStorage write per pointermove; drags persist on release.
  if (!(opts && opts.defer)) lsSet('mc.panelWidth', String(w));
  syncPanelResizeAria(w);
}

function persistPanelWidth() {
  const inline = parseInt($('#detail-view').style.getPropertyValue('--panel-w'), 10);
  if (isNaN(inline)) return;
  lsSet('mc.panelWidth', String(inline));
}

function resetPanelWidth() {
  lsRemove('mc.panelWidth');
  $('#detail-view').style.removeProperty('--panel-w');
  syncPanelResizeAria(null);
}

function initPanelResize() {
  const handle = $('#panel-resize');
  let dragRight = 0; // panel's right edge, measured once per drag — not per move

  handle.addEventListener('pointerdown', (e) => {
    if (state.panelCollapsed) return;
    dragRight = $('#right-panel').getBoundingClientRect().right;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    setPanelWidth(dragRight - e.clientX, { defer: true });
  });
  const endDrag = () => { handle.classList.remove('dragging'); persistPanelWidth(); };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', resetPanelWidth);
  handle.addEventListener('keydown', (e) => {
    const cur = currentPanelWidth();
    let w = null;
    if (e.key === 'ArrowLeft') w = cur + 16; // separator moves left → panel widens
    else if (e.key === 'ArrowRight') w = cur - 16;
    else if (e.key === 'Home') w = PANEL_W_MIN;
    else if (e.key === 'End') w = panelWMax();
    if (w !== null) { setPanelWidth(w); e.preventDefault(); }
  });

  const saved = parseInt(lsGet('mc.panelWidth'), 10);
  if (!isNaN(saved)) setPanelWidth(saved);
  else syncPanelResizeAria(null);
}

/* Comms bodies the user has expanded past the clamp (ruling #20) — keyed by
 * String(message id) so every poll re-render re-applies the state. */
const expandedMsgs = new Set();

function commsHTML() {
  if (!state.messages.length) {
    return '<div class="feed-empty">No messages on the bus yet.</div>';
  }
  const roles = activeRoles();
  return state.messages.map((m) => {
    if (!m) return '';
    const raw = m.body || '';
    // Clamp threshold from the DATA, never the DOM (ruling #20): >8 newlines
    // or >600 chars.
    const long = raw.split('\n').length > 9 || raw.length > 600;
    const expanded = expandedMsgs.has(String(m.id));
    return (
      '<div class="msg">' +
      '<div class="msg-head">' +
      '<span class="msg-from">' + esc(m.from_agent || '?') + '</span>' +
      '<span class="msg-arrow">→</span>' +
      '<span class="msg-to">' + esc(m.to_role || 'all') + '</span>' +
      '<span class="feed-time mono">' + fmtTime(m.created_at) + '</span>' +
      '</div>' +
      '<div class="msg-body' + (long ? (expanded ? ' expanded' : ' clamped') : '') + '">' +
      fmtBody(raw, roles) + '</div>' +
      (long
        ? '<button type="button" class="msg-expand" data-msg-id="' + esc(m.id) +
          '" aria-expanded="' + expanded + '">' + (expanded ? 'SHOW LESS' : 'SHOW MORE') +
          '</button>'
        : '') +
      (m.task_id ? '<div class="msg-task mono">task ' + esc(m.task_id) + '</div>' : '') +
      '</div>'
    );
  }).join('');
}

function activityHTML() {
  if (!state.events.length) {
    return '<div class="feed-empty">No activity yet.</div>';
  }
  return state.events.map((ev) => {
    if (!ev) return '';
    const p = ev.payload || {};
    const who = esc(ev.agent_name || ev.agent_id || '?');
    const time = '<span class="feed-time mono">' + fmtTime(ev.created_at) + '</span>';
    switch (ev.type) {
      case 'turn_start':
        return '<div class="ev ev-dim"><span class="ev-who">' + who +
          '</span> turn started' + time + '</div>';
      case 'turn_end':
        return '<div class="ev">' + time + '<span class="ev-who">' + who + '</span> turn ended' +
          '<span class="ev-detail mono">' + fmtTokens(p.input_tokens) + '→' +
          fmtTokens(p.output_tokens) + ' tok · ' +
          fmtDuration(p.duration_ms) + '</span>' +
          (p.summary ? '<div class="ev-text">' + fmtBody(p.summary) + '</div>' : '') +
          '</div>';
      case 'tool_use':
        return '<details class="ev ev-tool"><summary><span class="ev-who">' + who +
          '</span> <span class="mono">' + esc(p.tool || 'tool') + '</span>' + time +
          '</summary><div class="ev-text">' + fmtBody(p.detail || '') + '</div></details>';
      case 'agent_text':
        return '<div class="ev">' + time + '<span class="ev-who">' + who + '</span>' +
          '<div class="ev-text">' + fmtBody(p.text || '') + '</div></div>';
      case 'succession':
        return '<div class="ev ev-succession">' + time + '<span class="ev-who">' + who +
          '</span> succession: <span class="mono">' + esc(p.from || '?') + ' → ' +
          esc(p.to || '?') + '</span>' +
          (p.reason ? '<div class="ev-text">' + fmtBody(p.reason) + '</div>' : '') + '</div>';
      case 'goal_posted':
        return '<div class="ev ev-goal"><span class="ev-who">' + who + '</span> goal posted' +
          time + '</div>';
      case 'error':
        return '<div class="ev ev-error">' + time + '<span class="ev-who">' + who +
          '</span> error<div class="ev-text">' + fmtBody(p.message || 'unknown error') + '</div></div>';
      default:
        return '<div class="ev ev-dim"><span class="ev-who">' + who + '</span> ' +
          esc(ev.type || 'event') + time + '</div>';
    }
  }).join('');
}

/* ==========================================================================
 * Render — bottom bar
 * ======================================================================== */

function renderBottomBar() {
  const enabled = !!activeWorkspace();
  // The comms composer (#msg-form) lives in the right panel, not #bottom-bar,
  // but shares the workspace-gated enable state (ruling #16).
  for (const el of document.querySelectorAll('#bottom-bar input, #bottom-bar button, #msg-form input, #msg-form button')) {
    el.disabled = !enabled;
  }
  if (!enabled) closeMentionPopup();
}

/* ==========================================================================
 * Comms composer — inline @-mentions (ruling #16)
 * ======================================================================== */

/* Live roles of the active workspace — same derivation the old #msg-role
 * select used (non-retired agents, first-seen order). */
function activeRoles() {
  const ws = activeWorkspace();
  const roles = [];
  const agents = ws && Array.isArray(ws.agents) ? ws.agents : [];
  for (const a of agents) {
    if (a && a.role && a.status !== 'retired' && !roles.includes(a.role)) roles.push(a.role);
  }
  return roles;
}

/* Mentions are '@word' at the start or after a non-word char (so emails like
 * bob@lead.com never target). Both regexes below must stay identical. */
const MENTION_RE = /(^|[^a-z0-9_@-])@([a-z0-9_-]+)/gi;

/* Pure — node-smoke tested (ruling #16). The FIRST valid mention decides:
 * @all/@everyone → null (broadcast), a known role (case-insensitive) → that
 * role; invalid mentions are skipped; none valid → null. */
function parseMentionTarget(body, roles) {
  const re = new RegExp(MENTION_RE.source, 'gi');
  const text = String(body || '');
  let m;
  while ((m = re.exec(text))) {
    const word = m[2].toLowerCase();
    if (word === 'all' || word === 'everyone') return null;
    const role = (roles || []).find((r) => String(r).toLowerCase() === word);
    if (role) return role;
  }
  return null;
}

/* Wraps known @tokens in .mention spans. MUST be fed the already-esc()-escaped
 * body only: the wrapped token is [a-z0-9_-]+ and escaped entities contain no
 * '@', so no injection or entity-splitting path exists. */
function highlightMentions(escapedBody, roles) {
  const known = new Set(['all', 'everyone']);
  for (const r of KNOWN_ROLES) known.add(r.toLowerCase());
  for (const r of roles || []) known.add(String(r).toLowerCase());
  return escapedBody.replace(new RegExp(MENTION_RE.source, 'gi'), (match, pre, word) =>
    known.has(word.toLowerCase()) ? pre + '<span class="mention">@' + word + '</span>' : match);
}

/* Markdown-lite feed-body formatting (ruling #20). esc() runs FIRST; every
 * transform then rewrites the already-escaped string, so no input can open a
 * tag (same injection-safe pattern as #16). Order is code → bold → mentions:
 * escaped entities contain no backtick or '*', so neither transform can split
 * one, and the inserted tags are inert to MENTION_RE: its pre-char class
 * allows '>' (so a mention right after an inserted tag still matches), while
 * the word class stops before the tag's own letters. Mentions run only when roles
 * is passed (Comms) — Activity keeps its current no-mention rendering. */
function fmtBody(raw, roles) {
  let out = esc(raw);
  out = out.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  return roles ? highlightMentions(out, roles) : out;
}

const mention = { open: false, start: -1, items: [], index: 0 };

/* The '@word' being typed at the caret, or null if the caret isn't in one. */
function mentionContext(value, caret) {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && /[a-z0-9_@-]/i.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (!/^[a-z0-9_-]*$/i.test(query)) return null;
  return { start: at, query };
}

function updateMentionPopup() {
  const input = $('#msg-input');
  const caret = input.selectionStart === null ? input.value.length : input.selectionStart;
  const ctx = mentionContext(input.value, caret);
  if (!ctx) { closeMentionPopup(); return; }
  const q = ctx.query.toLowerCase();
  const items = ['all'].concat(activeRoles()).filter((r) => r.toLowerCase().startsWith(q));
  if (!items.length) { closeMentionPopup(); return; }
  if (!mention.open) mention.index = 0;
  mention.open = true;
  mention.start = ctx.start;
  mention.items = items;
  if (mention.index >= items.length) mention.index = 0;
  renderMentionPopup();
}

function renderMentionPopup() {
  const pop = $('#mention-popup');
  const input = $('#msg-input');
  pop.innerHTML = mention.items.map((r, i) =>
    '<div class="mention-opt' + (i === mention.index ? ' active' : '') + '" role="option"' +
    ' id="mention-opt-' + i + '" aria-selected="' + (i === mention.index) + '"' +
    ' data-role="' + esc(r) + '">@' + esc(r) + '</div>'
  ).join('');
  pop.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', 'mention-opt-' + mention.index);
  const active = pop.querySelector('.mention-opt.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function closeMentionPopup() {
  mention.open = false;
  const pop = $('#mention-popup');
  const input = $('#msg-input');
  if (!pop || !input) return;
  pop.hidden = true;
  pop.innerHTML = '';
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

/* Replace the in-progress '@word' with '@role ' and restore focus/caret. */
function applyMention(role) {
  const input = $('#msg-input');
  const caret = input.selectionStart === null ? input.value.length : input.selectionStart;
  const insert = '@' + role + ' ';
  input.value = input.value.slice(0, mention.start) + insert + input.value.slice(caret);
  const pos = mention.start + insert.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  closeMentionPopup();
}

/* ==========================================================================
 * First-run setup
 *
 * A brand-new clone has no projects and may have no Claude CLI. Without this the
 * dashboard renders an empty starfield and says nothing about why nothing happens.
 * Driven entirely by the `setup` block of GET /api/state.
 * ======================================================================== */

/**
 * True only when the server actually reported a verdict and it is negative. A missing
 * `node` block means "not probed", which must not be read as unsupported — same
 * benefit-of-the-doubt the server gives with `report?.ok ?? true`.
 */
function nodeUnsupported(s) {
  return !!(s && s.node && s.node.ok === false);
}

/**
 * Shown until the CLI is usable AND one project exists — unless dismissed this session.
 * An unsupported Node runtime also opens it: the app boots and serves on old Node, so
 * without this the browser reports "CLI connected" and never mentions the runtime.
 * It stays dismissible on purpose — refusing to dismiss would make the dashboard
 * unusable, which is the "boot should abort" policy call and that one is the owner's.
 */
function setupNeeded() {
  const s = state.setup;
  if (!s || state.setupDismissed) return false;
  return !s.cli || !s.cli.ready || !s.has_workspaces || nodeUnsupported(s);
}

function cmdRowHTML(cmd, label) {
  return (
    '<div class="setup-cmd"><code>' + esc(cmd) + '</code>' +
    '<button class="btn btn-sm setup-copy" type="button" data-cmd="' + esc(cmd) + '"' +
    ' aria-label="Copy: ' + esc(label) + '">Copy</button></div>'
  );
}

// Signature of everything the setup screen draws, so repeated renderAll() passes
// don't rebuild innerHTML and drop the listeners (or a "Copied" label) underneath.
let setupSig = '';

function renderSetup() {
  const back = $('#setup-backdrop');
  if (!back) return;
  const show = setupNeeded();
  back.hidden = !show;
  if (!show) { setupSig = ''; return; }

  const s = state.setup || {};
  const cli = s.cli || {};
  const sig = JSON.stringify([cli.ready, cli.version, cli.error, s.has_workspaces, s.auth && s.auth.mode,
    s.node && s.node.ok, s.node && s.node.version]);
  if (sig === setupSig) return;
  setupSig = sig;

  const warn = $('#setup-node-warn');
  const bad = nodeUnsupported(s);
  warn.hidden = !bad;
  if (bad) {
    const min = s.node.min_major;
    $('#setup-node-note').textContent =
      'This machine is running Node ' + s.node.version + '. Flightdeck needs Node ' +
      (min ? min + ' or newer' : 'a newer LTS') + '. It will start on older versions, but agent ' +
      'sessions and the local database are untested there and can fail in confusing ways. ' +
      'Install the current LTS from nodejs.org, then run `npm install` again.';
  }

  const cliBadge = $('#setup-cli-badge');
  const wsBadge = $('#setup-ws-badge');

  cliBadge.textContent = cli.ready ? 'connected' : 'action needed';
  cliBadge.className = 'setup-badge mono ' + (cli.ready ? 'is-ok' : 'is-todo');
  wsBadge.textContent = s.has_workspaces ? 'done' : 'waiting';
  wsBadge.className = 'setup-badge mono ' + (s.has_workspaces ? 'is-ok' : 'is-todo');

  let html;
  if (cli.ready) {
    const usingKey = s.auth && s.auth.mode === 'api-key';
    html =
      '<p class="setup-ok-line">✓ Claude CLI detected' +
      (cli.version ? ' <span class="setup-ver mono">' + esc(cli.version) + '</span>' : '') +
      '</p><p class="setup-note">' +
      (usingKey
        ? 'Using <code>ANTHROPIC_API_KEY</code> from your environment — turns bill to that key.'
        : 'Agents run through your signed-in CLI, so turns use your Claude subscription. No API key needed.') +
      '</p>';
  } else {
    html =
      '<p class="setup-note">Flightdeck drives the Claude Code CLI on this machine — that is how ' +
      'agents use your existing Claude subscription instead of a separate API bill. Install it, then sign in once:</p>' +
      cmdRowHTML('npm install -g @anthropic-ai/claude-code', 'install the Claude CLI') +
      cmdRowHTML('claude', 'sign in to the Claude CLI') +
      '<p class="setup-why">Run the second command in a terminal and follow the browser prompt. ' +
      'Already installed somewhere unusual? Set <code>"cliPath"</code> in <code>flightdeck.config.json</code>.</p>' +
      '<div class="setup-actions">' +
      '<button id="setup-recheck" class="btn btn-accent" type="button">Check again</button></div>' +
      (cli.error ? '<div class="setup-err">' + esc(String(cli.error).slice(0, 240)) + '</div>' : '');
  }
  $('#setup-cli-body').innerHTML = html;

  const recheck = $('#setup-recheck');
  if (recheck) recheck.addEventListener('click', recheckSetup);
  for (const b of $('#setup-cli-body').querySelectorAll('.setup-copy')) {
    b.addEventListener('click', () => copyText(b.dataset.cmd || '', b));
  }
}

function copyText(text, btn) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => toast('Copy failed — select the command manually.'));
  } else {
    toast('Copy is unavailable here — select the command manually.');
  }
}

/**
 * Re-probes the CLI server-side. Deliberately does NOT need a restart: restarting the
 * server would kill every running agent, so installing the CLI mid-session must be enough.
 */
async function recheckSetup() {
  const btn = $('#setup-recheck');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  const data = await api('/api/health?recheck=1');
  if (data && data.setup) state.setup = data.setup;
  renderSetup();
  if (data && data.setup && data.setup.cli && data.setup.cli.ready) toast('Claude CLI connected.');
  else if (data) toast('Still not finding the Claude CLI.');
}

/* ==========================================================================
 * Render — everything
 * ======================================================================== */

function renderAll() {
  renderSetup();
  renderUniverse();
  renderRail();
  renderAgents();
  renderBoard();
  renderPanel({ pin: true });
  renderBottomBar();
  renderDirective();
}

/* ==========================================================================
 * Turn-history modal
 * ======================================================================== */

async function openAgentModal(agentId) {
  const ws = activeWorkspace();
  const agent = ws && Array.isArray(ws.agents)
    ? ws.agents.find((a) => a && a.id === agentId)
    : null;
  $('#modal-title').textContent = agent
    ? (agent.name || agent.id) + ' — turn history'
    : 'Turn history';
  $('#modal-body').innerHTML = '<div class="feed-empty">Loading…</div>';
  $('#modal-backdrop').hidden = false;

  const turns = await api('/api/agents/' + encodeURIComponent(agentId) + '/turns');
  if ($('#modal-backdrop').hidden) return; // closed while loading
  if (!Array.isArray(turns)) {
    $('#modal-body').innerHTML = '<div class="feed-empty">Could not load turn history.</div>';
    return;
  }
  if (!turns.length) {
    $('#modal-body').innerHTML = '<div class="feed-empty">No turns recorded for this agent yet.</div>';
    return;
  }
  // Newest last from the server; show newest first in the modal.
  $('#modal-body').innerHTML = turns.slice().reverse().map((t) => {
    if (!t) return '';
    return (
      '<div class="turn">' +
      '<div class="turn-head mono">' +
      fmtTime(t.created_at) + ' · in ' + fmtTokens(t.input_tokens) +
      ' / out ' + fmtTokens(t.output_tokens) + ' tok · ' + fmtDuration(t.duration_ms) +
      '</div>' +
      '<div class="turn-block"><span class="turn-label">prompt</span>' +
      '<div class="turn-text">' + esc(t.prompt_preview || '') + '</div></div>' +
      '<div class="turn-block"><span class="turn-label">result</span>' +
      '<div class="turn-text">' + esc(t.result_preview || '') + '</div></div>' +
      '</div>'
    );
  }).join('');
}

function closeModal() {
  $('#modal-backdrop').hidden = true;
  $('#modal-body').innerHTML = '';
}

/* ==========================================================================
 * Actions
 * ======================================================================== */

async function togglePause() {
  const ws = activeWorkspace();
  if (!ws) return;
  const action = ws.running === false ? 'resume' : 'pause';
  const res = await api('/api/workspaces/' + encodeURIComponent(ws.id) + '/' + action,
    { method: 'POST' });
  if (res && typeof res.running === 'boolean') {
    ws.running = res.running;
    renderRail();
    renderUniverse();
  }
}

async function submitGoal() {
  const input = $('#goal-input');
  const text = input.value.trim();
  const ws = activeWorkspace();
  if (!text || !ws) return;
  const res = await postJSON('/api/workspaces/' + encodeURIComponent(ws.id) + '/goals',
    { text });
  if (res) {
    input.value = '';
    toast('Goal posted' + (res.task_id ? ' (' + res.task_id + ')' : ''));
  }
}

async function submitMessage() {
  const input = $('#msg-input');
  const body = input.value.trim();
  const ws = activeWorkspace();
  if (!body || !ws) return;
  closeMentionPopup();
  // Ruling #16: first valid @mention targets; @all/@everyone/none → broadcast.
  // Mention text stays in the body; exactly one post per submit.
  const toRole = parseMentionTarget(body, activeRoles());
  const res = await postJSON('/api/workspaces/' + encodeURIComponent(ws.id) + '/message',
    { body, to_role: toRole });
  if (res) { input.value = ''; input.focus(); }
}

async function changeTaskStatus(taskId, status) {
  const res = await api('/api/tasks/' + encodeURIComponent(taskId), jsonOpts('PATCH', { status }));
  if (res && res.id !== undefined) {
    upsertById(state.tasks, res);
  }
  // On failure the re-render below snaps the dropdown back to the true value.
  syncTaskCounts();
  renderBoard();
  renderUniverse();
}

/* ==========================================================================
 * Create-workspace modal
 * ======================================================================== */

// Options for a model <select>: an entry's label is shown when it has one, else its id, so a
// configured version reads at a glance. Never orphan a running agent — a current value the
// catalog no longer lists stays listed and selected instead of silently re-pointing.
function modelOptionsHTML(selected, models) {
  const list = modelCatalog(models);
  if (selected && !list.some((m) => m.id === selected)) list.unshift(modelEntry(selected));
  return list.map((m) =>
    '<option value="' + esc(m.id) + '"' + (m.id === selected ? ' selected' : '') + '>' +
    esc(m.label) + '</option>'
  ).join('');
}

// One checkbox + model select per known role, in their default state. Built at init and again
// on every modal open, so rows reflect the current catalog. The #create-roles change listener
// is delegated on the container, so replacing the rows keeps it bound.
function buildCreateRoleRows() {
  $('#create-roles').innerHTML = KNOWN_ROLES.map((role) => (
    '<div class="role-row">' +
    '<label class="role-check"><input type="checkbox" value="' + role + '"' +
    (DEFAULT_ROLES.includes(role) ? ' checked' : '') + '> ' + role +
    (role === 'grunt' ? ' <span class="role-note">runs haiku</span>' : '') +
    '</label>' +
    '<select class="role-model" data-role="' + role + '"' +
    (DEFAULT_ROLES.includes(role) ? '' : ' disabled') +
    ' aria-label="Model for ' + role + '">' +
    modelOptionsHTML(defaultModelFor(role), state.models) +
    '</select></div>'
  )).join('');
}

function openCreateModal() {
  $('#create-name').value = '';
  $('#create-path').value = '';
  buildCreateRoleRows(); // resets checks/models AND picks up a catalog that landed after init
  renderHuePicker('#create-hue', null); // default: derive the colour from the name
  $('#create-error').hidden = true;
  PICKERS.create.session += 1; // invalidate any pick-folder result from a previous open
  resetPickerUI('create');
  const btn = $('#create-submit');
  btn.disabled = false;
  btn.textContent = '＋ Deploy workspace';
  $('#create-backdrop').hidden = false;
  $('#create-name').focus();
}

// Set an inline form-error element's text and reveal it.
function showFormError(sel, msg) {
  const el = $(sel);
  el.textContent = msg;
  el.hidden = false;
}

function showCreateError(msg) {
  showFormError('#create-error', msg);
}

async function submitCreateWorkspace() {
  const name = $('#create-name').value.trim();
  const path = $('#create-path').value.trim();
  const roles = [];
  for (const row of document.querySelectorAll('#create-roles .role-row')) {
    const cb = row.querySelector('input[type="checkbox"]');
    const sel = row.querySelector('.role-model');
    if (cb && cb.checked) roles.push({ role: cb.value, model: sel ? sel.value : defaultModelFor(cb.value) });
  }
  $('#create-error').hidden = true;

  if (!name) { showCreateError('Name is required.'); return; }
  if (!path) { showCreateError('Path is required.'); return; }
  if (!roles.length) { showCreateError('Pick at least one role.'); return; }

  const btn = $('#create-submit');
  btn.disabled = true;
  btn.textContent = 'Deploying…';
  // Omit `hue` entirely on "Auto" so the server stores nothing and the id-derived colour stands.
  const hue = selectedHue('#create-hue');
  const payload = { name, path, roles };
  if (hue !== null) payload.hue = hue;
  const r = await request('/api/workspaces', jsonOpts('POST', payload));
  btn.disabled = false;
  btn.textContent = '＋ Deploy workspace';

  if (!r.ok) { showCreateError(r.error); return; }

  // Contract returns the workspace object; tolerate a wrapped { workspace } too.
  const created = r.data && r.data.id !== undefined ? r.data
    : (r.data && r.data.workspace) ? r.data.workspace : null;
  $('#create-backdrop').hidden = true;
  toast('Workspace deployed');
  await refreshWorkspaceList();
  if (created && created.id !== undefined) enterWorkspace(created.id);
}

/* ==========================================================================
 * Folder picking — native Finder dialog, inline browser as fallback.
 * Used by both the create modal and the settings modal ("picker keys").
 * ======================================================================== */

const PICKERS = {
  create: {
    input: '#create-path', btn: '#browse-btn', hint: '#picker-hint',
    panel: '#browser-panel', pathEl: '#browser-path', list: '#browser-list',
    err: '#browser-error', use: '#browser-use', modal: '#create-backdrop',
    newBtn: '#browser-new', newRow: '#browser-new-row', newName: '#browser-new-name',
    newCreate: '#browser-new-create', newCancel: '#browser-new-cancel',
    session: 0, current: null,
    showError: (msg) => showCreateError(msg)
  },
  settings: {
    input: '#settings-path', btn: '#settings-browse-btn', hint: '#settings-picker-hint',
    panel: '#settings-browser-panel', pathEl: '#settings-browser-path',
    list: '#settings-browser-list', err: '#settings-browser-error',
    use: '#settings-browser-use', modal: '#settings-backdrop',
    newBtn: '#settings-browser-new', newRow: '#settings-browser-new-row',
    newName: '#settings-browser-new-name', newCreate: '#settings-browser-new-create',
    newCancel: '#settings-browser-new-cancel',
    session: 0, current: null,
    showError: (msg) => showSettingsError(msg)
  }
};

let pickPending = false;             // a POST /api/pick-folder is in flight (server allows one)
let nativePickerUnsupported = false; // server said 501 (not macOS)

// Primary Browse action: native macOS Finder chooser via the server.
// Blocks server-side until the user picks or cancels (up to 5 min) — fetch
// has no default timeout, so we just await it.
async function pickFolder(key) {
  const p = PICKERS[key];
  if (!p || pickPending) return;
  if (nativePickerUnsupported) { toggleBrowser(key); return; }

  const btn = $(p.btn);
  const session = p.session;
  pickPending = true;
  btn.disabled = true;
  btn.textContent = 'Choose in Finder…';
  $(p.hint).hidden = false;

  const r = await request('/api/pick-folder', { method: 'POST' });

  pickPending = false;
  btn.disabled = false;
  btn.textContent = 'Browse';
  $(p.hint).hidden = true;
  // Ignore the result if the modal was closed (or closed and reopened) meanwhile.
  if (session !== p.session || $(p.modal).hidden) return;

  if (r.ok) {
    if (r.data && typeof r.data.path === 'string') $(p.input).value = r.data.path;
    return;
  }
  if (r.status === 410) return; // user cancelled — a no-op, not an error
  if (r.status === 501) {       // not macOS — fall back to the inline browser
    nativePickerUnsupported = true;
    openInlineBrowser(key);
    return;
  }
  p.showError(r.error);         // 409 dialog already open, 500, network
}

function browserOpen(key) {
  return !$(PICKERS[key].panel).hidden;
}

function toggleBrowser(key) {
  if (browserOpen(key)) closeBrowser(key);
  else openInlineBrowser(key);
}

function openInlineBrowser(key) {
  const p = PICKERS[key];
  if (browserOpen(key)) return;
  $(p.panel).hidden = false;
  $(p.pathEl).textContent = '…';
  browseTo(key, $(p.input).value.trim() || null);
}

function closeBrowser(key) {
  const p = PICKERS[key];
  $(p.panel).hidden = true;
  $(p.list).innerHTML = '';
  $(p.err).hidden = true;
  hideNewFolder(key);
  p.current = null;
}

/* ---- New folder: create a project directory without leaving the dashboard ---- */

function hideNewFolder(key) {
  const p = PICKERS[key];
  const row = $(p.newRow);
  if (!row) return;
  row.hidden = true;
  $(p.newName).value = '';
}

function showNewFolder(key) {
  const p = PICKERS[key];
  const row = $(p.newRow);
  if (!row || !p.current) return;
  row.hidden = false;
  const input = $(p.newName);
  input.value = '';
  input.focus();
}

async function createFolder(key) {
  const p = PICKERS[key];
  const name = $(p.newName).value.trim();
  if (!p.current) return;
  if (!name) { showBrowserError(key, 'Enter a folder name.'); return; }

  const btn = $(p.newCreate);
  btn.disabled = true;
  const r = await request('/api/mkdir', jsonOpts('POST', { parent: p.current, name }));
  btn.disabled = false;

  if (!r.ok) { showBrowserError(key, r.error); return; }
  const created = r.data && r.data.path;
  if (!created) { showBrowserError(key, 'Server did not return the new path.'); return; }

  // Select the folder we just made — creating it is only useful if it becomes the choice.
  hideNewFolder(key);
  $(p.input).value = created;
  await browseTo(key, created);
}

/** Wire one picker's New folder controls. Enter creates, Escape cancels without closing the modal. */
function wireNewFolder(key) {
  const p = PICKERS[key];
  const btn = $(p.newBtn);
  if (!btn) return;
  btn.addEventListener('click', () => showNewFolder(key));
  $(p.newCancel).addEventListener('click', () => hideNewFolder(key));
  $(p.newCreate).addEventListener('click', () => createFolder(key));
  $(p.newName).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createFolder(key); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideNewFolder(key); }
  });
}

function showBrowserError(key, msg) {
  const p = PICKERS[key];
  const el = $(p.err);
  el.textContent = msg;
  el.hidden = false;
}

// Collapse the browser and restore the Browse button/hint (unless a native
// pick is still pending — then the button legitimately stays busy).
function resetPickerUI(key) {
  const p = PICKERS[key];
  closeBrowser(key);
  if (!pickPending) {
    const btn = $(p.btn);
    btn.disabled = false;
    btn.textContent = 'Browse';
    $(p.hint).hidden = true;
  }
}

async function browseTo(key, path) {
  const p = PICKERS[key];
  const list = $(p.list);
  if (!list.innerHTML) list.innerHTML = '<div class="browser-empty">Loading…</div>';
  list.classList.add('loading');
  const url = '/api/browse' + (path ? '?path=' + encodeURIComponent(path) : '');
  const r = await request(url);
  list.classList.remove('loading');
  if (!browserOpen(key)) return; // collapsed while loading

  const errEl = $(p.err);
  if (!r.ok) {
    // Show the server's message, keep the previous listing on screen.
    errEl.textContent = r.error;
    errEl.hidden = false;
    if (list.querySelector('.browser-empty')) list.innerHTML = '';
    return;
  }
  errEl.hidden = true;
  renderBrowser(key, r.data || {});
}

function renderBrowser(key, data) {
  const p = PICKERS[key];
  p.current = typeof data.path === 'string' ? data.path : null;
  const pathEl = $(p.pathEl);
  pathEl.textContent = p.current || '(unknown)';
  pathEl.title = p.current || '';
  $(p.use).disabled = !p.current;

  const rows = [];
  if (typeof data.parent === 'string' && data.parent) {
    rows.push(
      '<button type="button" class="browser-row browser-up" data-path="' + esc(data.parent) + '">' +
      '.. <span class="browser-dim">(up)</span></button>'
    );
  }
  const dirs = Array.isArray(data.dirs) ? data.dirs : [];
  for (const d of dirs) {
    if (!d || typeof d.path !== 'string') continue;
    rows.push(
      '<button type="button" class="browser-row" data-path="' + esc(d.path) + '">' +
      esc(d.name || d.path) + '<span class="browser-dim">/</span></button>'
    );
  }
  $(p.list).innerHTML =
    rows.join('') || '<div class="browser-empty">No subfolders here.</div>';
}

function useBrowsedFolder(key) {
  const p = PICKERS[key];
  if (p.current) $(p.input).value = p.current;
  closeBrowser(key);
  $(p.input).focus();
}

/* ==========================================================================
 * Workspace settings modal
 * ======================================================================== */

let settingsOriginal = null; // last GET /settings response (normalized roles kept separately)
let settingsRoles = [];      // working copy: [{ role, model, prompt }]

function showSettingsError(msg) {
  showFormError('#settings-error', msg);
}

function normalizeRoles(list) {
  return (Array.isArray(list) ? list : []).map((x) => ({
    role: String((x && x.role) || ''),
    model: String((x && x.model) || 'sonnet'),
    prompt: typeof (x && x.prompt) === 'string' ? x.prompt : ''
  }));
}

async function openSettingsModal() {
  const ws = activeWorkspace();
  if (!ws) return;
  settingsOriginal = null;
  settingsRoles = [];
  PICKERS.settings.session += 1;
  resetPickerUI('settings');
  $('#settings-error').hidden = true;
  $('#settings-fields').hidden = true;
  $('#settings-loading').hidden = false;
  $('#settings-save').disabled = true;
  $('#settings-backdrop').hidden = false;

  const r = await request('/api/workspaces/' + encodeURIComponent(ws.id) + '/settings');
  if ($('#settings-backdrop').hidden) return; // closed while loading
  $('#settings-loading').hidden = true;
  if (!r.ok || !r.data) {
    showSettingsError(r.error || 'Could not load settings.');
    return;
  }
  settingsOriginal = r.data;
  settingsRoles = normalizeRoles(r.data.roles);
  $('#settings-name').value = r.data.name ?? '';
  $('#settings-path').value = r.data.path ?? '';
  $('#settings-context').value =
    (r.data.contextLimit === null || r.data.contextLimit === undefined) ? '' : r.data.contextLimit;
  $('#settings-tools').value =
    Array.isArray(r.data.extraAllowedTools) ? r.data.extraAllowedTools.join(', ') : '';
  renderHuePicker('#settings-hue', typeof r.data.hue === 'number' ? r.data.hue : null);
  renderSettingsRoles();
  $('#settings-fields').hidden = false;
  $('#settings-save').disabled = false;
}

function settingsKnownModels() {
  const km = settingsOriginal && settingsOriginal.known_models;
  return Array.isArray(km) && km.length ? km : state.models;
}

function settingsKnownRoles() {
  const kr = settingsOriginal && settingsOriginal.known_roles;
  return Array.isArray(kr) && kr.length ? kr.map(String) : KNOWN_ROLES;
}

function renderSettingsRoles() {
  const models = settingsKnownModels();
  const lastOne = settingsRoles.length <= 1;
  $('#settings-roles').innerHTML = settingsRoles.map((r, i) => (
    '<div class="settings-role">' +
    '<div class="settings-role-head">' +
    '<span class="settings-role-name mono">' + esc(r.role) + '</span>' +
    '<select class="settings-role-model" data-idx="' + i + '" aria-label="Model for ' + esc(r.role) + '">' +
    modelOptionsHTML(r.model, models) + '</select>' +
    '<button type="button" class="btn btn-ghost role-remove" data-idx="' + i + '"' +
    (lastOne ? ' disabled' : '') + ' aria-label="Remove role ' + esc(r.role) + '"' +
    (lastOne ? ' title="At least one role is required"' : '') + '>✕</button>' +
    '</div>' +
    '<textarea class="settings-prompt" data-idx="' + i + '" rows="2" spellcheck="false" ' +
    'placeholder="Prompt (empty = server default)">' + esc(r.prompt) + '</textarea>' +
    '</div>'
  )).join('');

  const present = settingsRoles.map((r) => r.role);
  const addable = settingsKnownRoles().filter((r) => !present.includes(r));
  const addSel = $('#settings-add-role');
  addSel.innerHTML = '<option value="">Add role…</option>' +
    addable.map((r) => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('');
  addSel.disabled = !addable.length;
}

function addSettingsRole(role) {
  if (!role || settingsRoles.some((r) => r.role === role)) return;
  settingsRoles.push({ role, model: defaultModelFor(role), prompt: '' });
  renderSettingsRoles();
}

function removeSettingsRole(idx) {
  if (settingsRoles.length <= 1) return; // at least one role must remain
  if (idx >= 0 && idx < settingsRoles.length) {
    settingsRoles.splice(idx, 1);
    renderSettingsRoles();
  }
}

// Build a PATCH body containing only the fields that actually changed.
function buildSettingsPatch() {
  const orig = settingsOriginal || {};
  const body = {};

  const name = $('#settings-name').value.trim();
  if (name && name !== String(orig.name ?? '')) body.name = name;

  const path = $('#settings-path').value.trim();
  if (path && path !== String(orig.path ?? '')) body.path = path;

  // null clears a stored hue back to the id-derived colour, so send it rather than omitting.
  const hue = selectedHue('#settings-hue');
  const origHue = (typeof orig.hue === 'number') ? orig.hue : null;
  if (hue !== origHue) body.hue = hue;

  const ctxRaw = $('#settings-context').value.trim();
  let ctx = null;
  if (ctxRaw !== '') {
    ctx = Number(ctxRaw);
    if (!Number.isFinite(ctx) || ctx < 20000) {
      return { error: 'Context limit must be a number of at least 20000, or empty for auto.' };
    }
  }
  const origCtx = (orig.contextLimit === undefined) ? null : orig.contextLimit;
  if (ctx !== origCtx) body.contextLimit = ctx;

  const tools = $('#settings-tools').value.split(',').map((s) => s.trim()).filter(Boolean);
  const origTools = Array.isArray(orig.extraAllowedTools) ? orig.extraAllowedTools : [];
  if (JSON.stringify(tools) !== JSON.stringify(origTools)) body.extraAllowedTools = tools;

  if (JSON.stringify(settingsRoles) !== JSON.stringify(normalizeRoles(orig.roles))) {
    body.roles = settingsRoles.map((r) => ({ role: r.role, model: r.model, prompt: r.prompt }));
  }
  return { body };
}

async function saveSettings() {
  const ws = activeWorkspace();
  if (!ws || !settingsOriginal) return;
  $('#settings-error').hidden = true;

  const patch = buildSettingsPatch();
  if (patch.error) { showSettingsError(patch.error); return; }
  if (!Object.keys(patch.body).length) {
    $('#settings-backdrop').hidden = true;
    toast('No changes to save');
    return;
  }

  const btn = $('#settings-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const r = await request('/api/workspaces/' + encodeURIComponent(ws.id), jsonOpts('PATCH', patch.body));
  btn.disabled = false;
  btn.textContent = 'Save changes';

  if (!r.ok) { showSettingsError(r.error); return; } // incl. 409 role removal while busy
  $('#settings-backdrop').hidden = true;
  toast('Settings saved');
  await refreshWorkspaceList();
  if (state.activeId) selectWorkspace(state.activeId);
}

/* ==========================================================================
 * Delete-workspace confirmation
 * ======================================================================== */

function openDeleteModal() {
  const ws = activeWorkspace();
  if (!ws) return;
  $('#delete-text').textContent =
    'Decommission “' + (ws.name || ws.id) +
    '”? This retires every agent and purges all tasks, messages and telemetry. This cannot be undone.';
  $('#delete-error').hidden = true;
  const btn = $('#delete-confirm');
  btn.disabled = false;
  btn.textContent = 'Decommission';
  $('#delete-backdrop').hidden = false;
  $('#delete-cancel').focus();
}

async function confirmDeleteWorkspace() {
  const ws = activeWorkspace();
  if (!ws) { $('#delete-backdrop').hidden = true; return; }
  const btn = $('#delete-confirm');
  btn.disabled = true;
  btn.textContent = 'Decommissioning…';
  const r = await request('/api/workspaces/' + encodeURIComponent(ws.id), { method: 'DELETE' });
  btn.disabled = false;
  btn.textContent = 'Decommission';

  if (!r.ok) {
    showFormError('#delete-error', r.error); // e.g. 409: agents mid-turn — retry shortly
    return;
  }
  $('#delete-backdrop').hidden = true;
  toast('Workspace decommissioned');
  state.activeId = null;
  state.tasks = [];
  state.messages = [];
  state.events = [];
  setView('universe'); // back to the fleet; the planet disappears on refresh
  writeRoute(true);    // replace, not push — never leave a deleted id in history
  loadState();
}

// Wire a modal's close/cancel buttons plus backdrop self-click to hide it.
function bindModalDismiss(backdropSel, btnSels) {
  const hide = () => { $(backdropSel).hidden = true; };
  for (const sel of btnSels) $(sel).addEventListener('click', hide);
  $(backdropSel).addEventListener('click', (e) => { if (e.target === e.currentTarget) hide(); });
}

function closeTopModal() {
  for (const id of ['#modal-backdrop', '#create-backdrop', '#settings-backdrop', '#delete-backdrop']) {
    const el = $(id);
    if (el && !el.hidden) {
      el.hidden = true;
      if (id === '#modal-backdrop') $('#modal-body').innerHTML = '';
      return true;
    }
  }
  return false;
}

/* ==========================================================================
 * Theme (Stark-HUD: dark default, light via .theme-light on <html>)
 * ======================================================================== */

function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.classList.toggle('theme-light', light);
  for (const btn of document.querySelectorAll('.theme-toggle')) {
    btn.textContent = light ? '☾' : '☀';
  }
  lsSet('mc.theme', light ? 'light' : 'dark');
  // Reduced-motion shows a static starfield frame — repaint it in the new palette.
  if (state.view === 'universe' && !motionOK()) drawStars(0);
}

function initTheme() {
  const theme = lsGet('mc.theme') === 'light' ? 'light' : 'dark';
  applyTheme(theme);
  // Scanline overlay toggle (design prop, default on; no chrome for it in the
  // design — flip via localStorage mc.scanlines = '0').
  document.documentElement.classList.toggle('no-scanlines', lsGet('mc.scanlines') === '0');
}

/* ==========================================================================
 * JARVIS voice (ruling #12) — push-to-talk mic → answer over live fleet
 * state → spoken + displayed transcript. Source: the design's own logic
 * (Flightdeck.dc.html L639-692) on real data; spend intents answer in
 * total tokens (input + output) per ruling #15, never dollars.
 * ======================================================================== */

let jarvisRec = null;

// Diacritic-insensitive lowercase, so "cafe" matches a "CAFÉ" workspace name.
function normSpeech(s) {
  // Also strip separators/punctuation so spoken "data hub" / "mission control"
  // match "DataHub" / "flightdeck" workspace names. Matching only, never displayed.
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// fmtTokens for speech — same branch/rounding shape, spoken units.
// Trailing .0 stripped so speech says "2 million", not "2.0 million".
function spokenTokens(n) {
  const p = tokenParts(n);
  const word = p.unit === 'M' ? ' million' : p.unit === 'k' ? ' thousand' : '';
  return p.num.replace(/\.0$/, '') + word;
}

// Count + noun with number agreement ("1 agent", "3 agents").
function sayN(n, noun) {
  const v = Number(n) || 0;
  return v + ' ' + noun + (v === 1 ? '' : 's');
}

function jarvisListening() {
  return $('#jarvis-btn').classList.contains('listening');
}

function setJarvisListening(on) {
  const btn = $('#jarvis-btn');
  btn.classList.toggle('listening', on);
  btn.setAttribute('aria-pressed', String(on));
}

// Recognized speech is untrusted — textContent only, never innerHTML.
function setJarvisText(text) {
  const card = $('#jarvis-transcript');
  card.querySelector('.jarvis-text').textContent = text;
  card.hidden = !text;
  clearTimeout(jarvisTimer);
}

function micToggle() {
  if (jarvisListening()) { jarvisStop(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const rec = new SR();
    jarvisRec = rec;
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => { jarvisAnswer(ev.results[0][0].transcript); };
    rec.onerror = () => { setJarvisListening(false); jarvisAnswer(''); };
    rec.onend = () => { setJarvisListening(false); };
    try {
      rec.start();
      setJarvisListening(true);
      setJarvisText('Listening…');
    } catch { jarvisAnswer(''); }
  } else {
    // No SpeechRecognition (Firefox/Safari): brief listening beat, then the
    // general status line, noting voice input is unavailable.
    setJarvisListening(true);
    setJarvisText('Listening…');
    setTimeout(() => {
      jarvisAnswer('', 'Voice input is unavailable in this browser.');
    }, 900);
  }
}

function jarvisStop() {
  try { if (jarvisRec) jarvisRec.stop(); } catch { /* already stopped */ }
  setJarvisListening(false);
}

function jarvisAnswer(said, note) {
  const q = normSpeech(said);
  const list = state.workspaces.filter(Boolean);
  let text;
  const named = list.find((w) => {
    const nm = normSpeech(w.name);
    return (nm && q.includes(nm)) || (w.id && q.includes(normSpeech(w.id)));
  });
  if (named) {
    const counts = named.task_counts || {};
    const blocked = Number(counts.blocked) || 0;
    text = (named.name || named.id) + ' has ' + sayN(workingCount(named), 'agent') + ' active and ' +
      sayN(Number(counts.in_progress) || 0, 'task') + ' in progress' +
      (blocked === 1 ? ', but 1 is blocked and needs you.' :
        blocked ? ', but ' + blocked + ' are blocked and need you.' : '. All clear.');
  } else if (q.includes('block')) {
    const b = list.filter((w) => w.task_counts && Number(w.task_counts.blocked) > 0)
      .map((w) => w.name || w.id);
    const names = b.length > 1 ? b.slice(0, -1).join(', ') + ' and ' + b[b.length - 1] : b[0];
    text = b.length
      ? 'Sir, ' + names + ' ' + (b.length > 1 ? 'have' : 'has') + ' blocked tasks awaiting your input.'
      : 'No blockers across the fleet. Everything is running smoothly.';
  } else if (q.includes('cost') || q.includes('spend') || q.includes('token')) {
    const total = list.reduce((s, w) => s + wsTokenSpend(w), 0);
    const heaviest = list.reduce((a, w) => (wsTokenSpend(w) > wsTokenSpend(a) ? w : a), list[0]);
    text = 'Total spend across all workspaces is ' + spokenTokens(total) + ' tokens.';
    if (heaviest && wsTokenSpend(heaviest) > 0) {
      text += ' ' + (heaviest.name || heaviest.id) + ' is the heaviest at ' +
        spokenTokens(wsTokenSpend(heaviest)) + ' tokens.';
    }
  } else {
    const online = list.filter((w) => w.running !== false).length;
    const active = list.reduce((s, w) => s + workingCount(w), 0);
    const blocked = list.reduce((s, w) => s + ((w.task_counts && Number(w.task_counts.blocked)) || 0), 0);
    text = 'All systems nominal. ' + online + ' of ' + list.length + ' workspaces online, ' +
      sayN(active, 'agent') + ' active' +
      (blocked === 1 ? '. 1 task is blocked and needs your attention.' :
        blocked ? '. ' + blocked + ' tasks are blocked and need your attention.' : ', no blockers. Standing by.');
  }
  if (note) text += ' ' + note;
  setJarvisListening(false);
  setJarvisText(text);
  jarvisSpeak(text);
  jarvisTimer = setTimeout(() => { $('#jarvis-transcript').hidden = true; }, 9000);
}

// Ruling #14 (+ addendum): one consistent British male voice, deterministically
// pinned. Exact names first (closest stock JARVIS-alikes per platform), then
// guarded fallbacks. A known-female-named voice is only ever picked when no
// non-blocklisted en/en-GB alternative exists — the literal /female/i check
// missed voices named Kate/Serena/Hazel/etc. The whole-word alternation keeps
// short names (Mia, Ava, Amy, Zoe, Anna, Aria) from hitting substrings inside
// other names (Amelie, Savannah). The male-ish tier tests the female blocklist
// first: unbounded /male/ would match "...Female".
const JARVIS_VOICE_NAMES = [
  'Daniel',
  'Google UK English Male',
  'Microsoft Ryan Online (Natural) - English (United Kingdom)',
  'Microsoft George - English (United Kingdom)',
  'Microsoft Thomas Online (Natural) - English (United Kingdom)',
  'Arthur'
];

const JARVIS_FEMALE_RE = /\b(female|kate|serena|martha|stephanie|hazel|susan|fiona|moira|tessa|karen|samantha|victoria|allison|ava|emily|libby|sonia|anna|catherine|zira|zoe|shelley|kathy|sarah?|mia|aria|jenny|michelle|molly|amy)\b/i;
const JARVIS_MALE_RE = /\b(male|daniel|arthur|george|ryan|oliver|alex|fred|thomas|james|aaron|guy|brian|liam|christopher|eric)\b/i;

function pickJarvisVoice(voices) {
  if (!Array.isArray(voices) || !voices.length) return null;
  for (const name of JARVIS_VOICE_NAMES) {
    const v = voices.find((x) => x && x.name === name);
    if (v) return v;
  }
  const notFemale = (x) => !JARVIS_FEMALE_RE.test(x.name || '');
  const enGB = voices.filter((x) => x && /en-GB/i.test(x.lang || ''));
  const en = voices.filter((x) => x && /en/i.test(x.lang || ''));
  return enGB.find((x) => notFemale(x) && JARVIS_MALE_RE.test(x.name || '')) ||
    enGB.find(notFemale) ||
    en.find(notFemale) ||
    enGB[0] || en[0] || null;
}

// getVoices() populates async — resolve the pick once, cache it, and
// re-resolve only when the browser says the list changed.
let jarvisVoice = null;
let jarvisVoiceResolved = false;
let jarvisPendingText = null; // latest utterance deferred while voices load

function resolveJarvisVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return false;
  jarvisVoice = pickJarvisVoice(voices);
  jarvisVoiceResolved = true;
  console.info('[JARVIS] voice pinned: ' + (jarvisVoice ? jarvisVoice.name + ' (' + jarvisVoice.lang + ')' : 'browser default'));
  return true;
}

// Diagnostic (ruling #14 addendum, console-only): paste jarvisVoiceInfo()
// output when reporting a wrong pick.
window.jarvisVoiceInfo = () => {
  let voices = [];
  try { voices = speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang, default: v.default })); }
  catch { /* no speechSynthesis */ }
  return {
    picked: jarvisVoice ? { name: jarvisVoice.name, lang: jarvisVoice.lang } : null,
    resolved: jarvisVoiceResolved,
    voices
  };
};

// The single speechSynthesis.speak() call site.
function jarvisUtter(text) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (jarvisVoice) u.voice = jarvisVoice;
  u.rate = 1.02;
  u.pitch = 0.9;
  u.lang = 'en-GB';
  speechSynthesis.speak(u);
}

// Nulls pending before speaking, so the voiceschanged listener and the retry
// timer can never both fire the same deferred answer.
function jarvisFlushPending() {
  const t = jarvisPendingText;
  if (t === null) return;
  jarvisPendingText = null;
  jarvisUtter(t);
}

// Spoken text is always identical to the displayed transcript (ruling #12).
function jarvisSpeak(text) {
  try {
    if (!jarvisVoiceResolved && !resolveJarvisVoice()) {
      // Voice list not loaded yet — never speak unpinned. Defer; a newer
      // answer replaces the queued one. Cancel-first discipline still holds.
      speechSynthesis.cancel();
      jarvisPendingText = text;
      setTimeout(() => {
        try { if (jarvisPendingText !== null && resolveJarvisVoice()) jarvisFlushPending(); }
        catch { /* no speechSynthesis */ }
      }, 250);
      return;
    }
    jarvisPendingText = null; // direct speak supersedes any queued answer
    jarvisUtter(text);
  } catch { /* no speechSynthesis — the transcript still shows the answer */ }
}

// Re-pin on list updates (e.g. Chrome loading remote voices after startup)
// and release any answer that was waiting on the list.
try {
  if (typeof speechSynthesis !== 'undefined' && typeof speechSynthesis.addEventListener === 'function') {
    speechSynthesis.addEventListener('voiceschanged', () => {
      try { if (resolveJarvisVoice()) jarvisFlushPending(); }
      catch { /* no speechSynthesis */ }
    });
  }
} catch { /* no speechSynthesis */ }

/* ==========================================================================
 * Event wiring
 * ======================================================================== */

function bindEvents() {
  // Universe: planet/node click to enter, hover for telemetry, cursor parallax.
  for (const layer of [$('#orb-layer'), $('#net-layer')]) {
    layer.addEventListener('click', (e) => {
      const orb = e.target.closest('[data-ws]');
      if (orb) warpToWorkspace(orb.dataset.ws); // ruling #17 warp-in
    });
    layer.addEventListener('pointerover', (e) => {
      const orb = e.target.closest('[data-ws]');
      if (orb) setHover(orb.dataset.ws, e);
    });
    layer.addEventListener('pointerout', (e) => {
      const orb = e.target.closest('[data-ws]');
      if (orb && !(e.relatedTarget && orb.contains(e.relatedTarget))) clearHover();
    });
  }
  $('#universe-view').addEventListener('pointermove', onUniverseMove);
  $('#metaphor-btn').addEventListener('click', toggleMetaphor);
  $('#back-btn').addEventListener('click', backToUniverse);
  window.addEventListener('popstate', applyRoute); // browser back/forward
  window.addEventListener('resize', () => {
    if (state.view === 'universe' && !motionOK()) drawStars(0); // static frame repaint
  });
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    if (state.view === 'universe') startUniverseFX();
  });

  $('#agent-cards').addEventListener('click', (e) => {
    if (e.target.closest('.agent-model')) return; // the select handles itself
    const card = e.target.closest('[data-agent]');
    if (card) openAgentModal(card.dataset.agent);
  });
  $('#agent-cards').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('agent-card')) {
      e.preventDefault();
      openAgentModal(e.target.dataset.agent);
    }
  });
  $('#agent-cards').addEventListener('change', (e) => {
    const sel = e.target.closest('.agent-model');
    if (sel) changeAgentModel(sel.dataset.role, sel.value);
  });

  $('#board-columns').addEventListener('change', (e) => {
    const sel = e.target.closest('.status-select');
    if (sel && sel.dataset.task) changeTaskStatus(sel.dataset.task, sel.value);
  });

  $('#tab-comms').addEventListener('click', () => { state.tab = 'comms'; renderPanel({ pin: true }); });
  $('#tab-activity').addEventListener('click', () => { state.tab = 'activity'; renderPanel({ pin: true }); });
  $('#panel-toggle').addEventListener('click', () => setPanelCollapsed(!state.panelCollapsed));
  // Comms clamp toggle (ruling #20): delegated — #panel-feed's innerHTML is
  // swapped every poll. Toggles classes on the live nodes, never re-renders,
  // so expanding/collapsing cannot move the scroll position.
  $('#panel-feed').addEventListener('click', (e) => {
    const btn = e.target.closest('.msg-expand');
    if (!btn) return;
    const id = String(btn.dataset.msgId);
    const expand = !expandedMsgs.has(id);
    if (expand) expandedMsgs.add(id);
    else expandedMsgs.delete(id);
    const msg = btn.closest('.msg');
    const body = msg && msg.querySelector('.msg-body');
    if (body) {
      body.classList.toggle('clamped', !expand);
      body.classList.toggle('expanded', expand);
    }
    btn.setAttribute('aria-expanded', String(expand));
    btn.textContent = expand ? 'SHOW LESS' : 'SHOW MORE';
  });

  $('#pause-btn').addEventListener('click', togglePause);
  $('#delete-btn').addEventListener('click', openDeleteModal);
  $('#add-ws-btn').addEventListener('click', openCreateModal);
  // Same action from inside a workspace — the HUD button is scoped to #universe-view.
  $('#add-ws-btn-rail').addEventListener('click', openCreateModal);

  // First-run setup. Dismissal is session-only: a reload re-offers it while setup is
  // still incomplete, so the screen can't be permanently lost to a stray click.
  $('#setup-add-ws').addEventListener('click', openCreateModal);
  $('#setup-skip').addEventListener('click', () => {
    state.setupDismissed = true;
    renderSetup();
    toast('Setup hidden — use ＋ Deploy to add a project.');
  });

  for (const btn of document.querySelectorAll('.theme-toggle')) {
    btn.addEventListener('click', () => {
      applyTheme(document.documentElement.classList.contains('theme-light') ? 'dark' : 'light');
    });
  }
  // JARVIS voice (ruling #12): push-to-talk only — recognition starts on an
  // explicit click, never automatically; no wake word.
  $('#jarvis-btn').addEventListener('click', micToggle);
  window.addEventListener('pagehide', () => {
    try { speechSynthesis.cancel(); } catch { /* unsupported */ }
  });

  $('#goal-form').addEventListener('submit', (e) => { e.preventDefault(); submitGoal(); });
  $('#msg-form').addEventListener('submit', (e) => { e.preventDefault(); submitMessage(); });

  // @-mention autocomplete (ruling #16). While the popup is open, Enter/Tab
  // select and Escape closes — Enter only submits with the popup closed.
  $('#msg-input').addEventListener('input', updateMentionPopup);
  $('#msg-input').addEventListener('blur', closeMentionPopup);
  $('#msg-input').addEventListener('keydown', (e) => {
    if (!mention.open || !mention.items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mention.index = (mention.index + 1) % mention.items.length;
      renderMentionPopup();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      mention.index = (mention.index - 1 + mention.items.length) % mention.items.length;
      renderMentionPopup();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applyMention(mention.items[mention.index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionPopup();
    }
  });
  // mousedown is prevented so the input never blurs; click then selects.
  $('#mention-popup').addEventListener('mousedown', (e) => e.preventDefault());
  $('#mention-popup').addEventListener('click', (e) => {
    const opt = e.target.closest('.mention-opt');
    if (opt && opt.dataset.role) applyMention(opt.dataset.role);
  });

  // Turn-history modal
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Create-workspace modal
  $('#create-form').addEventListener('submit', (e) => { e.preventDefault(); submitCreateWorkspace(); });
  bindModalDismiss('#create-backdrop', ['#create-close', '#create-cancel']);

  // Per-role model selects follow their checkbox
  $('#create-roles').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const sel = cb.closest('.role-row') && cb.closest('.role-row').querySelector('.role-model');
    if (sel) sel.disabled = !cb.checked;
  });

  // Folder picking: native Finder first, inline browser as fallback
  $('#browse-btn').addEventListener('click', () => pickFolder('create'));
  $('#browser-use').addEventListener('click', () => useBrowsedFolder('create'));
  $('#browser-list').addEventListener('click', (e) => {
    const row = e.target.closest('.browser-row');
    if (row && row.dataset.path) browseTo('create', row.dataset.path);
  });
  wireNewFolder('create');
  wireNewFolder('settings');
  wireHuePicker('#create-hue');
  wireHuePicker('#settings-hue');

  // Settings modal
  $('#settings-btn').addEventListener('click', openSettingsModal);
  $('#settings-form').addEventListener('submit', (e) => { e.preventDefault(); saveSettings(); });
  bindModalDismiss('#settings-backdrop', ['#settings-close', '#settings-cancel']);
  $('#settings-browse-btn').addEventListener('click', () => pickFolder('settings'));
  $('#settings-browser-use').addEventListener('click', () => useBrowsedFolder('settings'));
  $('#settings-browser-list').addEventListener('click', (e) => {
    const row = e.target.closest('.browser-row');
    if (row && row.dataset.path) browseTo('settings', row.dataset.path);
  });
  $('#settings-roles').addEventListener('change', (e) => {
    const sel = e.target.closest('.settings-role-model');
    if (!sel) return;
    const i = Number(sel.dataset.idx);
    if (settingsRoles[i]) settingsRoles[i].model = sel.value;
  });
  $('#settings-roles').addEventListener('input', (e) => {
    const ta = e.target.closest('.settings-prompt');
    if (!ta) return;
    const i = Number(ta.dataset.idx);
    if (settingsRoles[i]) settingsRoles[i].prompt = ta.value;
  });
  $('#settings-roles').addEventListener('click', (e) => {
    const btn = e.target.closest('.role-remove');
    if (btn && !btn.disabled) removeSettingsRole(Number(btn.dataset.idx));
  });
  $('#settings-add-role').addEventListener('change', (e) => {
    addSettingsRole(e.target.value);
  });

  // Delete confirmation modal
  $('#delete-confirm').addEventListener('click', confirmDeleteWorkspace);
  bindModalDismiss('#delete-backdrop', ['#delete-cancel']);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Inside a modal with an open folder browser, Escape collapses the browser first.
    if (!$('#create-backdrop').hidden && browserOpen('create')) { closeBrowser('create'); return; }
    if (!$('#settings-backdrop').hidden && browserOpen('settings')) { closeBrowser('settings'); return; }
    closeTopModal();
  });
}

/* ==========================================================================
 * Boot
 * ======================================================================== */

function init() {
  initTheme();
  buildCreateRoleRows();
  bindEvents();
  setPanelCollapsed(lsGet('mc.panelCollapsed') === '1');
  initPanelResize();
  setView('universe');
  renderAll();
  // Restore the routed view once the workspace list is known, so an id that no
  // longer exists can be rejected instead of rendering an empty detail view.
  loadState().then(applyRoute);
  connectWS();
}

document.addEventListener('DOMContentLoaded', init);
