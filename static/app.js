/* ringfield bench.
 *
 * No framework and no build step: this is a research sandbox that should stay
 * editable without a toolchain.
 *
 * Two structural ideas worth knowing before editing:
 *
 *   PARAMS is the single source of truth for the parameter editor. Adding a
 *   control to the DSP means adding a row there, not writing markup.
 *
 *   Every technical term carries a small "i" button pointing at an entry in
 *   encyclopedia.json. All of the teaching lives behind those buttons and in
 *   the Theory sheet, so the interface itself stays uncluttered for someone
 *   who already knows the material.
 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v, d = 2) =>
  (v === null || v === undefined || Number.isNaN(v)) ? "–" : Number(v).toFixed(d);
const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

// ====================================================================
// Reference sheet: encyclopedia and theory guide
// ====================================================================

let REF = { entries: {}, sections: [], statuses: {}, families: [] };
let PURPOSE = { chapters: [] };
let COURSES = { courses: [] };
const nav = { stack: [], at: -1 };

/** Section id -> the purpose chapter and section it lives in, so a [[link]]
 *  can resolve to narrative as well as to a term. */
const purposeIndex = () => {
  const map = {};
  for (const c of PURPOSE.chapters || [])
    for (const s of c.sections || []) map[s.id] = { chapter: c, section: s };
  return map;
};

const PROGRESS_KEY = "ringfield.progress";
const progress = {
  done: new Set(JSON.parse(localStorage.getItem(PROGRESS_KEY) || "[]")),
  mark(id) { this.done.add(id); this.save(); },
  unmark(id) { this.done.delete(id); this.save(); },
  save() { localStorage.setItem(PROGRESS_KEY, JSON.stringify([...this.done])); },
};

/** [[id]] and [[id|label]] become term links; **bold** and paragraph breaks
 *  are the only other markup. */
function linkify(text) {
  const pi = purposeIndex();
  const anchor = (id, label) => REF.entries[id]
    ? `<a class="term" data-term="${id}">${label}</a>`
    : (pi[id]
      ? `<a class="term" data-purpose="${id}">${label}</a>`
      : `<span>${label}</span>`);
  return esc(text)
    .replace(/\[\[([a-z0-9-]+)\|([^\]]+)\]\]/g, (_, id, label) => anchor(id, label))
    .replace(/\[\[([a-z0-9-]+)\]\]/g, (_, id) =>
      anchor(id, REF.entries[id]?.title || pi[id]?.section.heading || id))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .split(/\n\n+/).map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

function statusTag(status) {
  const s = REF.statuses[status];
  if (!s) return "";
  return `<span class="status ${status}" title="${esc(s.note)}">${esc(s.label)}</span>`;
}

function openSheet() { $("#sheet").classList.add("on"); }
function closeSheet() { $("#sheet").classList.remove("on"); closeCard(); }

function go(view, push = true) {
  if (push) {
    nav.stack = nav.stack.slice(0, nav.at + 1);
    nav.stack.push(view);
    nav.at = nav.stack.length - 1;
  }
  $("#sheetback").disabled = nav.at <= 0;
  openSheet();
  closeCard();
  ({ entry: renderEntry, search: renderSearch,
     glossary: renderGlossaryIndex }[view.kind] || (() => {}))(view);
}

const openRef = id => go({ kind: "entry", id });
const openGlossary = family => go({ kind: "glossary", family: family || "project" });

// ---- definition card -------------------------------------------------
// A term inside a lesson opens a card anchored to it rather than navigating,
// so the reader keeps their position. The card offers the full entry, and the
// back button returns here.

function closeCard() { $("#card").classList.remove("on"); }

function openCard(anchor, id) {
  const e = REF.entries[id];
  const card = $("#card");
  if (!e) { closeCard(); return; }
  card.innerHTML = `<div class="cardhd">${statusTag(e.status)}<b>${esc(e.title)}</b></div>
    <div class="cardbody">${esc(e.short)}</div>
    ${e.grounding ? `<div class="cardsrc">${esc(e.grounding)}</div>` : ""}
    <div class="cardfoot">
      <button class="sm" data-full="${id}">Full entry</button>
      <button class="sm ghost" data-cardclose>Close</button>
    </div>`;
  card.classList.add("on");
  const r = anchor.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  card.style.left = clamp(r.left, 10, innerWidth - cr.width - 10) + "px";
  card.style.top = (r.bottom + cr.height + 10 > innerHeight
    ? Math.max(10, r.top - cr.height - 8) : r.bottom + 8) + "px";
}

// ---- navigation panel ------------------------------------------------

/** Which topic groups are open in the sidebar. Collapsed by default beyond the
 *  one being read, since the full list of terms is long. */
const openGroups = new Set(["p-components"]);

function buildNav(mode, current) {
  const el = $("#sheetnav");
  const bySection = {};
  for (const [id, e] of Object.entries(REF.entries)) (bySection[e.section] ||= []).push([id, e]);
  const currentSection = mode === "entry" ? REF.entries[current]?.section : null;
  if (currentSection) openGroups.add(currentSection);

  let html = "";
  for (const fam of REF.families) {
    html += `<div class="sect">${esc(fam.title)}</div>`;
    for (const s of REF.sections.filter(x => x.family === fam.id)) {
      const items = (bySection[s.id] || []).sort((a, b) => a[1].title.localeCompare(b[1].title));
      if (!items.length) continue;
      const open = openGroups.has(s.id);
      html += `<div class="subsect grp ${open ? "open" : ""}" data-group="${s.id}">
        <span class="tw">${open ? "▾" : "▸"}</span>${esc(s.title)}
        <span class="pct">${items.length}</span></div>`;
      if (open) {
        html += items.map(([id, e]) =>
          `<a data-ref="${id}" class="${mode === "entry" && current === id ? "on" : ""}">${esc(e.title)}</a>`).join("");
      }
    }
  }
  el.innerHTML = html;
  el.querySelector(".on")?.scrollIntoView({ block: "center" });
}

function renderGlossaryIndex(view) {
  const fam = REF.families.find(f => f.id === view.family) || REF.families[0];
  $("#sheettitle").textContent = "Glossary";
  $("#crumbs").textContent = fam.title;
  buildNav("glossary");
  const bySection = {};
  for (const [id, e] of Object.entries(REF.entries)) (bySection[e.section] ||= []).push([id, e]);

  $("#sheetmain").innerHTML = `<div class="guide">
    <h1>${esc(fam.title)}</h1>
    <p>${esc(fam.note)}</p>
    ${REF.families.map(f => `<button class="sm ${f.id === fam.id ? "on" : ""}" data-family="${f.id}">${esc(f.title)}</button>`).join(" ")}
    ${REF.sections.filter(s => s.family === fam.id).map(s => {
      const items = (bySection[s.id] || []).sort((a, b) => a[1].title.localeCompare(b[1].title));
      if (!items.length) return "";
      return `<h2>${esc(s.title)}</h2><div class="results">` + items.map(([id, e]) =>
        `<a data-term="${id}"><b>${esc(e.title)}</b> ${statusTag(e.status)}
          <div class="rs">${esc(e.short)}</div></a>`).join("") + `</div>`;
    }).join("")}
  </div>`;
  $("#sheetmain").scrollTop = 0;
}

// ---- views -----------------------------------------------------------

// ---- Courses and Purpose, rendered into their own pages ---------------

const courseState = { course: null, lesson: null };

function renderCoursesPage() {
  const host = $("#coursebody");
  if (!host) return;
  if (!courseState.course) {
    const total = COURSES.courses.reduce((n, c) => n + c.lessons.length, 0);
    const done = COURSES.courses.reduce(
      (n, c) => n + c.lessons.filter(l => progress.done.has(l.id)).length, 0);
    host.innerHTML = `<div class="guide">
      <h1>A route through the material</h1>
      <p>Six courses in order, each assuming the one before it. Technical terms
      are linked: selecting one shows its definition without leaving the page.</p>
      <p class="dim">${done} of ${total} lessons read.</p>
      ${COURSES.courses.map((c, i) => {
        const d = c.lessons.filter(l => progress.done.has(l.id)).length;
        return `<div class="coursecard">
          <div class="coursehd"><span class="cnum">${i + 1}</span><b>${esc(c.title)}</b>
            <span class="grow"></span>
            <span class="dim">${c.minutes} min · ${d}/${c.lessons.length}</span></div>
          <div class="csummary">${esc(c.summary)}</div>
          <div class="cassumes">Assumes: ${esc(c.assumes)}</div>
          <div class="clessons">${c.lessons.map(l =>
            `<a data-lesson="${c.id}:${l.id}" class="${progress.done.has(l.id) ? "read" : ""}">${esc(l.title)}</a>`
          ).join("")}</div>
        </div>`;
      }).join("")}</div>`;
    return;
  }

  const c = COURSES.courses.find(x => x.id === courseState.course);
  const idx = Math.max(0, c.lessons.findIndex(l => l.id === courseState.lesson));
  const l = c.lessons[idx];
  const prev = c.lessons[idx - 1];
  const next = c.lessons[idx + 1];
  const nextCourse = COURSES.courses[COURSES.courses.indexOf(c) + 1];

  host.innerHTML = `<article class="lesson">
    <div class="lessonhd"><a data-lesson="">All courses</a> / ${esc(c.title)}
      · ${idx + 1} of ${c.lessons.length}</div>
    <h1>${esc(l.title)}</h1>
    ${linkify(l.body)}
    ${l.try ? `<div class="tryit"><b>Try it</b><div>${linkify(l.try)}</div></div>` : ""}
    ${l.checkpoint ? `<div class="check">
        <div class="cq">${esc(l.checkpoint.q)}</div>
        <button class="sm" data-reveal>Show answer</button>
        <div class="ca" hidden>${esc(l.checkpoint.a)}</div>
      </div>` : ""}
    <div class="lessonnav">
      ${prev ? `<button class="sm" data-lesson="${c.id}:${prev.id}">&larr; ${esc(prev.title)}</button>` : "<span></span>"}
      <span class="grow"></span>
      <button class="primary" data-next="${next ? c.id + ":" + next.id : (nextCourse ? nextCourse.id + ":" + nextCourse.lessons[0].id : "")}"
        data-mark="${l.id}">${next ? "Next lesson" : (nextCourse ? "Next course" : "Finish")}</button>
    </div></article>`;
  host.scrollTop = 0;
}

function renderPurposePage(chapterId) {
  const host = $("#purposebody");
  const nav = $("#purposenav");
  if (!host) return;
  const c = PURPOSE.chapters.find(x => x.id === chapterId) || PURPOSE.chapters[0];
  if (!c) return;
  nav.innerHTML = PURPOSE.chapters.map(x =>
    `<button class="sm ${x.id === c.id ? "on" : ""}" data-chapter="${x.id}">${esc(x.title)}</button>`).join("");
  host.innerHTML = `<article class="guide"><h1>${esc(c.title)}</h1>` +
    c.sections.map(s =>
      `<h2 id="pp-${s.id}">${esc(s.heading)}</h2>${linkify(s.body)}`).join("") +
    `</article>`;
  host.scrollTop = 0;
}

function openPurpose(sectionId) {
  const pi = purposeIndex();
  const hit = pi[sectionId];
  closeSheet();
  $$(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === "purpose"));
  $$(".page").forEach(p => p.classList.toggle("on", p.id === "purpose"));
  renderPurposePage(hit?.chapter.id);
  if (hit) setTimeout(() =>
    $(`#pp-${sectionId}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 40);
}

function renderEntry(view) {
  const id = view.id;
  const e = REF.entries[id];
  $("#sheettitle").textContent = "Reference";
  if (!e) {
    $("#sheetmain").innerHTML = `<div class="entry"><h1>Not written yet</h1>
      <p class="short">No entry for <code>${esc(id)}</code>.</p></div>`;
    return;
  }
  buildNav("entry", id);
  // A prerequisite may be a term or a section of the research programme, so
  // the link has to be built the same way body links are.
  const pi = purposeIndex();
  const links = ids => (ids || []).map(x => REF.entries[x]
    ? `<a class="term" data-term="${x}">${esc(REF.entries[x].title)}</a>`
    : (pi[x] ? `<a class="term" data-purpose="${x}">${esc(pi[x].section.heading)}</a>`
      : esc(x))).join(", ");
  const st = REF.statuses[e.status];
  $("#sheetmain").innerHTML = `<article class="entry">
    <div class="entryhd">${statusTag(e.status)}</div>
    <h1>${esc(e.title)}</h1>
    <div class="short">${esc(e.short)}</div>
    ${st ? `<div class="statusnote">${esc(st.note)}</div>` : ""}
    ${linkify(e.body)}
    ${e.grounding ? `<div class="grounding"><b>References</b><div>${esc(e.grounding)}</div></div>` : ""}
    <div class="meta">
      ${e.prereq?.length ? `<div><b>Read first:</b> ${links(e.prereq)}</div>` : ""}
      ${e.see?.length ? `<div><b>See also:</b> ${links(e.see)}</div>` : ""}
    </div></article>`;
  $("#sheetmain").scrollTop = 0;
  $("#crumbs").textContent = REF.sections.find(s => s.id === e.section)?.title || "";
}

function renderSearch(view) {
  const needle = view.q.toLowerCase();
  const hits = Object.entries(REF.entries).filter(([id, e]) =>
    id.includes(needle) || e.title.toLowerCase().includes(needle) ||
    e.short.toLowerCase().includes(needle) || e.body.toLowerCase().includes(needle));
  const lessons = COURSES.courses.flatMap(c => c.lessons
    .filter(l => (l.title + l.body).toLowerCase().includes(needle))
    .map(l => [c, l]));
  const purp = (PURPOSE.chapters || []).flatMap(c => c.sections
    .filter(s => (s.heading + s.body).toLowerCase().includes(needle))
    .map(s => [c, s]));
  const n = hits.length + lessons.length + purp.length;
  $("#sheettitle").textContent = "Search";
  $("#sheetmain").innerHTML = `<div class="entry">
    <h1>${n} result${n === 1 ? "" : "s"}</h1>
    <div class="results">
    ${hits.map(([id, e]) =>
      `<a data-term="${id}"><b>${esc(e.title)}</b> ${statusTag(e.status)}
        <div class="rs">${esc(e.short)}</div></a>`).join("")}
    ${lessons.map(([c, l]) =>
      `<a data-lesson="${c.id}:${l.id}"><b>${esc(l.title)}</b>
        <div class="rs">Lesson in ${esc(c.title)}</div></a>`).join("")}
    ${purp.map(([c, s]) =>
      `<a data-purpose="${s.id}"><b>${esc(s.heading)}</b>
        <div class="rs">${esc(c.title)}</div></a>`).join("")}
    </div></div>`;
}

/** A small circled i opening the reference at `id`. */
function infoBtn(id) {
  const b = document.createElement("button");
  b.className = "i"; b.type = "button"; b.textContent = "i";
  b.title = REF.entries[id]?.title || id;
  b.dataset.ref = id;
  return b;
}

function wireSheet() {
  $("#openlearn").addEventListener("click", () => openGlossary("project"));
  $("#sheetclose").addEventListener("click", closeSheet);
  $("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeSheet(); });
  $("#sheetback").addEventListener("click", () => {
    if (nav.at > 0) { nav.at--; go(nav.stack[nav.at], false); }
  });
  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if ($("#card").classList.contains("on")) closeCard();
    else if ($("#sheet").classList.contains("on")) closeSheet();
  });

  // One delegated handler covers everything, including nodes created later.
  document.addEventListener("click", e => {
    if (e.target.closest("[data-cardclose]")) { closeCard(); return; }

    const full = e.target.closest("[data-full]");
    if (full) { e.preventDefault(); openRef(full.dataset.full); return; }

    // A term inside prose opens a card in place, keeping the reader's position.
    const term = e.target.closest("[data-term]");
    if (term) {
      e.preventDefault(); e.stopPropagation();
      openCard(term, term.dataset.term);
      return;
    }
    // An info button in the interface opens the full entry.
    const ref = e.target.closest("[data-ref]");
    if (ref) { e.preventDefault(); e.stopPropagation(); openRef(ref.dataset.ref); return; }

    const purp = e.target.closest("[data-purpose]");
    if (purp) { e.preventDefault(); openPurpose(purp.dataset.purpose); return; }

    const fam = e.target.closest("[data-family]");
    if (fam) { e.preventDefault(); openGlossary(fam.dataset.family); return; }

    const grp = e.target.closest("[data-group]");
    if (grp) {
      e.preventDefault();
      const id = grp.dataset.group;
      openGroups.has(id) ? openGroups.delete(id) : openGroups.add(id);
      const v = nav.stack[nav.at];
      buildNav(v?.kind === "entry" ? "entry" : "glossary",
        v?.kind === "entry" ? v.id : null);
      return;
    }

    const lesson = e.target.closest("[data-lesson]");
    if (lesson) {
      e.preventDefault();
      const val = lesson.dataset.lesson;
      if (!val) { courseState.course = null; courseState.lesson = null; }
      else { const [c, l] = val.split(":"); courseState.course = c; courseState.lesson = l; }
      closeSheet();
      $$(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === "courses"));
      $$(".page").forEach(p => p.classList.toggle("on", p.id === "courses"));
      renderCoursesPage();
      return;
    }
    const nxt = e.target.closest("[data-next]");
    if (nxt) {
      e.preventDefault();
      if (nxt.dataset.mark) progress.mark(nxt.dataset.mark);
      const target = nxt.dataset.next;
      if (target) { const [c, l] = target.split(":"); courseState.course = c; courseState.lesson = l; }
      else { courseState.course = null; courseState.lesson = null; }
      renderCoursesPage();
      return;
    }
    const chap = e.target.closest("[data-chapter]");
    if (chap) { e.preventDefault(); renderPurposePage(chap.dataset.chapter); return; }
    const rev = e.target.closest("[data-reveal]");
    if (rev) {
      e.preventDefault();
      const a = rev.parentElement.querySelector(".ca");
      a.hidden = !a.hidden;
      rev.textContent = a.hidden ? "Show answer" : "Hide answer";
      return;
    }
    if (!e.target.closest("#card")) closeCard();
  });

  let t;
  $("#sheetsearch").addEventListener("input", e => {
    clearTimeout(t);
    const q = e.target.value.trim();
    t = setTimeout(() => { if (q.length >= 2) go({ kind: "search", q }); }, 180);
  });
}

// ====================================================================
// Parameter schema
// ====================================================================

const KINDS = {
  ring:   { label: "Ring",   hint: "sources on a circle, turning" },
  stream: { label: "Stream", hint: "straight-line travel across the space" },
  radial: { label: "Radial", hint: "travel inward or outward along radii" },
  spiral: { label: "Spiral", hint: "turning and travelling in or out at once" },
};

const rotates = c => c.kind === "ring" || c.kind === "spiral";
const travels = c => c.kind === "stream";
const radiates = c => c.kind === "radial" || c.kind === "spiral";

const COMPONENT_ROWS = [
  { k: "kind", ref: "component", type: "sel", opts: Object.keys(KINDS), structural: true },
  { k: "n_sources", ref: "source", type: "int", min: 1, max: 16, step: 1 },
  { k: "rotation_deg_per_sec", ref: "rotation-rate", type: "range", min: -720, max: 720, step: 5, unit: "°/s", showIf: rotates },
  { k: "distance_m", ref: "source-distance", type: "range", min: 0.3, max: 8, step: 0.1, unit: "m", showIf: c => c.kind === "ring" },
  { k: "heading_deg", ref: "translation", type: "range", min: 0, max: 359, step: 5, unit: "°", showIf: travels },
  { k: "speed_mps", ref: "translation", type: "range", min: -6, max: 6, step: 0.1, unit: "m/s", showIf: travels },
  { k: "path_m", ref: "translation", type: "range", min: 2, max: 20, step: 0.5, unit: "m", showIf: travels },
  { k: "spread_m", ref: "translation", type: "range", min: 0, max: 8, step: 0.25, unit: "m", showIf: travels },
  { k: "radial_speed_mps", ref: "radial-flow", type: "range", min: -4, max: 4, step: 0.1, unit: "m/s", showIf: radiates },
  { k: "r_near_m", ref: "radial-flow", type: "range", min: 0.3, max: 4, step: 0.1, unit: "m", showIf: radiates },
  { k: "r_far_m", ref: "radial-flow", type: "range", min: 1, max: 12, step: 0.5, unit: "m", showIf: radiates },
  { k: "fade_frac", ref: "translation", type: "range", min: 0.05, max: 0.5, step: 0.05, showIf: c => travels(c) || radiates(c) },
  { k: "start_azimuths", ref: "azimuth", type: "list", placeholder: "even, or -90, -18, 54, 126, 198", showIf: c => !travels(c) },
  { k: "spacing_deg", ref: "ring", type: "optnum", placeholder: "even", unit: "°", showIf: c => !travels(c) },
  { k: "offset_deg", ref: "ring", type: "range", min: 0, max: 360, step: 5, unit: "°", showIf: c => !travels(c) },
  { k: "random_fraction", ref: "motion-coherence", type: "range", min: 0, max: 1, step: 0.05, structural: true },
  { k: "wander_deg", ref: "motion-coherence", type: "range", min: 0, max: 180, step: 5, unit: "°", showIf: c => c.random_fraction > 0 || c.radial_wander_m > 0 },
  { k: "wander_hz", ref: "motion-coherence", type: "range", min: 0, max: 2, step: 0.05, unit: "Hz", showIf: c => c.random_fraction > 0 || c.radial_wander_m > 0 },
  { k: "radial_wander_m", ref: "motion-coherence", type: "range", min: 0, max: 3, step: 0.05, unit: "m", structural: true },
  { k: "gain_db", ref: "level-matching", type: "range", min: -24, max: 12, step: 1, unit: "dB" },
];

const PARAMS = [
  {
    group: "Decorrelation", ref: "decorrelation", path: "decorr", rows: [
      { k: "amount", ref: "decorrelation-amount", type: "range", min: 0, max: 1, step: 0.01 },
      { k: "family", ref: "velvet-noise", type: "sel", opts: ["velvet", "allpass", "none"] },
      { k: "ir_ms", ref: "ir-length", type: "range", min: 1, max: 200, step: 1, unit: "ms" },
      { k: "density", ref: "impulse-density", type: "range", min: 20, max: 20000, step: 20, unit: "/s", showIf: c => c.family === "velvet" },
      { k: "phase_depth", ref: "phase-depth", type: "range", min: 0, max: 1, step: 0.01, showIf: c => c.family === "allpass" },
      { k: "envelope", ref: "ir-envelope", type: "sel", opts: ["auto", "flat", "hann", "decay"] },
      { k: "decay_db", ref: "ir-envelope", type: "range", min: 6, max: 120, step: 2, unit: "dB", showIf: c => c.envelope === "decay" },
      { k: "per_source_amount", ref: "coherence-hotspot", type: "list", placeholder: "all the same" },
      { k: "crossovers", ref: "crossover", type: "list", placeholder: "off, or 200" },
      { k: "band_amounts", ref: "bass-coherence", type: "list", placeholder: "0, 1", showIf: c => !!(c.crossovers || []).length },
      { k: "micro_delay_ms", ref: "micro-delay", type: "range", min: 0, max: 40, step: 0.5, unit: "ms" },
      { k: "micro_pitch_cents", ref: "micro-pitch", type: "range", min: 0, max: 50, step: 1, unit: "c" },
      { k: "lfo_hz", ref: "coherence-lfo", type: "range", min: 0, max: 8, step: 0.05, unit: "Hz" },
      { k: "lfo_depth", ref: "coherence-lfo", type: "range", min: 0, max: 1, step: 0.01, showIf: c => c.lfo_hz > 0 },
      { k: "lfo_source_spread", ref: "coherence-lfo", type: "range", min: 0, max: 1, step: 0.01, showIf: c => c.lfo_hz > 0 },
      { k: "seed", ref: "seed", type: "int", min: 0, max: 9999, step: 1 },
    ]
  },
  {
    group: "Physical model", ref: "spherical-head-model", rows: [
      { k: "head_radius", ref: "head-radius", type: "range", min: 0.06, max: 0.12, step: 0.0025, unit: "m" },
      { k: "speed_of_sound", ref: "speed-of-sound", type: "range", min: 320, max: 360, step: 1, unit: "m/s" },
      { k: "hrtf_taps", ref: "hrir", type: "sel", opts: [64, 128, 256, 512] },
      { k: "hrtf_grid_step", ref: "hrtf-interpolation", type: "range", min: 0.5, max: 10, step: 0.5, unit: "°" },
      { k: "block", ref: "block-size", type: "sel", opts: [128, 256, 512, 1024] },
    ]
  },
  {
    group: "Coherence hotspot", ref: "circulating-hotspot", path: "hotspot", rows: [
      { k: "enabled", ref: "circulating-hotspot", type: "bool" },
      { k: "deg_per_sec", ref: "circulating-hotspot", type: "range", min: -720, max: 720, step: 5, unit: "°/s", showIf: c => c.enabled },
      { k: "width_deg", ref: "hotspot-width", type: "range", min: 5, max: 180, step: 5, unit: "°", showIf: c => c.enabled },
      { k: "start_deg", ref: "hotspot-width", type: "range", min: 0, max: 360, step: 5, unit: "°", showIf: c => c.enabled },
      { k: "hot_amount", ref: "circulating-hotspot", type: "range", min: 0, max: 1, step: 0.01, showIf: c => c.enabled },
      { k: "bed_amount", ref: "circulating-hotspot", type: "range", min: 0, max: 1, step: 0.01, showIf: c => c.enabled },
      { k: "shape", ref: "hotspot-width", type: "sel", opts: ["gaussian", "cosine"], showIf: c => c.enabled },
    ]
  },
];

const LABELS = {
  n_sources: "sources", rotation_deg_per_sec: "ring rate", offset_deg: "offset",
  spacing_deg: "spacing", start_azimuths: "azimuths", per_source_gain_db: "per-source gain",
  seed: "seed", amount: "amount", family: "family", ir_ms: "IR length",
  density: "density", phase_depth: "phase depth", envelope: "envelope",
  decay_db: "decay", per_source_amount: "per-source amount", crossovers: "crossovers",
  band_amounts: "band amounts", micro_delay_ms: "micro delay",
  micro_pitch_cents: "micro pitch", lfo_hz: "LFO rate", lfo_depth: "LFO depth",
  lfo_source_spread: "LFO spread", enabled: "enabled", deg_per_sec: "hotspot rate",
  width_deg: "width", start_deg: "start angle", hot_amount: "hot amount",
  bed_amount: "bed amount", shape: "falloff",
  head_radius: "head radius", speed_of_sound: "speed of sound",
  hrtf_taps: "HRIR taps", hrtf_grid_step: "azimuth grid", block: "block size",
  distance_m: "distance", gain_db: "gain", random_fraction: "random share",
  wander_deg: "wander range", wander_hz: "wander speed",
  radial_wander_m: "radial wander", decorr_amount: "decorrelation",
  kind: "pattern", heading_deg: "heading", speed_mps: "speed",
  path_m: "path length", spread_m: "width", radial_speed_mps: "radial speed",
  r_near_m: "inner limit", r_far_m: "outer limit", fade_frac: "fade",
  label: "name",
};

// Shared clipboard for ring modules, so a ring built in one variant can be
// pasted into another.
const CLIP = { component: null };

/** Decorrelation rows, reused for the variant default and per-component
 *  overrides so both editors stay in step. */
const DECORR_ROWS = PARAMS.find(g => g.path === "decorr").rows;

const defaultDecorr = () => ({
  amount: 1.0, per_source_amount: null, family: "allpass", ir_ms: 30, density: 1500,
  phase_depth: 1.0, envelope: "auto", decay_db: 60, crossovers: null,
  band_amounts: null, micro_delay_ms: 0, micro_pitch_cents: 0,
  lfo_hz: 0, lfo_depth: 0, lfo_source_spread: 0, seed: 0
});
const defaultHotspot = () => ({
  enabled: false, deg_per_sec: 90, start_deg: 0, width_deg: 80,
  hot_amount: 0, bed_amount: 1, shape: "gaussian"
});
const defaultComponent = (kind = "ring") => {
  const c = {
    kind, label: "", n_sources: 5,
    start_azimuths: kind === "ring" ? [-90, -18, 54, 126, 198] : null,
    spacing_deg: null, offset_deg: 0, distance_m: 2.0,
    rotation_deg_per_sec: kind === "ring" || kind === "spiral" ? 60 : 0,
    heading_deg: 90, speed_mps: 1.5, path_m: 9, spread_m: 3,
    radial_speed_mps: kind === "radial" || kind === "spiral" ? 0.8 : 0,
    r_near_m: 0.7, r_far_m: 6,
    random_fraction: 0, wander_deg: 60, wander_hz: 0.25, radial_wander_m: 0,
    gain_db: 0, fade_frac: 0.3, min_distance_m: 0.4,
    decorr: null, collapsed: false,
  };
  if (kind === "stream" || kind === "radial") c.n_sources = 7;
  return c;
};

const defaultField = () => ({
  components: [defaultComponent("ring")],
  decorr: defaultDecorr(), hotspot: defaultHotspot(),
  head_radius: 0.0875, speed_of_sound: 343, hrtf_taps: 128, hrtf_grid_step: 1,
  block: 256, seed: 0
});

const effectiveRate = cfg => {
  if (!cfg) return 0;
  if (cfg.hotspot?.enabled) return cfg.hotspot.deg_per_sec || 0;
  let r = 0;
  for (const c of (cfg.components || [])) {
    if (!rotates(c)) continue;
    if (Math.abs(c.rotation_deg_per_sec) > Math.abs(r)) r = c.rotation_deg_per_sec;
  }
  return r;
};

const componentMoves = c =>
  (rotates(c) && c.rotation_deg_per_sec !== 0) ||
  (travels(c) && c.speed_mps !== 0) ||
  (radiates(c) && c.radial_speed_mps !== 0) ||
  (c.random_fraction > 0 && c.wander_hz > 0) ||
  (c.radial_wander_m > 0 && c.wander_hz > 0);

const hasMotion = cfg => !!cfg && (
  (cfg.hotspot?.enabled && cfg.hotspot.deg_per_sec !== 0) ||
  (cfg.components || []).some(componentMoves));

function summarize(cfg) {
  if (!cfg) return "original, untreated";
  const comps = cfg.components || [];
  const bits = [];
  if (comps.length > 1) {
    const total = comps.reduce((n, c) => n + c.n_sources, 0);
    const kinds = [...new Set(comps.map(c => KINDS[c.kind]?.label || c.kind))];
    bits.push(`${comps.length} components · ${total} sources`);
    bits.push(kinds.join(" + ").toLowerCase());
  } else if (comps.length === 1) {
    bits.push((KINDS[comps[0].kind]?.label || comps[0].kind).toLowerCase());
    bits.push(componentSummary(comps[0]));
  }
  if (cfg.hotspot?.enabled) {
    bits.push(cfg.hotspot.deg_per_sec ? `hotspot ${cfg.hotspot.deg_per_sec}°/s` : "hotspot frozen");
  }
  bits.push(`${cfg.decorr.family} ${fmt(cfg.decorr.amount, 2)}`);
  return bits.join(" · ");
}

// ====================================================================
// State
// ====================================================================

const S = {
  track: null, duration: 0, peaks: [],
  sel: [84, 104],
  passages: [],
  active: 0,             // index of selected passage
  rendered: null,
  dryBuffer: null,
  buffers: {},           // "pi:vi" -> AudioBuffer
  live: null,            // {pi, vi} currently audible variant, or null for dry
  ref: 0,                // variant index returned to on key release
  playing: false, startedAt: 0, startOffset: 0,
  blind: null,
};

const passage = () => S.passages[S.active];

function newPassage(start, end, name) {
  return {
    name: name || `Passage ${S.passages.length + 1}`,
    start, end, open: true, selected: 1,
    variants: [
      { name: "untreated", config: null },
      { name: "ring rotating 60°/s", config: rotatingRing(60) },
      { name: "ring static · control", config: controlOf(rotatingRing(60)) },
    ]
  };
}

/** A ring of mutually decorrelated sources rotating together: the main
 *  configuration under study. */
function rotatingRing(rate = 60) {
  const c = defaultField();
  c.components[0].rotation_deg_per_sec = rate;
  c.decorr.amount = 1.0;
  c.decorr.family = "allpass";
  return c;
}

/** Sources hold still while the coherence structure sweeps past them. */
function hotspotField(rate = 90) {
  const c = rotatingRing(0);
  c.hotspot = { ...defaultHotspot(), enabled: true, deg_per_sec: rate, width_deg: 80 };
  return c;
}

/** A share of the sources rotates together; the rest wander without a net
 *  direction, after the coherence manipulation in random-dot kinematograms. */
function kinematogramField(fraction = 0.5) {
  const c = rotatingRing(60);
  const k = c.components[0];
  k.n_sources = 7; k.start_azimuths = null;
  k.random_fraction = fraction; k.wander_deg = 70;
  k.label = "partly coherent";
  return c;
}

/** Two rings at different distances and rates: depth in the field. */
function depthField() {
  const c = rotatingRing(40);
  Object.assign(c.components[0], {
    n_sources: 3, start_azimuths: null, distance_m: 1.2, label: "inner",
  });
  c.components.push({ ...defaultComponent("ring"), n_sources: 5,
    start_azimuths: null, rotation_deg_per_sec: 90, distance_m: 3.5,
    label: "outer" });
  return c;
}

function streamField(heading = 90) {
  const c = rotatingRing(0);
  c.components = [{ ...defaultComponent("stream"), heading_deg: heading,
    n_sources: 8, speed_mps: 1.5, label: "crossing" }];
  return c;
}

function radialField(speed = -0.8) {
  const c = rotatingRing(0);
  c.components = [{ ...defaultComponent("radial"), radial_speed_mps: speed,
    n_sources: 8, label: speed < 0 ? "closing in" : "opening out" }];
  return c;
}

function spiralField() {
  const c = rotatingRing(0);
  c.components = [{ ...defaultComponent("spiral"), rotation_deg_per_sec: 70,
    radial_speed_mps: -0.5, n_sources: 8, label: "inward spiral" }];
  return c;
}

/** Rotation near, translation far, each with its own coherence. */
function layeredField() {
  const c = rotatingRing(60);
  Object.assign(c.components[0], {
    n_sources: 4, start_azimuths: null, distance_m: 1.4, label: "near ring",
    decorr: { ...defaultDecorr(), amount: 0.4, family: "velvet" },
  });
  c.components.push({ ...defaultComponent("stream"), n_sources: 7,
    heading_deg: 90, speed_mps: 1.2, path_m: 12, spread_m: 4,
    label: "far crossing",
    decorr: { ...defaultDecorr(), amount: 1.0, family: "allpass" } });
  return c;
}

const VARIANT_PRESETS = [
  { label: "Rotating ring", make: () => rotatingRing(60) },
  { label: "Static control", make: () => controlOf(rotatingRing(60)) },
  { label: "Partial coherence", make: () => { const c = rotatingRing(60); c.decorr.amount = 0.5; return c; } },
  { label: "Coherent ring (degenerate)", make: () => { const c = rotatingRing(60); c.decorr.amount = 0; return c; } },
  { label: "Partly random motion", make: () => kinematogramField(0.5) },
  { label: "Two rings, inner and outer", make: () => depthField() },
  { label: "Stream, left to right", make: () => streamField(90) },
  { label: "Stream, front to back", make: () => streamField(180) },
  { label: "Closing in", make: () => radialField(-0.8) },
  { label: "Opening out", make: () => radialField(0.8) },
  { label: "Inward spiral", make: () => spiralField() },
  { label: "Ring near, stream far", make: () => layeredField() },
  { label: "Circulating hotspot", make: () => hotspotField(90) },
  { label: "Hotspot frozen · control", make: () => controlOf(hotspotField(90)) },
];

/** Same configuration with every kind of motion removed: ring rotation,
 *  hotspot travel, and wander, which freezes at a seed-determined offset. */
function controlOf(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.rotation_deg_per_sec = 0;
  c.total_degrees = null;
  if (c.hotspot) c.hotspot.deg_per_sec = 0;
  for (const r of (c.rings || [])) { r.rotation_deg_per_sec = 0; r.wander_hz = 0; }
  // Every motion kind stops; positions and levels stay where they are, so the
  // ensemble's spatial and level distribution is preserved.
  for (const k of (c.components || [])) {
    k.rotation_deg_per_sec = 0;
    k.speed_mps = 0;
    k.radial_speed_mps = 0;
    k.wander_hz = 0;
  }
  return c;
}

// ====================================================================
// Parameter editor
// ====================================================================

function parseList(s) {
  const t = (s || "").trim();
  if (!t) return null;
  const out = t.split(/[,\s]+/).filter(Boolean).map(Number);
  return out.some(Number.isNaN) ? null : out;
}

function buildParams(host, cfg, onChange) {
  host.innerHTML = "";
  const rebuild = () => buildParams(host, cfg, onChange);

  for (const grp of PARAMS) {
    const obj = grp.path ? cfg[grp.path] : cfg;
    const box = document.createElement("div");
    box.className = "pgroup";
    const gh = document.createElement("div");
    gh.className = "ghead";
    gh.append(grp.group, infoBtn(grp.ref));
    box.appendChild(gh);

    for (const row of grp.rows) {
      if (row.showIf && !row.showIf(obj)) continue;
      const el = document.createElement("div");
      el.className = "prow";
      const lab = document.createElement("span");
      lab.className = "plabel";
      lab.append(LABELS[row.k] || row.k, infoBtn(row.ref));
      el.appendChild(lab);

      const v = obj[row.k];
      const changed = (val, structural) => {
        obj[row.k] = val;
        onChange();
        if (structural) rebuild();
      };

      if (row.type === "range") {
        const sl = document.createElement("input");
        sl.type = "range";
        Object.assign(sl, { min: row.min, max: row.max, step: row.step, value: v ?? 0 });
        const num = document.createElement("input");
        num.type = "number"; num.className = "pval";
        Object.assign(num, { min: row.min, max: row.max, step: row.step, value: v ?? 0 });
        const structural = ["lfo_hz", "crossovers"].includes(row.k);
        sl.addEventListener("input", () => { num.value = sl.value; changed(Number(sl.value), false); });
        sl.addEventListener("change", () => { if (structural) rebuild(); });
        num.addEventListener("change", () => { sl.value = num.value; changed(Number(num.value), structural); });
        el.append(sl, num);
        const u = document.createElement("span");
        u.className = "unit"; u.textContent = row.unit || "";
        el.appendChild(u);
      } else if (row.type === "int") {
        const n = document.createElement("input");
        n.type = "number";
        Object.assign(n, { min: row.min, max: row.max, step: row.step, value: v ?? 0 });
        n.addEventListener("change", () => changed(Number(n.value), false));
        el.appendChild(n);
      } else if (row.type === "optnum") {
        const n = document.createElement("input");
        n.type = "text"; n.placeholder = row.placeholder || ""; n.value = v ?? "";
        n.addEventListener("change", () =>
          changed(n.value.trim() === "" ? null : Number(n.value), false));
        el.appendChild(n);
      } else if (row.type === "sel") {
        const s = document.createElement("select");
        s.innerHTML = row.opts.map(o =>
          `<option value="${o}"${o === v ? " selected" : ""}>${o}</option>`).join("");
        s.addEventListener("change", () => changed(s.value, true));
        el.appendChild(s);
      } else if (row.type === "bool") {
        const c = document.createElement("input");
        c.type = "checkbox"; c.checked = !!v;
        c.addEventListener("change", () => changed(c.checked, true));
        el.appendChild(c);
      } else if (row.type === "list") {
        const t = document.createElement("input");
        t.type = "text"; t.placeholder = row.placeholder || "";
        t.value = Array.isArray(v) ? v.join(", ") : "";
        t.addEventListener("change", () => changed(parseList(t.value), row.k === "crossovers"));
        el.appendChild(t);
      }
      box.appendChild(el);
    }
    host.appendChild(box);
  }
}

// ====================================================================
// Ring modules
// ====================================================================

const HEADINGS = { 0: "→ front", 90: "→ right", 180: "→ back", 270: "→ left" };

function componentSummary(c) {
  const bits = [`${c.n_sources} src`];
  if (rotates(c)) bits.push(c.rotation_deg_per_sec ? `${c.rotation_deg_per_sec}°/s` : "still");
  if (travels(c)) {
    const h = HEADINGS[Math.round(c.heading_deg / 90) * 90 % 360] || `${c.heading_deg}°`;
    bits.push(`${h} ${fmt(Math.abs(c.speed_mps), 1)} m/s`);
  }
  if (radiates(c) && c.radial_speed_mps)
    bits.push(`${c.radial_speed_mps > 0 ? "outward" : "inward"} ${fmt(Math.abs(c.radial_speed_mps), 1)} m/s`);
  if (c.kind === "ring") bits.push(`${fmt(c.distance_m, 1)} m`);
  if (c.random_fraction > 0) bits.push(`${Math.round(c.random_fraction * 100)}% random`);
  if (c.decorr) bits.push(`decorr ${fmt(c.decorr.amount, 2)}`);
  return bits.join(" · ");
}

/** One row of controls bound to obj[row.k]. Shared by the ring editor. */
function makeParamRow(row, obj, onChange, rebuild) {
  const el = document.createElement("div");
  el.className = "prow";
  const lab = document.createElement("span");
  lab.className = "plabel";
  lab.append(LABELS[row.k] || row.k, infoBtn(row.ref));
  el.appendChild(lab);
  const v = obj[row.k];
  const changed = (val, structural) => { obj[row.k] = val; onChange(); if (structural) rebuild(); };

  if (row.type === "range") {
    const sl = document.createElement("input");
    sl.type = "range";
    Object.assign(sl, { min: row.min, max: row.max, step: row.step, value: v ?? 0 });
    const num = document.createElement("input");
    num.type = "number"; num.className = "pval";
    Object.assign(num, { min: row.min, max: row.max, step: row.step, value: v ?? 0 });
    const structural = ["random_fraction", "radial_wander_m"].includes(row.k);
    sl.addEventListener("input", () => { num.value = sl.value; changed(Number(sl.value), false); });
    sl.addEventListener("change", () => { if (structural) rebuild(); });
    num.addEventListener("change", () => { sl.value = num.value; changed(Number(num.value), structural); });
    el.append(sl, num);
    const u = document.createElement("span");
    u.className = "unit"; u.textContent = row.unit || "";
    el.appendChild(u);
  } else if (row.type === "int") {
    const n = document.createElement("input");
    n.type = "number";
    Object.assign(n, { min: row.min, max: row.max, step: row.step, value: v ?? 0 });
    n.addEventListener("change", () => changed(Number(n.value), false));
    el.appendChild(n);
  } else if (row.type === "optnum") {
    const n = document.createElement("input");
    n.type = "text"; n.placeholder = row.placeholder || ""; n.value = v ?? "";
    n.addEventListener("change", () => changed(n.value.trim() === "" ? null : Number(n.value), false));
    el.appendChild(n);
  } else if (row.type === "list") {
    const t = document.createElement("input");
    t.type = "text"; t.placeholder = row.placeholder || "";
    t.value = Array.isArray(v) ? v.join(", ") : "";
    t.addEventListener("change", () => changed(parseList(t.value), false));
    el.appendChild(t);
  }
  return el;
}

function buildComponentEditor(host, cfg, onChange) {
  host.innerHTML = "";
  if (!cfg.components) cfg.components = [defaultComponent()];
  const rebuild = () => buildComponentEditor(host, cfg, onChange);

  cfg.components.forEach((c, ci) => {
    const mod = document.createElement("div");
    mod.className = "ringmod";
    if (c.collapsed) mod.classList.add("collapsed");

    const head = document.createElement("div");
    head.className = "rmhead";
    const twist = document.createElement("button");
    twist.className = "sm ghost twist";
    twist.textContent = c.collapsed ? "▸" : "▾";
    twist.addEventListener("click", e => {
      e.stopPropagation(); c.collapsed = !c.collapsed; rebuild();
    });
    head.appendChild(twist);

    const name = document.createElement("input");
    name.className = "cname";
    name.value = c.label || "";
    name.placeholder = `${KINDS[c.kind]?.label || c.kind} ${ci + 1}`;
    name.addEventListener("change", () => { c.label = name.value; onChange(); });
    head.appendChild(name);

    const sum = document.createElement("span");
    sum.className = "rmsum";
    sum.textContent = componentSummary(c);
    head.append(sum, Object.assign(document.createElement("span"), { className: "grow" }));

    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.className = "sm"; b.textContent = label; b.title = title;
      b.addEventListener("click", e => { e.stopPropagation(); fn(); });
      return b;
    };
    head.appendChild(mk("Duplicate", "insert a copy below", () => {
      cfg.components.splice(ci + 1, 0, JSON.parse(JSON.stringify(c)));
      rebuild(); onChange();
    }));
    head.appendChild(mk("Copy", "copy; paste into any variant", () => {
      CLIP.component = JSON.parse(JSON.stringify(c));
      rebuild();
    }));
    if (cfg.components.length > 1) {
      head.appendChild(mk("Remove", "remove this component", () => {
        cfg.components.splice(ci, 1); rebuild(); onChange();
      }));
    }
    mod.appendChild(head);

    if (!c.collapsed) {
      const body = document.createElement("div");
      body.className = "rmbody";
      const refresh = () => { sum.textContent = componentSummary(c); onChange(); };
      for (const row of COMPONENT_ROWS) {
        if (row.showIf && !row.showIf(c)) continue;
        body.appendChild(makeParamRow(row, c, refresh,
          row.structural ? rebuild : () => { }));
      }

      // Per-component decorrelation, so two components in one field can carry
      // different coherence.
      const dec = document.createElement("div");
      dec.className = "pgroup";
      const dh = document.createElement("div");
      dh.className = "ghead";
      dh.append("Decorrelation", infoBtn("decorrelation"));
      const toggle = document.createElement("button");
      toggle.className = "sm";
      toggle.textContent = c.decorr ? "use variant's" : "override";
      toggle.title = c.decorr
        ? "fall back to the variant's decorrelation"
        : "give this component its own decorrelation";
      toggle.addEventListener("click", () => {
        c.decorr = c.decorr ? null : JSON.parse(JSON.stringify(cfg.decorr));
        rebuild(); onChange();
      });
      dh.append(Object.assign(document.createElement("span"), { className: "grow" }), toggle);
      dec.appendChild(dh);
      if (c.decorr) {
        for (const row of DECORR_ROWS) {
          if (row.showIf && !row.showIf(c.decorr)) continue;
          dec.appendChild(makeParamRow(row, c.decorr, refresh, rebuild));
        }
      } else {
        const n = document.createElement("div");
        n.className = "note";
        n.textContent = "Inheriting the variant's decorrelation.";
        dec.appendChild(n);
      }
      body.appendChild(dec);
      mod.appendChild(body);
    }
    host.appendChild(mod);
  });

  const bar = document.createElement("div");
  bar.className = "ringbar";
  const addSel = document.createElement("select");
  addSel.className = "sm";
  addSel.innerHTML = `<option value="">Add component…</option>` +
    Object.entries(KINDS).map(([k, v]) =>
      `<option value="${k}">${v.label} — ${v.hint}</option>`).join("");
  addSel.addEventListener("change", () => {
    if (!addSel.value) return;
    cfg.components.push(defaultComponent(addSel.value));
    rebuild(); onChange();
  });
  bar.appendChild(addSel);
  if (CLIP.component) {
    const paste = document.createElement("button");
    paste.className = "sm"; paste.textContent = "Paste component";
    paste.addEventListener("click", () => {
      cfg.components.push(JSON.parse(JSON.stringify(CLIP.component)));
      rebuild(); onChange();
    });
    bar.appendChild(paste);
  }
  host.appendChild(bar);
}

// ====================================================================
// Passage list
// ====================================================================

function renderPassages() {
  const host = $("#passages");
  host.innerHTML = "";

  S.passages.forEach((p, pi) => {
    const el = document.createElement("div");
    el.className = "passage" + (pi === S.active ? " sel" : "");

    const head = document.createElement("div");
    head.className = "pashead";
    const name = document.createElement("input");
    name.className = "pname"; name.value = p.name; name.style.flex = "1";
    name.addEventListener("click", e => e.stopPropagation());
    name.addEventListener("change", () => { p.name = name.value; });
    const span = document.createElement("span");
    span.className = "span";
    span.textContent = `${fmt(p.start, 1)}–${fmt(p.end, 1)}s`;
    head.append(name, span);

    const mk = (label, title, fn, cls = "sm") => {
      const b = document.createElement("button");
      b.className = cls; b.textContent = label; b.title = title;
      b.addEventListener("click", e => { e.stopPropagation(); fn(); });
      return b;
    };
    const add = document.createElement("select");
    add.innerHTML = `<option value="">+ variant…</option>` +
      VARIANT_PRESETS.map((pr, i) => `<option value="${i}">${pr.label}</option>`).join("");
    add.addEventListener("click", e => e.stopPropagation());
    add.addEventListener("change", () => {
      const pr = VARIANT_PRESETS[Number(add.value)];
      if (!pr) return;
      p.variants.push({ name: pr.label.toLowerCase(), config: pr.make() });
      renderPassages(); markStale();
    });
    head.appendChild(add);
    head.appendChild(mk("×", "remove passage", () => {
      S.passages.splice(pi, 1);
      S.active = clamp(S.active, 0, S.passages.length - 1);
      renderPassages(); markStale();
    }, "sm ghost"));
    head.addEventListener("click", () => {
      S.active = pi; p.open = !p.open; renderPassages(); showMetrics();
    });
    el.appendChild(head);

    if (p.open) {
      const body = document.createElement("div");
      body.className = "pasbody";

      p.variants.forEach((v, vi) => {
        const isLive = S.live && S.live.pi === pi && S.live.set.includes(vi);
        const vr = document.createElement("div");
        vr.className = "variant" + (isLive ? " live" : "") + (vi === S.ref ? " ref" : "");

        const key = document.createElement("span");
        key.className = "key"; key.textContent = vi === 0 ? "–" : vi;
        vr.appendChild(key);

        const vn = document.createElement("input");
        vn.className = "vname"; vn.value = v.name;
        vn.addEventListener("change", () => { v.name = vn.value; });
        vr.appendChild(vn);

        const tag = document.createElement("span");
        const isControl = v.config && effectiveRate(v.config) === 0 &&
          (v.config.hotspot?.enabled || true);
        tag.className = "tag " + (v.config ? "spin" : "dry");
        tag.textContent = v.config ? summarize(v.config) : "original";
        vr.appendChild(tag);
        vr.appendChild(document.createElement("span")).className = "grow";

        if (v.config && effectiveRate(v.config) !== 0) {
          vr.appendChild(mk("+ control", "add the matched static twin", () => {
            p.variants.splice(vi + 1, 0, {
              name: v.name + " · control", config: controlOf(v.config)
            });
            renderPassages(); markStale();
          }));
        }
        vr.appendChild(mk("edit", "show parameters", () => {
          v.open = !v.open; renderPassages();
        }));
        if (vi > 0) vr.appendChild(mk("×", "remove variant", () => {
          p.variants.splice(vi, 1); renderPassages(); markStale();
        }, "sm ghost"));

        vr.addEventListener("click", e => {
          if (e.target.closest("button, input")) return;
          S.active = pi; applyVariant(pi, vi);
        });
        body.appendChild(vr);

        if (v.open && v.config) {
          const pane = document.createElement("div");
          pane.style.cssText = "padding:2px 8px 10px 26px";
          const onchg = () => { tag.textContent = summarize(v.config); markStale(); };
          const compHost = document.createElement("div");
          buildComponentEditor(compHost, v.config, onchg);
          pane.appendChild(compHost);
          const rest = document.createElement("div");
          buildParams(rest, v.config, onchg);
          pane.appendChild(rest);
          body.appendChild(pane);
        } else if (v.open && !v.config) {
          const pane = document.createElement("div");
          pane.style.cssText = "padding:4px 8px 10px 26px";
          pane.innerHTML = `<span class="note">The untreated reference. Plays the
            same mono sum the spatializer receives, loudness matched.</span> `;
          pane.appendChild(infoBtn("mono-dry"));
          body.appendChild(pane);
        }
      });

      el.appendChild(body);
    }
    host.appendChild(el);
  });

  if (!S.passages.length) {
    host.innerHTML = `<p class="note">No passages yet. Drag a region on the
      waveform and click <em>Add passage from selection</em>.</p>`;
  }
}

function markStale() {
  const m = $("#renderstate");
  m.textContent = "Settings changed since the last render.";
  m.className = "msg stale";
}

// ====================================================================
// Waveform
// ====================================================================

function drawWave() {
  const c = $("#wave");
  const w = c.clientWidth, h = c.height;
  if (c.width !== w) c.width = w;
  const x = c.getContext("2d");
  const css = getComputedStyle(document.body);
  x.clearRect(0, 0, w, h);
  x.fillStyle = "#f1efea"; x.fillRect(0, 0, w, h);
  if (!S.peaks.length || !S.duration) return;
  const px = t => (t / S.duration) * w;

  // passages
  S.passages.forEach((p, i) => {
    x.fillStyle = i === S.active ? "rgba(44,95,124,.16)" : "rgba(44,95,124,.07)";
    x.fillRect(px(p.start), 0, Math.max(px(p.end) - px(p.start), 1), h);
    x.fillStyle = "#2c5f7c"; x.font = "11px system-ui";
    x.fillText(p.name, px(p.start) + 4, 12);
  });

  // selection
  const [a, b] = S.sel;
  x.strokeStyle = "#9a5b2d"; x.setLineDash([3, 3]);
  [a, b].forEach(t => { x.beginPath(); x.moveTo(px(t), 0); x.lineTo(px(t), h); x.stroke(); });
  x.setLineDash([]);

  // waveform
  x.strokeStyle = "#8b857a"; x.lineWidth = 1; x.beginPath();
  S.peaks.forEach((v, i) => {
    const xx = (i / S.peaks.length) * w, hh = v * h * 0.40;
    x.moveTo(xx + .5, h / 2 - hh); x.lineTo(xx + .5, h / 2 + hh);
  });
  x.stroke();

  // playhead
  if (S.rendered) {
    const t = playPosition();
    x.strokeStyle = "#a33a2a"; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(px(t), 0); x.lineTo(px(t), h); x.stroke();
  }

  x.fillStyle = "#7c766c"; x.font = "10px ui-monospace, monospace";
  const step = Math.max(15, Math.round(S.duration / 18 / 15) * 15);
  for (let t = 0; t < S.duration; t += step) x.fillText(mmss(t), px(t) + 2, h - 3);
}

function wireWave() {
  const c = $("#wave");
  let from = null;
  const tAt = e => {
    const r = c.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width * S.duration, 0, S.duration);
  };
  c.addEventListener("mousedown", e => { from = tAt(e); });
  c.addEventListener("mousemove", e => {
    if (from === null) return;
    const t = tAt(e);
    S.sel = [Math.min(from, t), Math.max(from, t)];
    syncSel(); drawWave();
  });
  addEventListener("mouseup", e => {
    if (from === null) return;
    const t = tAt(e);
    if (Math.abs(t - from) < 0.4) {                 // a click: seek there
      const hit = S.passages.findIndex(p => t >= p.start && t <= p.end);
      if (hit >= 0) { S.active = hit; renderPassages(); }
      if (S.rendered) seekTo(t);
    } else if (S.sel[1] - S.sel[0] < 1) {
      S.sel[1] = S.sel[0] + 1;
    }
    from = null; syncSel(); drawWave();
  });
  addEventListener("resize", drawWave);
}

const syncSel = () => {
  $("#pstart").value = S.sel[0].toFixed(1);
  $("#pend").value = S.sel[1].toFixed(1);
};

// ====================================================================
// Render and playback
// ====================================================================

const AC = new (window.AudioContext || window.webkitAudioContext)();
let dryGain = null, dryNode = null;
let varNodes = [];      // {pi, vi, src, gain}

async function doRender() {
  if (!S.passages.length) return;
  stopPlayback();
  const btn = $("#render");
  btn.disabled = true;
  btn.classList.add("busy");
  const prevLabel = btn.textContent;
  btn.textContent = "Rendering…";
  const msg = $("#renderstate");
  msg.className = "msg";
  msg.textContent = "Rendering…";
  try {
    const res = await post("/api/render", {
      track: S.track, mode: "session",
      match: $("#match").value, dry_mono: $("#drymono").checked,
      with_trace: true, with_metrics: true,
      passages: S.passages.map(p => ({
        name: p.name, start: p.start, end: p.end,
        variants: p.variants.map(v => ({ label: v.name, config: v.config }))
      }))
    });
    S.rendered = res;

    msg.textContent = "Decoding…";
    S.dryBuffer = await decode(res.dry.url);
    S.buffers = {};
    await Promise.all(res.passages.flatMap((p, pi) =>
      p.variants.map(async (v, vi) => {
        if (v.url) S.buffers[`${pi}:${vi}`] = await decode(v.url);
      })));

    msg.textContent = `Rendered in ${res.render_seconds}s.`;
    showMetrics();
    startPlayback(passage()?.start ?? 0);
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = "Render failed: " + e.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
    btn.textContent = prevLabel;
  }
}

async function decode(url) {
  return AC.decodeAudioData(await (await fetch(url)).arrayBuffer());
}

function stopPlayback() {
  [dryNode, ...varNodes.map(v => v.src)].forEach(s => { try { s?.stop(); } catch (_) { } });
  dryNode = null; varNodes = [];
  S.playing = false;
  $("#play").textContent = "Play";
}

/** Start the untreated spine and schedule every variant alongside it, silent
 *  and in step, so applying one is a gain change rather than a restart. */
function startPlayback(atTrackTime = 0) {
  if (!S.dryBuffer) return;
  stopPlayback();
  if (AC.state === "suspended") AC.resume();

  const loop = $("#loop").checked;
  const p = passage();
  const t0 = AC.currentTime + 0.08;

  dryGain = AC.createGain();
  dryGain.gain.value = S.live ? 0 : 1;
  dryGain.connect(AC.destination);
  dryNode = AC.createBufferSource();
  dryNode.buffer = S.dryBuffer;
  if (loop && p) {
    dryNode.loop = true;
    dryNode.loopStart = p.start;
    dryNode.loopEnd = p.end;
    atTrackTime = clamp(atTrackTime, p.start, p.end - 0.01);
  }
  dryNode.connect(dryGain);
  dryNode.start(t0, atTrackTime);

  S.rendered.passages.forEach((rp, pi) => {
    if (loop && pi !== S.active) return;          // only the looped one is needed
    rp.variants.forEach((rv, vi) => {
      const buf = S.buffers[`${pi}:${vi}`];
      if (!buf) return;
      const offset = atTrackTime - rp.start;
      if (!loop && offset >= buf.duration) return;   // passage already behind us
      const g = AC.createGain();
      const isLive = S.live && S.live.pi === pi && S.live.vi === vi;
      g.gain.value = isLive ? 1 : 0;
      g.connect(AC.destination);
      const src = AC.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      src.connect(g);
      if (loop) src.start(t0, clamp(offset, 0, buf.duration - 0.001));
      else src.start(t0 + Math.max(0, -offset), Math.max(0, offset));
      varNodes.push({ pi, vi, src, gain: g });
    });
  });

  S.startedAt = t0; S.startOffset = atTrackTime; S.playing = true;
  $("#play").textContent = "Pause";
}

function playPosition() {
  if (!S.rendered) return 0;
  if (!S.playing) return S.startOffset;
  let t = S.startOffset + (AC.currentTime - S.startedAt);
  const p = passage();
  if ($("#loop").checked && p) {
    const len = p.end - p.start;
    t = p.start + (((t - p.start) % len) + len) % len;
  }
  return clamp(t, 0, S.duration);
}

const seekTo = t => { if (S.playing) startPlayback(t); else { S.startOffset = t; drawWave(); } };

/** Crossfade to a set of variants, or back to the untreated spine.
 *
 * `vi` may be one index or a list, so several variants can sound together. A
 * combined set is scaled by 1/sqrt(count): the variants are largely
 * decorrelated from one another, so their powers add, and without the scaling
 * holding two keys would simply be louder and would win any comparison on that
 * basis alone.
 */
function applyVariant(pi, vi, ms) {
  if (!S.rendered) return;
  const list = (Array.isArray(vi) ? vi : [vi])
    .filter(i => i !== null && i !== undefined && i !== 0);
  S.live = list.length ? { pi, vi: list[0], set: list } : null;
  const share = list.length ? 1 / Math.sqrt(list.length) : 1;
  const T = (ms ?? Number($("#fadems").value)) / 1000;
  const t0 = AC.currentTime;

  const ramp = (param, target) => {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t0);
    else param.cancelScheduledValues(t0);
    const cur = param.value;
    if (T <= 0.001 || Math.abs(cur - target) < 1e-4) {
      param.setValueAtTime(target, t0);
      return;
    }
    // Equal power: hold cur^2 + target^2 constant across the transition, so a
    // crossfade between decorrelated signals does not dip in the middle.
    const N = 32, curve = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      const x = n / (N - 1);
      curve[n] = Math.sqrt(cur * cur * (1 - x) + target * target * x);
    }
    param.setValueCurveAtTime(curve, t0, T);
  };

  if (dryGain) ramp(dryGain.gain, S.live ? 0 : 1);
  varNodes.forEach(n => ramp(n.gain.gain,
    S.live && n.pi === S.live.pi && S.live.set.includes(n.vi) ? share : 0));

  renderPassages();
  showMetrics();
}

function wireTransport() {
  $("#play").addEventListener("click", () => {
    if (!S.rendered) return doRender();
    if (S.playing) { S.startOffset = playPosition(); stopPlayback(); }
    else startPlayback(S.startOffset);
  });
  $("#seek").addEventListener("input", e => seekTo(Number(e.target.value) * S.duration));
  $("#loop").addEventListener("change", () => { if (S.playing) startPlayback(playPosition()); });
  $("#playmode").addEventListener("change", () => {
    if (S.playing) startPlayback(playPosition());
  });

  // Hold a number to audition that variant, release to fall back to the
  // reference. Instant switching mid-note is far more sensitive than
  // comparing two separate listens: auditory memory for spatial quality is short.
  // Holding several numbers sounds several variants together.
  const held = new Set();
  const applyHeld = () => {
    const set = [...held].map(Number).filter(n => n < passage().variants.length);
    applyVariant(S.active, set.length ? set : S.ref);
  };
  addEventListener("keydown", e => {
    if (e.target.matches("input, select, textarea")) return;
    if ($("#sheet").classList.contains("on") || Tour.active) return;
    if (e.code === "Space") { e.preventDefault(); $("#play").click(); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9 && passage() && n < passage().variants.length) {
      if (!held.has(e.key)) { held.add(e.key); applyHeld(); }
      e.preventDefault();
    }
  });
  addEventListener("keyup", e => {
    if (held.delete(e.key)) applyHeld();
  });
  addEventListener("blur", () => { if (held.size) { held.clear(); applyHeld(); } });
}

// ====================================================================
// Ring view and readout
// ====================================================================

function frameAt(trace, t) {
  if (!trace || !trace.length) return null;
  let lo = 0, hi = trace.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (trace[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return trace[lo];
}

function liveVariant() {
  if (!S.rendered) return null;
  if (!S.live) return null;
  return S.rendered.passages[S.live.pi]?.variants[S.live.vi] || null;
}

const TRAIL_SECONDS = 1.4;

/** One colour per component, so a field of several reads as several. */
const COMP_COLOURS = [
  [44, 95, 124], [154, 91, 45], [61, 107, 82],
  [122, 74, 122], [163, 58, 42], [70, 90, 110],
];

/** Frames covering [t0, t1]. Used for motion trails. */
function framesBetween(trace, t0, t1) {
  if (!trace || !trace.length) return [];
  let lo = 0, hi = trace.length - 1;
  while (lo < hi) {                       // first frame at or after t0
    const mid = (lo + hi) >> 1;
    if (trace[mid].t < t0) lo = mid + 1; else hi = mid;
  }
  const out = [];
  for (let i = lo; i < trace.length && trace[i].t <= t1; i++) out.push(trace[i]);
  return out;
}

function drawRing() {
  const c = $("#ring"), x = c.getContext("2d");
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.33;
  x.clearRect(0, 0, w, h);
  const pos = a => {
    const r = (a - 90) * Math.PI / 180;
    return [cx + R * Math.cos(r), cy + R * Math.sin(r)];
  };

  x.strokeStyle = "#ddd8cf"; x.lineWidth = 1;
  x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = "#b8b1a5";
  x.beginPath(); x.arc(cx, cy, 15, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.moveTo(cx, cy - 15); x.lineTo(cx, cy - 22); x.stroke();
  x.fillStyle = "#7c766c"; x.font = "10px system-ui";
  x.fillText("L", cx - 29, cy + 4); x.fillText("R", cx + 23, cy + 4);
  x.fillText("front", cx - 14, cy - R - 12);
  x.fillText("back", cx - 12, cy + R + 20);

  const v = liveVariant();
  if (!v || !v.params) {
    x.fillStyle = "#9a5b2d"; x.font = "12px system-ui";
    const t = S.rendered ? "playing untreated" : "not rendered";
    x.fillText(t, cx - x.measureText(t).width / 2, cy + R + 44);
    return;
  }

  const rp = S.rendered.passages[S.live.pi];
  const now = playPosition() - rp.start;
  const fr = frameAt(v.trace, now);
  if (!fr) return;

  // Distance maps to drawn radius: nearer sources sit nearer the head. The
  // scale is chosen so the farthest ring in the variant fits the canvas.
  const REFD = 2.0;
  const nSrc = fr.az.length;
  const ringOf = v.params.resolved_component_of || v.params.resolved_ring_of
    || Array(nSrc).fill(0);
  const baseDist = v.params.resolved_distances || Array(nSrc).fill(REFD);
  const lvlAt = frame => frame.lvl || Array(nSrc).fill(1);
  const distAt = frame => frame.dist || baseDist;
  const unit = d => Math.pow(Math.max(d, 0.2) / REFD, 0.7);
  const maxUnit = Math.max(1, ...baseDist.map(unit)) * 1.02;
  const rpix = d => R * unit(d) / maxUnit;
  const posD = (a, d) => {
    const r = (a - 90) * Math.PI / 180;
    const rr = rpix(d);
    return [cx + rr * Math.cos(r), cy + rr * Math.sin(r)];
  };

  // Guide circle per distinct ring distance.
  const seen = new Set();
  for (const d of baseDist) {
    const key = Math.round(d * 10);
    if (seen.has(key)) continue;
    seen.add(key);
    x.strokeStyle = "#e6e2d9"; x.setLineDash([2, 4]);
    x.beginPath(); x.arc(cx, cy, rpix(d), 0, Math.PI * 2); x.stroke();
    x.setLineDash([]);
  }

  // Motion trails: where each source has just been.
  const trail = framesBetween(v.trace, now - TRAIL_SECONDS, now);
  if (trail.length > 1) {
    x.lineCap = "round";
    for (let i = 0; i < nSrc; i++) {
      for (let k = 1; k < trail.length; k++) {
        const a0 = trail[k - 1].az[i], a1 = trail[k].az[i];
        if (Math.abs(a1 - a0) > 180) continue;         // skip the 360 wrap
        const age = k / trail.length;
        const [x0, y0] = posD(a0, distAt(trail[k - 1])[i]);
        const [x1, y1] = posD(a1, distAt(trail[k])[i]);
        const [cr, cg, cb] = COMP_COLOURS[ringOf[i] % COMP_COLOURS.length];
        const lv = lvlAt(trail[k])[i];
        x.strokeStyle = `rgba(${cr},${cg},${cb},${(0.62 * age * age * lv).toFixed(3)})`;
        x.lineWidth = 1.2 + 3.4 * age;
        x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke();
      }
    }
    x.lineCap = "butt";

    // Constellation per ring, drawn now and a moment ago. Sources rotating in
    // unison keep the shape rigid; wanderers visibly deform it.
    const nRings = Math.max(...ringOf) + 1;
    const poly = (frame, alpha, dash) => {
      for (let g = 0; g < nRings; g++) {
        // Only closed patterns have a meaningful outline; a stream is a line
        // of sources passing through, and joining its ends would draw a shape
        // that is not there.
        const kind = v.params.resolved_components?.[g]?.kind || "ring";
        if (kind === "stream") continue;
        const idx = [];
        for (let i = 0; i < nSrc; i++) if (ringOf[i] === g) idx.push(i);
        if (idx.length < 2) continue;
        const [cr, cg, cb] = COMP_COLOURS[g % COMP_COLOURS.length];
        x.strokeStyle = `rgba(${cr},${cg},${cb},${alpha})`;
        x.lineWidth = 1;
        x.setLineDash(dash);
        x.beginPath();
        idx.forEach((i, k) => {
          const [px_, py] = posD(frame.az[i], distAt(frame)[i]);
          k ? x.lineTo(px_, py) : x.moveTo(px_, py);
        });
        x.closePath(); x.stroke();
        x.setLineDash([]);
      }
    };
    poly(trail[0], 0.16, [3, 3]);
    poly(fr, 0.42, []);
  }

  // Hotspot, only when one is actually running.
  if (fr.hot !== null && fr.hot !== undefined) {
    const width = v.params.hotspot?.width_deg || 60;
    const [hx, hy] = posD(fr.hot, REFD);
    const rad = Math.max(R * width / 120, 12);
    const grd = x.createRadialGradient(hx, hy, 0, hx, hy, rad);
    grd.addColorStop(0, "rgba(154,91,45,.28)");
    grd.addColorStop(1, "rgba(154,91,45,0)");
    x.fillStyle = grd;
    x.beginPath(); x.arc(hx, hy, rad, 0, Math.PI * 2); x.fill();
    x.strokeStyle = "#9a5b2d"; x.setLineDash([2, 3]);
    x.beginPath(); x.moveTo(cx, cy); x.lineTo(hx, hy); x.stroke();
    x.setLineDash([]);
  }

  fr.az.forEach((a, i) => {
    const [sx, sy] = posD(a, distAt(fr)[i]);
    const coh = 1 - (fr.amt[i] ?? 1);       // filled = coherent, hollow = decorrelated
    const lv = lvlAt(fr)[i];                // a fading source fades on screen
    const [cr, cg, cb] = COMP_COLOURS[ringOf[i] % COMP_COLOURS.length];
    x.beginPath(); x.arc(sx, sy, 4.5 + 4.5 * coh, 0, Math.PI * 2);
    x.fillStyle = `rgba(${cr},${cg},${cb},${((0.10 + 0.85 * coh) * lv).toFixed(3)})`;
    x.fill();
    x.strokeStyle = `rgba(${cr},${cg},${cb},${(0.25 + 0.75 * lv).toFixed(3)})`;
    x.lineWidth = 1.2; x.stroke();
  });

  const comps = v.params.resolved_components || [];
  const domRate = comps.filter(c => c.kind === "ring" || c.kind === "spiral")
    .reduce((a, c) => Math.abs(c.rotation_deg_per_sec) > Math.abs(a)
      ? c.rotation_deg_per_sec : a, 0);
  drawRotationArrow(x, cx, cy, R + 17, domRate, "#2c5f7c");
  const hot = v.params.hotspot;
  if (hot?.enabled && hot.deg_per_sec) {
    drawRotationArrow(x, cx, cy, R + 31, hot.deg_per_sec, "#9a5b2d");
  }
  // Arrow showing where a stream is heading.
  for (const c of comps) {
    if (c.kind !== "stream" || !c.speed_mps) continue;
    const dir = (c.heading_deg + (c.speed_mps < 0 ? 180 : 0)) * Math.PI / 180;
    const ax = cx + Math.sin(dir) * (R + 26), ay = cy - Math.cos(dir) * (R + 26);
    x.fillStyle = "#3d6b52";
    x.beginPath();
    x.moveTo(ax + 7 * Math.sin(dir), ay - 7 * Math.cos(dir));
    x.lineTo(ax + 5 * Math.sin(dir + 2.4), ay - 5 * Math.cos(dir + 2.4));
    x.lineTo(ax + 5 * Math.sin(dir - 2.4), ay - 5 * Math.cos(dir - 2.4));
    x.closePath(); x.fill();
  }

  x.fillStyle = "#7c766c"; x.font = "10px system-ui";
  x.fillText("filled = coherent, hollow = decorrelated", 6, h - 18);
  const labels = v.params.component_labels || [];
  const bits = comps.map((c, i) => {
    const name = labels[i] || c.kind;
    if (c.kind === "stream") return `${name}: ${fmt(c.speed_mps, 1)} m/s`;
    if (c.kind === "radial") return `${name}: ${fmt(c.radial_speed_mps, 1)} m/s`;
    if (c.kind === "spiral") return `${name}: ${fmt(c.rotation_deg_per_sec, 0)}°/s, ${fmt(c.radial_speed_mps, 1)} m/s`;
    return `${name}: ${c.rotation_deg_per_sec ? fmt(c.rotation_deg_per_sec, 0) + "°/s" : "still"}`;
  });
  if (hot?.enabled) bits.push(hot.deg_per_sec ? `hotspot ${fmt(hot.deg_per_sec, 0)}°/s` : "hotspot frozen");
  x.fillStyle = "#4a4640";
  x.fillText(bits.join("   ·   ").slice(0, 90), 6, h - 5);
}

/** Curved arrow outside the ring showing which way, and how fast, it turns. */
function drawRotationArrow(x, cx, cy, r, degPerSec, colour) {
  if (!degPerSec) return;
  const cw = degPerSec > 0;
  const span = clamp(Math.abs(degPerSec) / 360 * 90, 16, 110) * Math.PI / 180;
  const mid = -Math.PI / 2;                 // centred at the front
  const a0 = mid - span / 2, a1 = mid + span / 2;

  x.strokeStyle = colour; x.lineWidth = 1.4;
  x.beginPath(); x.arc(cx, cy, r, a0, a1); x.stroke();

  const tip = cw ? a1 : a0;
  const dir = cw ? 1 : -1;
  const tx = cx + r * Math.cos(tip), ty = cy + r * Math.sin(tip);
  const tang = tip + dir * Math.PI / 2;     // along the arc, in travel direction
  x.fillStyle = colour;
  x.beginPath();
  x.moveTo(tx + 5 * Math.cos(tang), ty + 5 * Math.sin(tang));
  x.lineTo(tx + 4 * Math.cos(tang + 2.4), ty + 4 * Math.sin(tang + 2.4));
  x.lineTo(tx + 4 * Math.cos(tang - 2.4), ty + 4 * Math.sin(tang - 2.4));
  x.closePath(); x.fill();
}

function updateNow() {
  const bar = $("#nowbar");
  if (!S.rendered) { bar.innerHTML = '<span class="dim">Nothing rendered yet.</span>'; return; }
  const v = liveVariant();
  const p = passage();
  const set = S.live?.set || [];
  bar.innerHTML = set.length
    ? set.map(i => `<span class="tag spin">${esc(S.rendered.passages[S.live.pi].variants[i]?.label || i)}</span>`).join("")
      + `<span class="dim">${set.length > 1 ? `${set.length} applied together` : "applied"}</span>`
    : `<span class="tag dry">untreated</span><span class="dim">hold one or more number keys to apply variants</span>`;

  const host = $("#readout");
  if (!v || !v.params) {
    host.innerHTML = p
      ? `<span class="note">${esc(p.name)}, ${fmt(p.start, 1)}–${fmt(p.end, 1)}s, playing untreated.</span>`
      : "";
    return;
  }
  const pr = v.params, d = pr.resolved_decorr, hs = pr.hotspot;
  const rp = S.rendered.passages[S.live.pi];
  const fr = frameAt(v.trace, playPosition() - rp.start);
  const comps = pr.resolved_components || [];
  const labels = pr.component_labels || [];
  const compOf = pr.resolved_component_of || [];
  const rows = [];

  // Per component, so a field of several can be read one at a time.
  comps.forEach((c, ci) => {
    const idx = compOf.map((g, i) => g === ci ? i : -1).filter(i => i >= 0);
    const az = fr ? idx.map(i => fmt(fr.az[i], 0)).join(" ") : "";
    const dist = fr?.dist ? idx.map(i => fmt(fr.dist[i], 1)).join(" ") : "";
    const lvl = fr?.lvl ? idx.map(i => fmt(fr.lvl[i], 2)).join(" ") : "";
    const motion = c.kind === "stream"
      ? `${fmt(c.speed_mps, 1)} m/s heading ${fmt(c.heading_deg, 0)}°`
      : c.kind === "radial" ? `${fmt(c.radial_speed_mps, 1)} m/s radial`
      : c.kind === "spiral" ? `${fmt(c.rotation_deg_per_sec, 0)}°/s, ${fmt(c.radial_speed_mps, 1)} m/s`
      : (c.rotation_deg_per_sec ? `${fmt(c.rotation_deg_per_sec, 0)}°/s` : "stationary");
    const cd = c.decorr || d;
    rows.push([`<b>${esc(labels[ci] || c.kind)}</b>`,
      `${c.kind} · ${c.n_sources} src · ${motion}`]);
    if (az) rows.push(["  azimuths", az]);
    if (dist) rows.push(["  distances", dist]);
    if (lvl && c.kind !== "ring") rows.push(["  levels", lvl]);
    if (c.random_fraction > 0)
      rows.push(["  random share", `${Math.round(c.random_fraction * 100)}%`]);
    rows.push(["  decorrelation",
      `${cd.family} ${fmt(cd.amount, 2)} · ${fmt(cd.ir_ms, 0)}ms${c.decorr ? "" : " (inherited)"}`]);
  });

  rows.push(
    ["amounts now", fr ? fr.amt.map(a => fmt(a, 2)).join(" ") : fmt(d.amount, 2)],
    ["bands", d.crossovers ? `${d.crossovers.join("/")} Hz × ${(d.band_amounts || []).join(", ")}` : "full band"],
    ["hotspot", hs?.enabled
      ? `${fmt(hs.deg_per_sec, 0)} °/s, ${fmt(hs.width_deg, 0)}° wide` : "off"],
    ["head radius", `${fmt(pr.head_radius * 100, 1)} cm`],
    ["seed", pr.seed],
  );
  host.innerHTML = "<table>" +
    rows.map(([k, val]) => `<tr><td>${k}</td><td>${esc(String(val))}</td></tr>`).join("")
    + "</table>";
}

function tick() {
  drawRing();
  if (S.rendered) {
    const t = playPosition();
    $("#clock").textContent = `${mmss(t)} / ${mmss(S.duration)}`;
    if (!$("#seek").matches(":active")) $("#seek").value = t / (S.duration || 1);
    drawWave();
    updateNow();
  }
  requestAnimationFrame(tick);
}

// ====================================================================
// Metrics
// ====================================================================

function showMetrics() {
  const host = $("#metrics");
  const rp = S.rendered?.passages[S.active];
  if (!rp) { host.innerHTML = '<p class="note">Render to see measurements.</p>'; return; }
  const vi = S.live && S.live.pi === S.active ? S.live.vi : (rp.variants[1] ? 1 : 0);
  const v = rp.variants[vi];
  const m = v?.metrics;
  if (!m) { host.innerHTML = '<p class="note">No measurement for this variant.</p>'; return; }

  const row = (ref, label, val, extra = "") =>
    `<div class="mrow"><span class="mlab">${label}<button class="i" data-ref="${ref}">i</button></span>
      <span class="mval">${val}</span>${extra}</div>`;

  let html = `<p class="note" style="margin:0 0 10px">${esc(v.label)}</p>`;
  html += row("iacc", "IACC", fmt(m.iacc, 3),
    `<span class="bar"><i style="width:${clamp(m.iacc, 0, 1) * 100}%"></i></span>`);
  html += row("noise-floor", "spread", "±" + fmt(m.iacc_sd, 3));
  html += row("lufs", "loudness", fmt(m.lufs, 1) + " LUFS");

  if (v.coherence) {
    const c = v.coherence;
    html += row("coherence-matrix", "coherence", fmt(c.mean_offdiagonal, 3),
      c.mean_offdiagonal_range
        ? `<span class="dim">varies ${fmt(c.mean_offdiagonal_range[0], 2)}–${fmt(c.mean_offdiagonal_range[1], 2)}</span>`
        : "");
    html += '<table class="cmat">' + c.matrix.map(r => "<tr>" + r.map(x => {
      const t = Math.abs(x);
      return `<td style="background:rgba(44,95,124,${(t * .8).toFixed(2)});color:${t > .55 ? "#fff" : "#7c766c"}">${x.toFixed(1)}</td>`;
    }).join("") + "</tr>").join("") + "</table>";
  }

  if (v.paired_modulation) {
    const pm = v.paired_modulation;
    const real = pm.delta > 0.5;
    html += row("rotation-signature", "rotation",
      `${pm.delta > 0 ? "+" : ""}${fmt(pm.delta, 2)}`,
      `<span class="dim">at ${fmt(pm.freq_hz, 2)} Hz</span>`);
    html += `<div class="finding">${fmt(pm.rotating_ratio, 2)} moving against
      ${fmt(pm.control_ratio, 2)} for its matched control.
      ${real ? "" : "Not separable from the control, so no measurable rotation signature. That is not the same as inaudible."}</div>`;
  } else if (v.control_missing) {
    html += row("matched-control", "rotation", "–",
      '<span class="dim">no matched control</span>');
    html += `<div class="finding">Add a variant identical to this one with every
      rate set to zero, and the paired measure appears here. A single render's
      modulation is confounded with the music's own periodicity.</div>`;
  } else if (v.no_rotation_rate) {
    html += row("rotation-signature", "rotation", "–",
      '<span class="dim">no rotation rate</span>');
    html += `<div class="finding">This variant moves, but translation and radial
      flow recycle rather than repeating at a fixed rate, so there is no single
      frequency for the paired measure to examine. Judge these by listening,
      against a frozen control.</div>`;
  }

  if (v.component_coherence) {
    html += `<div class="mrow" style="margin-top:10px"><span class="mlab">per component<button class="i" data-ref="component">i</button></span></div>`;
    html += `<table class="compare"><tr><th>component</th><th></th>
      <th style="text-align:right">coherence</th></tr>` +
      v.component_coherence.map(c => `<tr><td>${esc(c.label)}</td>
        <td class="dim">${esc(c.kind)}, ${c.n} src</td>
        <td class="n">${fmt(c.mean_offdiagonal, 3)}</td></tr>`).join("") + `</table>`;
  }

  if (m.iacc_bands) {
    html += `<div class="mrow" style="margin-top:10px"><span class="mlab">by band<button class="i" data-ref="octave-bands">i</button></span></div>`;
    html += m.iacc_bands.map(b =>
      `<div class="bandrow"><span class="bl">${b.centre >= 1000 ? (b.centre / 1000).toFixed(1) + "k" : b.centre}</span>
        <span class="bar"><i style="width:${clamp(b.iacc, 0, 1) * 100}%"></i></span>
        <span class="num">${fmt(b.iacc, 2)}</span></div>`).join("");
  }

  if (m.iacc_series?.length) {
    html += `<div class="mrow" style="margin-top:10px"><span class="mlab">over time<button class="i" data-ref="iacc-over-time">i</button></span></div>
      <canvas class="spark" id="spark"></canvas>`;
  }

  html += `<div class="compare"><table>
    <tr><th></th><th>variant</th><th style="text-align:right">IACC</th>
    <th style="text-align:right">LUFS</th><th style="text-align:right">rot</th></tr>` +
    rp.variants.map((x, i) => `<tr class="${i === vi ? "sel" : ""}">
      <td class="n">${i === 0 ? "–" : i}</td><td>${esc(x.label)}</td>
      <td class="n">${fmt(x.metrics?.iacc, 3)}</td>
      <td class="n">${fmt(x.metrics?.lufs, 1)}</td>
      <td class="n">${x.paired_modulation ? (x.paired_modulation.delta > 0 ? "+" : "") + fmt(x.paired_modulation.delta, 2) : "–"}</td>
    </tr>`).join("") + `</table></div>`;

  host.innerHTML = html;
  if (m.iacc_series?.length) drawSpark(m.iacc_series);
}

function drawSpark(series) {
  const c = $("#spark");
  if (!c) return;
  c.width = c.clientWidth || 260; c.height = 44;
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  x.strokeStyle = "#e9e5dd";
  [0, .5, 1].forEach(v => {
    const y = c.height - v * c.height;
    x.beginPath(); x.moveTo(0, y); x.lineTo(c.width, y); x.stroke();
  });
  x.strokeStyle = "#2c5f7c"; x.lineWidth = 1.3; x.beginPath();
  series.forEach((v, i) => {
    const xx = (i / Math.max(series.length - 1, 1)) * c.width;
    const yy = c.height - clamp(v, 0, 1) * c.height;
    i ? x.lineTo(xx, yy) : x.moveTo(xx, yy);
  });
  x.stroke();
}

// ====================================================================
// Arrangement
// ====================================================================

async function renderArrangement() {
  const mode = $("#amode").value;
  const segs = [];
  const sorted = [...S.passages].sort((a, b) => a.start - b.start);
  for (const p of sorted) {
    const v = p.variants[p.selected] || p.variants[0];
    segs.push({ start: p.start, end: p.end, config: v.config, fade: 0.25, label: `${p.name}: ${v.name}` });
  }
  if (!segs.length) return;

  const body = {
    track: S.track, mode, match: $("#match").value,
    dry_mono: $("#drymono").checked, with_trace: false, with_metrics: true,
  };
  if (mode === "timeline") body.segments = segs;
  else if (mode === "blocks") body.blocks = sorted.map((p, i) => ({
    label: p.name,
    segments: p.variants.map(v => ({
      start: p.start, end: p.end, config: v.config, fade: 0.25, label: v.name
    }))
  }));
  else body.takes = sorted.flatMap(p => p.variants.map(v => ({
    src_start: p.start, src_end: p.end, config: v.config, label: `${p.name}: ${v.name}`
  })));

  const st = $("#aexportstate");
  st.className = "msg"; st.textContent = "Rendering…";
  const abtn = $("#arender");
  abtn.classList.add("busy");
  try {
    const res = await post("/api/render", body);
    S.arr = res;
    $("#aplayer").src = res.url;
    st.textContent = `Rendered in ${res.render_seconds}s.`;
    $("#atimeline").innerHTML = res.timeline.map((e, i) => `
      <div class="trow" data-i="${i}">
        <span class="tt">${fmt(e.out_start, 1)}–${fmt(e.out_end, 1)}s</span>
        <span>${esc(e.group ? `[${e.group}] ` : "")}${esc(e.label)}</span>
        <span class="grow"></span>
        <span class="num dim">${fmt(res.segment_metrics?.[i]?.iacc, 3)}</span>
      </div>`).join("");
  } catch (e) {
    st.className = "msg err"; st.textContent = "Failed: " + e.message;
  } finally {
    abtn.classList.remove("busy");
  }
}

function wireArrangement() {
  $("#arender").addEventListener("click", renderArrangement);
  $("#aexport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ passages: S.passages }, null, 2)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ringfield-passages.json"; a.click();
  });
  $("#aimport").addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json";
    inp.addEventListener("change", async () => {
      const data = JSON.parse(await inp.files[0].text());
      if (Array.isArray(data.passages)) S.passages = data.passages;
      renderPassages(); drawWave(); markStale();
    });
    inp.click();
  });
  $("#doexport").addEventListener("click", async () => {
    if (!S.arr) return;
    const st = $("#aexportstate");
    st.textContent = "Exporting…";
    const res = await post("/api/export", {
      id: S.arr.id, name: $("#exname").value, timeline: S.arr.timeline
    });
    st.textContent = "Wrote " + res.wrote.filter(Boolean).join(", ");
  });
  $("#aplayer").addEventListener("timeupdate", () => {
    if (!S.arr) return;
    const t = $("#aplayer").currentTime;
    S.arr.timeline.forEach((e, i) => {
      $(`.trow[data-i="${i}"]`)?.classList.toggle("now", t >= e.out_start && t < e.out_end);
    });
  });
}

// ====================================================================
// Blind test
// ====================================================================

/* Response items.
 *
 * Localization and centredness are separated: a mono signal sits at a single
 * position, the centre of the head, so "can you point at anything" alone would
 * be answered yes for the untreated reference and the question would not
 * discriminate. Graded qualities use 0-6 scales. The motion-kind item appears
 * only after a nonzero motion rating. A rotation-direction item is deliberately
 * absent: the head model is front-back symmetric, so direction is not
 * recoverable from the cues it produces, and asking would collect noise.
 */
const QUESTIONS = [
  { id: "focus", type: "scale", text: "How spatially focused is the sound?",
    lo: "one compact source", hi: "no direction at all", ref: "apparent-source-width" },
  { id: "individual", type: "opts", ref: "localization",
    text: "Leaving aside the sound as a whole, can you point to any individual source inside it?",
    opts: ["yes, clearly", "yes, vaguely", "no"] },
  { id: "center", type: "opts", ref: "lateralization",
    text: "Does the sound sit at the centre of your head?",
    opts: ["yes", "partly", "no"] },
  { id: "motion", type: "scale", text: "How much does it move?",
    lo: "static", hi: "clearly moving", ref: "auditory-motion" },
  { id: "motion_kind", type: "opts", ref: "auditory-motion",
    text: "What kind of movement?", when: r => Number(r.motion) > 0,
    opts: ["circling", "side to side", "nearer and farther", "irregular", "cannot say"] },
  { id: "envelopment", type: "scale", text: "How surrounded are you?",
    lo: "it is in front of me", hi: "it is all around me", ref: "envelopment" },
  { id: "notes", type: "text", text: "Notes", optional: true },
];

function questionHtml(q) {
  let controls;
  if (q.type === "scale") {
    controls = `<div class="scale7"><span class="endlab">${esc(q.lo)}</span>` +
      Array.from({ length: 7 }, (_, k) => `<button data-v="${k}">${k}</button>`).join("") +
      `<span class="endlab">${esc(q.hi)}</span></div>`;
  } else if (q.type === "text") {
    controls = `<textarea class="tnotes" data-notes placeholder="Anything worth recording about this one."></textarea>`;
  } else {
    controls = `<div class="opts">` +
      q.opts.map(o => `<button data-v="${esc(o)}">${esc(o)}</button>`).join("") + `</div>`;
  }
  return `<div class="qbox" data-q="${q.id}">
    <div class="qtext">${esc(q.text)}${q.ref ? ` <button class="i" data-ref="${q.ref}">i</button>` : ""}</div>
    ${controls}</div>`;
}

function refreshTrialState() {
  const b = S.blind;
  if (!b) return;
  for (const q of QUESTIONS) {
    if (!q.when) continue;
    const box = $(`.qbox[data-q="${q.id}"]`);
    const on = q.when(b.responses);
    box?.classList.toggle("off", !on);
    if (!on) delete b.responses[q.id];
  }
  const ready = QUESTIONS.every(q =>
    q.optional || (q.when && !q.when(b.responses)) || (q.id in b.responses));
  $("#bnext").disabled = !ready;
}

function startBlind() {
  const rp = S.rendered?.passages[S.active];
  if (!rp || rp.variants.length < 2) {
    $("#btrial").innerHTML = '<p class="note">Render a passage with at least two variants first.</p>';
    return;
  }
  const reps = Number($("#brepeats").value) || 3;
  const pool = rp.variants.map((v, i) => ({ vi: i, label: v.label, kind: v.kind }))
    .filter(c => $("#bincludedry").checked || c.vi !== 0);
  const order = [];
  for (let r = 0; r < reps; r++) {
    const round = [...pool];
    for (let k = round.length - 1; k > 0; k--) {         // Fisher-Yates
      const j = Math.floor(Math.random() * (k + 1));
      [round[k], round[j]] = [round[j], round[k]];
    }
    order.push(...round);
  }
  S.blind = { order, idx: 0, session: $("#bsession").value || "s1", responses: {}, t0: 0 };
  nextTrial();
}

function nextTrial() {
  const b = S.blind;
  if (!b) return;
  if (b.idx >= b.order.length) {
    applyVariant(S.active, 0, 0); stopPlayback();
    $("#btrial").innerHTML = `<p>Done. ${b.order.length} trials written to
      <code>sessions/${esc(b.session)}.jsonl</code>.</p>`;
    $("#bcsv").href = `/api/session/${b.session}.csv`;
    S.blind = null;
    return;
  }
  const cond = b.order[b.idx];
  b.responses = {}; b.t0 = performance.now();

  // The label is never shown. Playback restarts at the top of the passage so
  // every trial hears identical material.
  $("#loop").checked = true;
  startPlayback(passage().start);
  applyVariant(S.active, cond.vi, 0);

  $("#bprogress").textContent = `Trial ${b.idx + 1} of ${b.order.length}`;
  $("#btrial").innerHTML = `<p class="dim">Condition hidden.</p>` +
    QUESTIONS.map(questionHtml).join("") +
    `<div class="row"><button id="breplay">Replay</button>
      <button id="bnext" class="primary" disabled>Next trial</button></div>`;

  $$(".qbox", $("#btrial")).forEach(qb => {
    $$("[data-v]", qb).forEach(btn => btn.addEventListener("click", () => {
      $$("[data-v]", qb).forEach(o => o.classList.remove("on"));
      btn.classList.add("on");
      S.blind.responses[qb.dataset.q] = btn.dataset.v;
      refreshTrialState();
    }));
  });
  refreshTrialState();
  $("#breplay").addEventListener("click", () => startPlayback(passage().start));
  $("#bnext").addEventListener("click", submitTrial);
}

async function submitTrial() {
  const b = S.blind;
  const cond = b.order[b.idx];
  const v = S.rendered.passages[S.active].variants[cond.vi];
  const notes = $("#btrial [data-notes]")?.value.trim();
  if (notes) b.responses.notes = notes;
  await post("/api/trial", {
    session: b.session, trial: b.idx, condition: v.label, params: v.params,
    responses: b.responses, blind: true,
    seconds: (performance.now() - b.t0) / 1000, presentation_index: cond.vi,
  });
  b.idx++;
  nextTrial();
}

function wireBlind() {
  $("#bstart").addEventListener("click", startBlind);
  $("#bstop").addEventListener("click", () => {
    S.blind = null; stopPlayback();
    $("#btrial").innerHTML = '<p class="note">Stopped. Completed trials are already on disk.</p>';
  });
  $("#bsession").addEventListener("change", e => {
    $("#bcsv").href = `/api/session/${e.target.value}.csv`;
  });
}

// ====================================================================
// Guided tours
// ====================================================================

const showTab = name => $(`.tab[data-tab="${name}"]`)?.click();

const TOURS = [
  {
    id: "welcome", title: "Overview",
    sub: "The pages and what each is for. Two minutes, nothing to do.",
    steps: welcomeTour,
  },
  {
    id: "build", title: "Build and listen",
    sub: "Hands on: mark a passage, set up variants, render, compare.",
    steps: buildTour,
  },
  {
    id: "arrange", title: "Arrangements",
    sub: "Rendering a finished sequence to a file.",
    steps: arrangeTour,
  },
  {
    id: "blindtour", title: "Blind testing",
    sub: "Collecting responses that can serve as evidence.",
    steps: blindTour,
  },
];

function welcomeTour() {
  return [
    {
      title: "Overview",
      body: `This instrument renders a piece of audio as a field of virtual
        sound sources around the listener, for testing whether a field can be
        heard rotating when nothing in it can be singled out.
        <br><br>This tour points at the main areas. The hands-on tour, under the
        same menu, walks through actually using them.`,
      before: () => { closeSheet(); showTab("bench"); },
    },
    {
      el: ".wavecard",
      title: "Track and passages",
      body: `Audio is chosen or uploaded here. Dragging on the waveform selects
        a region, which becomes a passage: the unit everything else works on.`,
    },
    {
      el: "#passages",
      title: "Variants",
      body: `Each passage holds variants: the untreated original plus any number
        of treatments. Rendering makes them playable; number keys switch between
        them during playback.`,
    },
    {
      el: "#ring",
      title: "Monitor",
      body: `A view of the field from above, drawn from the render itself:
        source positions, distances, and coherence, updated as the audio plays.`,
    },
    {
      el: "#metrics",
      title: "Measurement",
      body: `Objective measures for the variant being heard, with a comparison
        table across the passage's variants.`,
    },
    {
      el: '.tab[data-tab="arrange"]',
      title: "Arrangement",
      body: `Renders the passages and their chosen variants into a single file,
        with a timeline and subtitle track.`,
    },
    {
      el: '.tab[data-tab="blind"]',
      title: "Blind test",
      body: `Presents a passage's variants in random order with labels hidden
        and writes responses to disk. This page is what turns listening into
        data.`,
    },
    {
      el: '.tab[data-tab="courses"]',
      title: "Courses",
      body: `Six courses in order, from how two ears produce a sense of
        direction through to running a listening test that counts as evidence.`,
      before: () => showTab("courses"),
    },
    {
      el: '.tab[data-tab="purpose"]',
      title: "Purpose",
      body: `The research programme: the question, where it sits in the
        literature, what has been measured here, and how it is tested.`,
      before: () => showTab("purpose"),
    },
    {
      el: "#openlearn",
      title: "Glossary",
      body: `Two glossaries. One holds this instrument's own vocabulary, the
        other established audio and hearing terms with references. Terms
        throughout the interface link into them through the small i buttons.`,
      before: () => showTab("bench"),
    },
  ];
}

function buildTour() {
  const demo = "wll.mp3";
  let saved = {};
  return [
    {
      title: "Build and listen",
      body: `This tour is hands on: some steps wait until you have done the
        action before continuing. <kbd>&larr;</kbd> and <kbd>&rarr;</kbd> move
        between steps, End tour stops.`,
      before: () => { closeSheet(); showTab("bench"); },
    },
    {
      el: "#track", interact: true,
      title: "Choose the track",
      body: `Any file in the list works. Sustained material suits this far
        better than percussive material.`,
      before: () => { saved.track = S.track; },
      until: () => !!S.track,
      hint: `Pick a track in the menu. ${demo} is a reasonable default.`,
    },
    {
      el: "#wave", interact: true,
      title: "Select a region",
      body: `Drag across the waveform. Fifteen to thirty seconds is a workable
        length. A single click seeks instead of selecting.`,
      before: () => { saved.sel = [...S.sel]; saved.selAt = S.sel.join(","); },
      until: () => S.sel.join(",") !== saved.selAt && (S.sel[1] - S.sel[0]) >= 4,
      hint: "Drag a region of at least a few seconds on the waveform.",
      revert: () => { if (saved.sel) { S.sel = [...saved.sel]; syncSel(); drawWave(); } },
    },
    {
      el: "#addpassage", interact: true,
      title: "Make it a passage",
      body: `The selection becomes a passage with three starting variants: the
        untreated signal, a rotating ring, and the same ring held still.`,
      before: () => { saved.nPassages = S.passages.length; },
      until: () => S.passages.length > saved.nPassages,
      hint: "Press Add passage from selection.",
      revert: () => {
        if (S.passages.length > saved.nPassages) {
          S.passages.pop();
          S.active = clamp(S.active, 0, S.passages.length - 1);
          renderPassages(); drawWave();
        }
      },
    },
    {
      el: () => $(".variant button[title='show parameters']"),
      interact: true,
      title: "Open a variant",
      body: `Every parameter of a treatment is editable. The small i beside each
        control explains the term it uses.`,
      until: () => S.passages.some(p => p.variants.some(v => v.open && v.config)),
      hint: "Press edit on one of the treated variants.",
    },
    {
      el: () => $(".ringmod"),
      title: "Rings",
      body: `A treatment is built from rings: each has its own source count,
        rotation rate, distance from the head, and an optional share of sources
        that wander instead of rotating. Rings can be duplicated, copied, and
        pasted between variants, so two variants can share a component exactly.
        <br><br>Distance is carried by level and by the growth of the
        interaural level difference at close range; there is no reverberation,
        so it is a thin cue on its own.`,
    },
    {
      el: () => $(".pashead select"),
      title: "Variant presets",
      body: `The menu adds common configurations: partial coherence, the
        degenerate coherent ring, partly random motion, two rings at different
        distances, and the circulating hotspot with its control.`,
    },
    {
      el: "#render", interact: true,
      title: "Render",
      body: `Variants are rendered over the same span, aligned and matched in
        loudness. The button shows progress; a passage of this length takes
        several seconds per variant.`,
      until: () => !!S.rendered && !!S.dryBuffer,
      hint: "Press Render and wait for it to finish.",
    },
    {
      el: "#passages", interact: true,
      title: "Compare while it plays",
      body: `Hold <kbd>1</kbd> to hear the first treatment and release to
        return to the untreated signal. Held numbers switch instantly, mid-note,
        which is a far more sensitive comparison than listening in sequence.`,
      before: () => { if (S.rendered && !S.playing) startPlayback(passage()?.start ?? 0); },
      until: () => !!S.live,
      hint: "Hold a number key while the passage plays.",
    },
    {
      el: "#ring",
      title: "Watch the field",
      body: `Sources drag trails; the outline connecting a ring turns rigidly
        when its sources rotate together and deforms when some wander. Filled
        dots are coherent, hollow ones decorrelated.`,
    },
    {
      el: "#metrics",
      title: "Read the measurements carefully",
      body: `The rotation figure is only meaningful as a difference against a
        matched static control, and the panel says when one is missing. It also
        reports nothing for translation and radial flow, which recycle rather
        than repeating at a fixed rate. The Courses cover why.`,
    },
    {
      title: "Where to go from here",
      body: `The Arrangement page renders passages to a file. The Blind test
        page presents variants unlabeled and records responses. Both have short
        tours under the same help menu.`,
    },
  ];
}

function arrangeTour() {
  return [
    {
      el: '.tab[data-tab="arrange"]',
      title: "Arrangements",
      body: `Each passage contributes its selected variant, rendered into one
        file on the track's own timeline.`,
      before: () => showTab("arrange"),
    },
    {
      el: "#amode",
      title: "Three layouts",
      body: `One arrangement across the track; whole arrangements back to back;
        or one passage repeated under each of its treatments.`,
    },
    {
      el: "#arender",
      title: "Render and export",
      body: `The result plays here, with per-segment measurements. Export
        writes the audio together with a timeline JSON and an SRT subtitle
        track, so a player shows what is active at each moment.`,
    },
    {
      el: "#aexport",
      title: "Portable definitions",
      body: `Passages and variants can be exported and imported as JSON, and
        saved on the server as named experiments from the Bench.`,
      before: () => showTab("arrange"),
    },
  ];
}

function blindTour() {
  return [
    {
      el: '.tab[data-tab="blind"]',
      title: "Blind testing",
      body: `Listening while knowing which condition is playing is exploration,
        not evidence. This page hides the condition, shuffles the order, and
        records responses as they are made.`,
      before: () => showTab("blind"),
    },
    {
      el: "#bsession",
      title: "Sessions",
      body: `Responses append to a session file on disk, one line per trial,
        with the full parameter set attached. A crashed or abandoned run keeps
        everything already answered.`,
    },
    {
      el: "#bincludedry",
      title: "Catch trials",
      body: `Including the untreated signal calibrates the rest: reporting
        motion on it measures how much of the other reports is expectation.`,
    },
    {
      el: "#btrial",
      title: "The questions",
      body: `Graded qualities use 0 to 6 scales. Localization of individual
        sources is asked separately from whether the sound sits at the centre
        of the head, since a mono signal is centred yet has a pointable
        position. The movement-type item appears only after a nonzero movement
        rating, and rotation direction is not asked at all: the current head
        model cannot distinguish front from back, so direction is not
        recoverable.`,
    },
    {
      el: "#bcsv",
      title: "Export",
      body: `Each session flattens to CSV, one row per trial, responses and
        parameters in columns.`,
    },
  ];
}

function wireHelpMenu() {
  const menu = document.createElement("div");
  menu.className = "helpmenu";
  menu.innerHTML = TOURS.map(t => `<button data-tour="${t.id}">
    <div class="hm-title">${esc(t.title)}</div>
    <div class="hm-sub">${esc(t.sub)}</div></button>`).join("");
  document.body.appendChild(menu);

  const btn = $("#starttour");
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const r = btn.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.top = (r.bottom + 6) + "px";
    menu.classList.toggle("on");
  });
  menu.addEventListener("click", e => {
    const t = e.target.closest("[data-tour]");
    if (!t) return;
    menu.classList.remove("on");
    const tour = TOURS.find(x => x.id === t.dataset.tour);
    if (tour) Tour.start(tour.steps());
  });
  addEventListener("click", e => {
    if (!e.target.closest(".helpmenu, #starttour")) menu.classList.remove("on");
  });
}

// ====================================================================
// Experiments: a track, its passages, and their variants, saved by name
// ====================================================================

function wireExperiments() {
  const bar = $("#expbar");
  if (!bar) return;

  async function refresh() {
    const sel = $("#exppick");
    try {
      const { presets } = await api("/api/presets");
      const exps = presets.filter(p => p.kind === "experiment");
      sel.innerHTML = `<option value="">Load experiment…</option>` +
        exps.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
      sel.disabled = !exps.length;
    } catch (_) { sel.disabled = true; }
  }

  $("#expsave").addEventListener("click", async () => {
    const name = prompt("Save this experiment as:",
      $("#exppick").value || "experiment 1");
    if (!name) return;
    await post("/api/presets", {
      kind: "experiment", name,
      data: { track: S.track, passages: S.passages }
    });
    refresh();
  });

  $("#exppick").addEventListener("change", async e => {
    const name = e.target.value;
    if (!name) return;
    await applyExperiment(name);
  });

  refresh();
}

async function applyExperiment(name) {
  const { presets } = await api("/api/presets");
  const exp = presets.find(p => p.kind === "experiment" && p.name === name);
  if (!exp) throw new Error(`no experiment named ${name}`);
  if (exp.data.track && exp.data.track !== S.track) {
    await loadTracks(exp.data.track);
    await loadTrack(exp.data.track);
  }
  S.passages = exp.data.passages || [];
  S.active = 0;
  renderPassages(); drawWave(); markStale();
  return exp;
}

// ====================================================================
// Feedback
// ====================================================================

function wireFeedback() {
  const send = $("#fsend");
  if (!send) return;
  send.addEventListener("click", async () => {
    const st = $("#fstate");
    const body = $("#fbody").value.trim();
    if (!body) { st.className = "msg err"; st.textContent = "Write something first."; return; }
    st.className = "msg"; st.textContent = "Sending…";
    send.disabled = true;
    try {
      const res = await post("/api/feedback", {
        kind: $("#fkind").value, area: $("#farea").value,
        title: $("#ftitle").value.trim(), body,
        contact: $("#fcontact").value.trim(),
      });
      st.textContent = res.issue
        ? `Filed: ${res.issue}`
        : "Saved locally; it will not reach GitHub until the gh command line tool is signed in.";
      $("#fbody").value = ""; $("#ftitle").value = "";
    } catch (e) {
      st.className = "msg err"; st.textContent = "Failed: " + e.message;
    } finally {
      send.disabled = false;
    }
  });
}

// ====================================================================
// Participant mode: a URL that presents only the blind test
// ====================================================================

async function enterParticipantMode(qp) {
  document.body.classList.add("testmode");
  showTab("blind");
  const exp = qp.get("experiment");
  const session = qp.get("session");
  if (session) {
    $("#bsession").value = session;
    $("#bcsv").href = `/api/session/${session}.csv`;
  }
  const note = document.createElement("p");
  note.className = "note";
  $("#blind .card").prepend(note);
  try {
    if (exp) {
      note.textContent = "Preparing the listening test…";
      await applyExperiment(exp);
      await doRender();
      stopPlayback();
      note.textContent = "Ready. Press Start, listen, and answer each item. " +
        "There are no right answers; report what you hear.";
    } else {
      note.textContent = "No experiment named in the link. " +
        "Ask for a link of the form /?mode=test&experiment=NAME.";
    }
  } catch (e) {
    note.className = "msg err";
    note.textContent = "Could not prepare the test: " + e.message;
  }
}

// ====================================================================
// Track loading and upload
// ====================================================================

async function loadTracks(select) {
  const { tracks } = await api("/api/tracks");
  const sel = $("#track");
  sel.innerHTML = tracks.map(t =>
    `<option value="${esc(t.name)}"${t.name === select ? " selected" : ""}>${esc(t.name)}${t.generated ? " (rendered output)" : ""}</option>`).join("");
  return tracks;
}

async function loadTrack(name) {
  S.track = name;
  const info = await api(`/api/track/${encodeURIComponent(name)}`);
  S.duration = info.duration; S.peaks = info.peaks;
  $("#trackinfo").textContent = `${mmss(info.duration)} at ${info.fs} Hz`;
  S.sel = [clamp(S.sel[0], 0, S.duration), clamp(S.sel[1], 0, S.duration)];
  if (S.sel[1] - S.sel[0] < 1) S.sel = [0, Math.min(20, S.duration)];
  S.rendered = null; S.dryBuffer = null; S.buffers = {}; S.live = null;
  stopPlayback();
  syncSel(); drawWave(); showMetrics(); markStale();
}

function wireUpload() {
  const drop = $("#drop"), file = $("#file");
  drop.addEventListener("click", () => file.click());
  file.addEventListener("change", () => file.files[0] && upload(file.files[0]));
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove("over");
  }));
  drop.addEventListener("drop", e => {
    const f = e.dataTransfer?.files?.[0];
    if (f) upload(f);
  });
}

async function upload(f) {
  const drop = $("#drop");
  const original = drop.textContent;
  drop.textContent = `Uploading ${f.name}…`;
  try {
    const fd = new FormData();
    fd.append("file", f);
    const res = await api("/api/upload", { method: "POST", body: fd });
    await loadTracks(res.name);
    await loadTrack(res.name);
    drop.textContent = original;
  } catch (e) {
    drop.textContent = "Upload failed: " + e.message;
  }
}

// ====================================================================
// Boot
// ====================================================================

async function boot() {
  try { REF = await api("/api/encyclopedia"); } catch (_) { }
  try { PURPOSE = await api("/api/purpose"); } catch (_) { }
  try { COURSES = await api("/api/courses"); } catch (_) { }
  renderCoursesPage();
  renderPurposePage();
  wireSheet();
  wireHelpMenu();
  wireExperiments();
  wireFeedback();

  const tracks = await loadTracks();
  $("#track").addEventListener("change", e => loadTrack(e.target.value));

  wireWave(); wireTransport(); wireArrangement(); wireBlind(); wireUpload();

  $("#pstart").addEventListener("change", e => { S.sel[0] = Number(e.target.value); drawWave(); });
  $("#pend").addEventListener("change", e => { S.sel[1] = Number(e.target.value); drawWave(); });
  $("#addpassage").addEventListener("click", () => {
    S.passages.push(newPassage(S.sel[0], S.sel[1]));
    S.active = S.passages.length - 1;
    renderPassages(); drawWave(); markStale();
  });
  $("#newpassage").addEventListener("click", () => $("#addpassage").click());
  $("#render").addEventListener("click", doRender);

  $$(".tab").forEach(t => t.addEventListener("click", () => {
    $$(".tab").forEach(o => o.classList.toggle("on", o === t));
    $$(".page").forEach(p => p.classList.toggle("on", p.id === t.dataset.tab));
  }));

  if (tracks.length) {
    await loadTrack(tracks[0].name);
    const a = Math.min(84, Math.max(0, S.duration - 20));
    S.sel = [a, Math.min(a + 20, S.duration)];
    S.passages = [newPassage(S.sel[0], S.sel[1], "Passage 1")];
    syncSel(); renderPassages(); drawWave();
  }

  const qp = new URLSearchParams(location.search);
  if (qp.get("mode") === "test") enterParticipantMode(qp);

  requestAnimationFrame(tick);
}

boot();
