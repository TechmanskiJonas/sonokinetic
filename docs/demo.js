/* Sonokinetic demo page.
 *
 * The point of this file is the switch. Every variant of a bed is decoded up
 * front and started at the same instant on the same clock, so moving between
 * them is a gain change on already-running audio rather than a new playback.
 * A listener comparing two treatments must not also be comparing two
 * playback positions, and must not hear the seam.
 *
 * The monitor is drawn from each render's own trace, written by the renderer
 * at render time. Recomputing the geometry here would be a second
 * implementation of it, free to disagree with what you are hearing.
 */

const DATA = "data/";
const FADE = 0.015;          // gain ramp on a switch: short enough to feel
                             // instant, long enough not to click

const S = {
  manifest: null,
  bed: null,
  variant: null,
  buffers: {},               // variantId -> AudioBuffer
  traces: {},                // variantId -> [frames]
  ctx: null,
  nodes: null,               // { srcs: {id: node}, gains: {id: GainNode} }
  t0: 0,                     // ctx.currentTime when playback started
  offset: 0,                 // passage position at t0
  playing: false,
  paused: 0,                 // position when paused
  duration: 0,
  loadToken: 0,
  scrubbing: false,
};

const $ = s => document.querySelector(s);
const el = (t, cls) => { const e = document.createElement(t); if (cls) e.className = cls; return e; };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ----------------------------------------------------------------------
// boot
// ----------------------------------------------------------------------

async function boot() {
  S.manifest = await (await fetch(DATA + "manifest.json")).json();
  S.duration = S.manifest.passage_secs;

  buildBeds();
  buildVariants();
  buildMetrics();

  selectBed(S.manifest.beds[0].id, { load: false });
  selectVariant(S.manifest.variants[0].id);

  $("#play").addEventListener("click", togglePlay);
  $("#seek").addEventListener("input", onScrub);
  $("#seek").addEventListener("change", onScrubEnd);
  document.addEventListener("keydown", onKey);
  requestAnimationFrame(frame);
}

function buildBeds() {
  const host = $("#beds");
  host.textContent = "";
  for (const b of S.manifest.beds) {
    const btn = el("button");
    btn.textContent = b.label;
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => selectBed(b.id));
    host.appendChild(btn);
  }
}

function buildVariants() {
  const host = $("#variants");
  host.textContent = "";
  S.manifest.variants.forEach((v, i) => {
    const li = el("li");
    const btn = el("button");
    btn.setAttribute("aria-pressed", "false");
    btn.dataset.id = v.id;

    const key = el("span", "key");
    key.textContent = String(i + 1);

    const mid = el("span");
    const name = el("span", "vname");
    name.textContent = v.label;
    const short = el("span", "vshort");
    short.textContent = v.short;
    mid.append(name, short);

    const meta = el("span", "vmeta");
    const rate = v.rotation_deg_per_sec ? `${v.rotation_deg_per_sec} °/s`
      : v.drift_mps ? `${v.drift_mps} m/s` : "static";
    meta.textContent = v.has_trace ? `${v.n_sources} src · ${rate}` : "";

    btn.append(key, mid, meta);
    btn.addEventListener("click", () => selectVariant(v.id));
    li.appendChild(btn);
    host.appendChild(li);
  });
}

function buildMetrics() {
  const body = $("#metrics tbody");
  body.textContent = "";
  for (const v of S.manifest.variants) {
    const tr = el("tr");
    // The pair the section's argument rests on: one turns, one does not, and
    // the measure cannot separate them.
    if (v.id === "rotating" || v.id === "decoy") tr.className = "mark";
    const turning = !v.has_trace ? "none"
      : (v.rotation_deg_per_sec ? "one revolution"
        : v.moving ? "translation" : "none");
    for (const [text, cls] of [
      [v.label, ""],
      [turning, ""],
      [v.metrics.drone.iacc.toFixed(3), "num"],
      [v.metrics.strings.iacc.toFixed(3), "num"],
    ]) {
      const td = el("td", cls);
      td.textContent = text;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

// ----------------------------------------------------------------------
// selection
// ----------------------------------------------------------------------

function bedById(id) { return S.manifest.beds.find(b => b.id === id); }
function varById(id) { return S.manifest.variants.find(v => v.id === id); }

function selectBed(id, { load = true } = {}) {
  if (S.bed === id) return;
  S.bed = id;
  [...$("#beds").children].forEach((b, i) =>
    b.setAttribute("aria-pressed", String(S.manifest.beds[i].id === id)));
  $("#bedblurb").textContent = bedById(id).blurb;
  if (S.variant) drawReadout();   // the measures are per bed, not per variant

  const was = S.playing;
  const at = position();
  stop();
  S.buffers = {};
  S.traces = {};
  if (load) loadBed().then(() => { if (was) start(at); });
}

function selectVariant(id) {
  S.variant = id;
  [...$("#variants").querySelectorAll("button")].forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.id === id)));

  const v = varById(id);
  $("#vlabel").textContent = v.label;
  $("#vbody").textContent = v.body;
  drawReadout();

  // A gain change on running audio, so the position never moves.
  if (S.nodes) {
    const t = S.ctx.currentTime;
    for (const [vid, g] of Object.entries(S.nodes.gains)) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(vid === id ? 1 : 0, t + FADE);
    }
  }
}

// ----------------------------------------------------------------------
// audio
// ----------------------------------------------------------------------

function ctx() {
  if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)();
  return S.ctx;
}

async function loadBed() {
  const token = ++S.loadToken;
  const vs = S.manifest.variants;
  const note = $("#loading");
  note.hidden = false;
  $("#play").disabled = true;

  let done = 0;
  const tick = () => {
    note.textContent = `Loading ${bedById(S.bed).label.toLowerCase()}, ` +
      `${done} of ${vs.length} variants`;
  };
  tick();

  await Promise.all(vs.map(async v => {
    const stem = `${S.bed}-${v.id}`;
    const [buf, trace] = await Promise.all([
      fetch(`${DATA}${stem}.mp3`).then(r => r.arrayBuffer())
        .then(a => ctx().decodeAudioData(a)),
      v.has_trace
        ? fetch(`${DATA}${stem}.trace.json`).then(r => r.json())
        : Promise.resolve(null),
    ]);
    if (token !== S.loadToken) return;      // a bed switch overtook this load
    S.buffers[v.id] = buf;
    S.traces[v.id] = trace;
    done++; tick();
  }));

  if (token !== S.loadToken) return;
  note.hidden = true;
  $("#play").disabled = false;
}

function buildGraph(at) {
  const c = ctx();
  const srcs = {}, gains = {};
  for (const v of S.manifest.variants) {
    const buf = S.buffers[v.id];
    if (!buf) continue;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = c.createGain();
    g.gain.value = v.id === S.variant ? 1 : 0;
    src.connect(g).connect(c.destination);
    srcs[v.id] = src; gains[v.id] = g;
  }
  // One start time for every variant, so they stay sample-aligned for as long
  // as they run. Starting them individually would let them drift apart.
  const when = c.currentTime + 0.06;
  for (const src of Object.values(srcs)) src.start(when, at % S.duration);
  S.nodes = { srcs, gains };
  S.t0 = when;
  S.offset = at % S.duration;
}

async function start(at = 0) {
  if (!Object.keys(S.buffers).length) await loadBed();
  await ctx().resume();
  stopNodes();
  buildGraph(at);
  S.playing = true;
  $("#play").textContent = "Pause";
}

function stopNodes() {
  if (!S.nodes) return;
  for (const src of Object.values(S.nodes.srcs)) { try { src.stop(); } catch (e) {} }
  S.nodes = null;
}

function stop() {
  S.paused = position();
  stopNodes();
  S.playing = false;
  $("#play").textContent = "Play";
}

function togglePlay() {
  if (S.playing) stop(); else start(S.paused);
}

function position() {
  if (!S.playing || !S.ctx) return S.paused;
  const t = S.ctx.currentTime - S.t0 + S.offset;
  return t < 0 ? 0 : t % S.duration;
}

function onScrub() {
  S.scrubbing = true;
  const at = (+$("#seek").value / 1000) * S.duration;
  $("#clock").textContent = at.toFixed(1) + "s";
}

function onScrubEnd() {
  S.scrubbing = false;
  const at = (+$("#seek").value / 1000) * S.duration;
  S.paused = at;
  if (S.playing) start(at);
}

function onKey(e) {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); return; }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= S.manifest.variants.length) {
    selectVariant(S.manifest.variants[n - 1].id);
  }
}

// ----------------------------------------------------------------------
// monitor
// ----------------------------------------------------------------------

function frameAt(trace, t) {
  if (!trace || !trace.length) return null;
  // Frames are evenly spaced, so index directly rather than searching.
  const span = trace[trace.length - 1].t - trace[0].t;
  const i = Math.round(((t - trace[0].t) / (span || 1)) * (trace.length - 1));
  return trace[Math.max(0, Math.min(trace.length - 1, i))];
}

function drawRing() {
  const c = $("#ring"), x = c.getContext("2d");
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.34;
  x.clearRect(0, 0, w, h);

  const grid = cssVar("--grid"), head = cssVar("--headline"), ink3 = cssVar("--ink-3");
  const [dr, dg, db] = cssVar("--dot").split(",").map(v => +v.trim());

  // The room: outer bound, the head, and which way it faces.
  x.strokeStyle = grid; x.lineWidth = 1;
  x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = head;
  x.beginPath(); x.arc(cx, cy, 15, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.moveTo(cx, cy - 15); x.lineTo(cx, cy - 23); x.stroke();
  x.fillStyle = ink3; x.font = "10px system-ui";
  x.fillText("L", cx - 30, cy + 4);
  x.fillText("R", cx + 24, cy + 4);
  x.fillText("front", cx - 14, cy - R - 11);
  x.fillText("back", cx - 12, cy + R + 19);

  const v = varById(S.variant);
  const trace = S.traces[S.variant];
  if (!v.has_trace || !trace) {
    x.fillStyle = cssVar("--warm"); x.font = "12px system-ui";
    const t = v.has_trace ? "loading" : "untreated, no field rendered";
    x.fillText(t, cx - x.measureText(t).width / 2, cy + R + 42);
    return;
  }

  const fr = frameAt(trace, position());
  if (!fr) return;

  // Distance maps to drawn radius, on the same 0.7 power law the application
  // uses, so the two pictures read the same way.
  const REFD = 2.0;
  const base = v.distances || fr.az.map(() => REFD);
  const dist = fr.dist || base;
  const lvl = fr.lvl || fr.az.map(() => 1);
  const unit = d => Math.pow(Math.max(d, 0.2) / REFD, 0.7);
  const maxUnit = Math.max(1, ...base.map(unit)) * 1.02;
  const rpix = d => R * unit(d) / maxUnit;

  // A guide circle per distinct radius in the layout.
  const seen = new Set();
  for (const d of base) {
    const key = Math.round(d * 10);
    if (seen.has(key)) continue;
    seen.add(key);
    x.strokeStyle = grid; x.setLineDash([2, 4]);
    x.beginPath(); x.arc(cx, cy, rpix(d), 0, Math.PI * 2); x.stroke();
    x.setLineDash([]);
  }

  fr.az.forEach((a, i) => {
    const r = (a - 90) * Math.PI / 180;
    const rr = rpix(dist[i]);
    const sx = cx + rr * Math.cos(r), sy = cy + rr * Math.sin(r);
    const coh = 1 - (fr.amt[i] ?? 1);     // filled = coherent, hollow = diffuse
    const lv = lvl[i] ?? 1;
    x.beginPath(); x.arc(sx, sy, 4.5 + 4.5 * coh, 0, Math.PI * 2);
    x.fillStyle = `rgba(${dr},${dg},${db},${((0.10 + 0.85 * coh) * lv).toFixed(3)})`;
    x.fill();
    x.strokeStyle = `rgba(${dr},${dg},${db},${(0.25 + 0.75 * lv).toFixed(3)})`;
    x.lineWidth = 1.2; x.stroke();
  });

  if (v.rotation_deg_per_sec) drawArrow(x, cx, cy, R + 16, v.rotation_deg_per_sec);
}

/** An arc with a head on it, showing which way and how fast the field turns. */
function drawArrow(x, cx, cy, r, rate) {
  const dir = Math.sign(rate) || 1;
  const a0 = -0.5, a1 = a0 + dir * 0.85;
  x.strokeStyle = cssVar("--accent"); x.lineWidth = 1.5;
  x.beginPath(); x.arc(cx, cy, r, Math.min(a0, a1), Math.max(a0, a1)); x.stroke();
  const ax = cx + r * Math.cos(a1), ay = cy + r * Math.sin(a1);
  const tan = a1 + dir * Math.PI / 2;
  x.fillStyle = cssVar("--accent");
  x.beginPath();
  x.moveTo(ax + 6 * Math.cos(tan), ay + 6 * Math.sin(tan));
  x.lineTo(ax + 5 * Math.cos(tan + 2.5), ay + 5 * Math.sin(tan + 2.5));
  x.lineTo(ax + 5 * Math.cos(tan - 2.5), ay + 5 * Math.sin(tan - 2.5));
  x.closePath(); x.fill();
}

function drawReadout() {
  const v = varById(S.variant);
  const m = v.metrics[S.bed];
  const rows = [
    ["Sources", v.has_trace ? v.n_sources : "none"],
    ["Layout", v.has_trace ? (v.lattice === "cartesian" ? "5 × 5 lattice" : "ring") : "none"],
    ["Motion", v.motion],
    ["Head model", v.has_trace ? (v.measured_hrtf ? "KEMAR measured" : "sphere") : "none"],
    ["IACC", m.iacc.toFixed(3)],
    ["Loudness", m.lufs.toFixed(1) + " LUFS"],
  ];
  const t = el("table");
  for (const [k, val] of rows) {
    const tr = el("tr");
    const a = el("td"), b = el("td");
    a.textContent = k; b.textContent = val;
    tr.append(a, b); t.appendChild(tr);
  }
  const host = $("#readout");
  host.textContent = "";
  host.appendChild(t);
}

function frame() {
  drawRing();
  if (!S.scrubbing) {
    const p = position();
    $("#seek").value = Math.round((p / S.duration) * 1000);
    $("#clock").textContent = p.toFixed(1) + "s";
  }
  requestAnimationFrame(frame);
}

boot();
