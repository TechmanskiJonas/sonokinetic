/* Sonokinetic bench.
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
/** The disclosure triangle, drawn rather than typed.
 *
 * The ▸ character is unusable at this size for two reasons. It renders at
 * whatever fraction of the em box the font chooses, which is small and not
 * adjustable, and fonts give it uneven side bearings, so it sits off centre
 * inside its own box and reads as lopsided.
 *
 * Drawing it fixes both. The triangle below is centred on its bounding box
 * rather than on its centroid, which is what the eye reads as centred and
 * what keeps the 90° rotation between the two states from shifting the mark.
 *
 * Size and proportion are deliberate. A near-equilateral triangle at this
 * scale reads as a play button, so it is 6 wide by 7.6 tall before the stroke,
 * taller than it is wide, and small within its box: the box is the click
 * target and does not need to be filled.
 */
const TRI_RIGHT = "M5 4.2 L11 8 L5 11.8 Z";
const chevron = (open, size = 14) =>
  `<svg class="chev${open ? " open" : ""}" width="${size}" height="${size}"
     viewBox="0 0 16 16" aria-hidden="true"><path d="${TRI_RIGHT}"
     fill="currentColor" stroke="currentColor" stroke-width="0.9"
     stroke-linejoin="round"/></svg>`;

const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
/** Minutes, seconds and milliseconds, for setting passage edges precisely. */
const mmssms = t => `${mmss(t)}.${String(Math.floor((t % 1) * 1000)).padStart(3, "0")}`;
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

/** Titles that keep their capital wherever they appear: an acronym, or a name.
 *  Everything else is an ordinary noun phrase that should read as one. */
const KEEP_CAPITAL = /^[A-Z]{2,}|^(Brown|Woodworth|Hann|K-)/;

/** Where a link sits in the sentence, which decides how its name is written.
 *
 *  An unlabelled [[link]] prints the entry's title, and titles are capitalised.
 *  Dropped mid-sentence that produces "one Waveform has to slide", which reads
 *  as a proper noun and makes the prose look machine-assembled. */
const startsSentence = (str, at) => {
  const before = str.slice(0, at).replace(/\s+$/, "");
  return before === "" || /[.?!:]$|\*\*$|<br>$|<\/p>$/.test(before);
};
const lowerFirst = s => (KEEP_CAPITAL.test(s) ? s : s[0].toLowerCase() + s.slice(1));

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
    .replace(/\[\[([a-z0-9-]+)\]\]/g, (m, id, at, str) => {
      const name = REF.entries[id]?.title || pi[id]?.section.heading || id;
      return anchor(id, startsSentence(str, at) ? name : lowerFirst(name));
    })
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
        <span class="tw">${chevron(open, 11)}</span>${esc(s.title)}
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

const LATTICES = {
  polar: { label: "Polar", hint: "concentric rings of sources" },
  cartesian: { label: "Grid", hint: "a rectangular grid of sources" },
};

const isPolar = c => c.lattice !== "cartesian";
const isGrid = c => c.lattice === "cartesian";
const wanders = c => c.random_fraction > 0 || c.radial_wander_m > 0;

/** Starting points, not finished variants. Each sets a few numbers on one
 *  lattice; everything remains editable afterwards. */
const COMPONENT_PRESETS = {
  polar: [
    { label: "Ring", set: { rings: 1, per_ring: 6, r_near_m: 2, r_far_m: 2 } },
    { label: "Turning ring", set: { rings: 1, per_ring: 6, r_near_m: 2, r_far_m: 2, rotation_deg_per_sec: 60 } },
    { label: "Concentric rings", set: { rings: 3, per_ring: 6, r_near_m: 1, r_far_m: 5, ring_stagger_deg: 20 } },
    { label: "Closing in", set: { rings: 4, per_ring: 6, r_near_m: 0.8, r_far_m: 6, ring_stagger_deg: 15, radial_speed_mps: -0.8, edge_fade: 0.35 } },
    { label: "Opening out", set: { rings: 4, per_ring: 6, r_near_m: 0.8, r_far_m: 6, ring_stagger_deg: 15, radial_speed_mps: 0.8, edge_fade: 0.35 } },
    { label: "Whirlpool", set: { rings: 4, per_ring: 6, r_near_m: 0.8, r_far_m: 6, ring_stagger_deg: 15, radial_speed_mps: -0.5, rotation_deg_per_sec: 160, rotation_outer_deg_per_sec: 40, edge_fade: 0.35 } },
    { label: "Random ring", set: { rings: 1, per_ring: 8, r_near_m: 2, r_far_m: 2, random_fraction: 1, wander_deg: 70 } },
  ],
  cartesian: [
    { label: "Still grid", set: { cols: 5, rows: 5 } },
    { label: "Driving forward", set: { cols: 5, rows: 5, extent_y_m: 10, drift_y_mps: -2 } },
    { label: "Passing left to right", set: { cols: 5, rows: 5, extent_x_m: 10, drift_x_mps: 1.5 } },
    { label: "Diagonal drift", set: { cols: 5, rows: 5, drift_x_mps: 1, drift_y_mps: -1 } },
    // Fully incoherent populations. The same control as partial coherence
    // within a moving component, taken to the end of its range, which makes a
    // separate group of sources going nowhere in particular.
    { label: "Random grid", set: { cols: 5, rows: 5, random_fraction: 1, wander_deg: 70 } },
  ],
};

const COMPONENT_ROWS = [
  { k: "lattice", ref: "component", type: "sel", opts: Object.keys(LATTICES), structural: true },

  { k: "rings", ref: "component", type: "int", min: 1, max: 8, step: 1, showIf: isPolar, structural: true },
  { k: "per_ring", ref: "source", type: "int", min: 1, max: 24, step: 1, showIf: isPolar },
  { k: "r_near_m", ref: "source-distance", type: "range", min: 0, max: 8, step: 0.1, unit: "m", showIf: isPolar },
  { k: "r_far_m", ref: "source-distance", type: "range", min: 0, max: 12, step: 0.1, unit: "m", showIf: c => isPolar(c) && c.rings > 1 },
  { k: "offset_deg", ref: "azimuth", type: "range", min: 0, max: 360, step: 5, unit: "°", showIf: isPolar, adv: true },
  { k: "ring_stagger_deg", ref: "component", type: "range", min: 0, max: 90, step: 5, unit: "°", showIf: c => isPolar(c) && c.rings > 1, adv: true },
  { k: "start_azimuths", ref: "azimuth", type: "list", placeholder: "even", showIf: isPolar, adv: true },

  { k: "cols", ref: "component", type: "int", min: 1, max: 12, step: 1, showIf: isGrid },
  { k: "rows", ref: "component", type: "int", min: 1, max: 12, step: 1, showIf: isGrid },
  { k: "extent_x_m", ref: "component", type: "range", min: 1, max: 24, step: 0.5, unit: "m", showIf: isGrid, adv: true },
  { k: "extent_y_m", ref: "component", type: "range", min: 1, max: 24, step: 0.5, unit: "m", showIf: isGrid, adv: true },

  { k: "rotation_deg_per_sec", ref: "rotation-rate", type: "range", min: -720, max: 720, step: 5, unit: "°/s" },
  { k: "rotation_outer_deg_per_sec", ref: "whirlpool", type: "optnum", placeholder: "same as inner", unit: "°/s", showIf: c => isPolar(c) && c.rings > 1 },
  { k: "radial_speed_mps", ref: "radial-flow", type: "range", min: -4, max: 4, step: 0.1, unit: "m/s" },
  { k: "drift_x_mps", ref: "translation", type: "range", min: -6, max: 6, step: 0.1, unit: "m/s" },
  { k: "drift_y_mps", ref: "translation", type: "range", min: -6, max: 6, step: 0.1, unit: "m/s" },

  { k: "random_fraction", ref: "motion-coherence", type: "range", min: 0, max: 1, step: 0.05, structural: true },
  { k: "wander_deg", ref: "motion-coherence", type: "range", min: 0, max: 180, step: 5, unit: "°", showIf: wanders },
  { k: "wander_hz", ref: "motion-coherence", type: "range", min: 0, max: 2, step: 0.05, unit: "Hz", showIf: wanders },
  { k: "radial_wander_m", ref: "motion-coherence", type: "range", min: 0, max: 3, step: 0.05, unit: "m", structural: true, adv: true },

  { k: "gain_db", ref: "level-matching", type: "range", min: -24, max: 12, step: 1, unit: "dB", adv: true },
  { k: "edge_fade", ref: "component", type: "range", min: 0.02, max: 0.5, step: 0.02, adv: true },
  { k: "min_distance_m", ref: "source-distance", type: "range", min: 0, max: 2, step: 0.05, unit: "m", adv: true },
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
      { k: "per_source_amount", ref: "decorrelation-amount", type: "list", placeholder: "all the same" },
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
];

const LABELS = {
  n_sources: "sources", rotation_deg_per_sec: "rotation", offset_deg: "offset",
  // Lattice shape and the motions applied to it. Axes are named by what the
  // listener would call them rather than by x and y: +x is to the right and
  // +y is ahead, which is worth stating once here and nowhere else.
  lattice: "lattice", rings: "rings", per_ring: "sources per ring",
  cols: "columns", rows: "rows",
  extent_x_m: "width", extent_y_m: "depth",
  ring_stagger_deg: "ring stagger",
  rotation_outer_deg_per_sec: "rotation, outer",
  drift_x_mps: "drift, sideways", drift_y_mps: "drift, forward",
  edge_fade: "edge fade", min_distance_m: "closest approach",
  max_gain_db: "level ceiling", time_scale: "time scale",
  spacing_deg: "spacing", start_azimuths: "azimuths", per_source_gain_db: "per-source gain",
  seed: "seed", amount: "amount", family: "family", ir_ms: "IR length",
  density: "density", phase_depth: "phase depth", envelope: "envelope",
  decay_db: "decay", per_source_amount: "per-source amount", crossovers: "crossovers",
  band_amounts: "band amounts", micro_delay_ms: "micro delay",
  micro_pitch_cents: "micro pitch", lfo_hz: "LFO rate", lfo_depth: "LFO depth",
  lfo_source_spread: "LFO spread",
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
const defaultComponent = (lattice = "polar", preset = null) => {
  const c = {
    lattice, label: "",
    rings: 1, per_ring: 6, r_near_m: 2, r_far_m: 4,
    offset_deg: 0, ring_stagger_deg: 0, start_azimuths: null,
    cols: 5, rows: 5, extent_x_m: 8, extent_y_m: 8,
    rotation_deg_per_sec: 0, rotation_outer_deg_per_sec: null,
    radial_speed_mps: 0, drift_x_mps: 0, drift_y_mps: 0,
    random_fraction: 0, wander_deg: 60, wander_hz: 0.25, radial_wander_m: 0,
    gain_db: 0, edge_fade: 0.3, min_distance_m: 0, max_gain_db: 12, time_scale: 1,
    decorr: null, collapsed: false, advanced: false,
  };
  if (preset) Object.assign(c, preset.set, { label: preset.label.toLowerCase() });
  return c;
};

const defaultField = () => ({
  components: [defaultComponent("polar",
    COMPONENT_PRESETS.polar.find(p => p.label === "Turning ring"))],
  decorr: defaultDecorr(),
  head_radius: 0.0875, speed_of_sound: 343, hrtf_taps: 128, hrtf_grid_step: 1,
  block: 256, seed: 0
});

/** Distinct hues, one per component.
 *
 *  Colour used to name the variant, from when several could sound at once and
 *  telling them apart mattered. A trial holds one variant at a time now, so
 *  the useful distinction moved down a level: a field built from a near ring
 *  and a far grid reads as two things, and the monitor should say which is
 *  which. Rings or rows inside a component take shades of its hue. */
const COMPONENT_HUES = [205, 25, 150, 285, 8, 45, 190, 320];
const VARIANT_HUES = COMPONENT_HUES;   // older saved experiments name this

const componentHue = (c, ci) =>
  (c && c.hue !== undefined && c.hue !== null)
    ? c.hue : COMPONENT_HUES[ci % COMPONENT_HUES.length];

function variantColour(v, vi) {
  const h = v.hue !== undefined && v.hue !== null ? v.hue
    : COMPONENT_HUES[(vi - 1 + COMPONENT_HUES.length) % COMPONENT_HUES.length];
  return h;
}

/** Hues for the components of whatever is sounding, in component order. */
function liveComponentHues(n) {
  const cs = S.live
    ? (S.passages[S.live.pi]?.variants[S.live.vi]?.config?.components || [])
    : (passage()?.variants[S.ref]?.config?.components || []);
  return Array.from({ length: Math.max(n, 1) },
                    (_, ci) => componentHue(cs[ci], ci));
}

/** Shade k of n within a variant's hue: darker toward the centre of the field. */
const shadeOf = (hue, k, n) => {
  const l = n <= 1 ? 42 : 26 + (k / (n - 1)) * 34;
  return `hsl(${hue} 42% ${l}%)`;
};

/** The colour input speaks hex, the palette speaks hue. */
function hslHex(hue, s = 0.42, l = 0.42) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (hue % 360) / 60, x = c * (1 - Math.abs(hp % 2 - 1));
  const m = l - c / 2;
  const t = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return "#" + t.map(u => Math.round((u + m) * 255)
    .toString(16).padStart(2, "0")).join("");
}

/** A row of hues, opened from a swatch and closed by clicking it again. */
let huePop = null;
function toggleHuePicker(anchor, current, onPick) {
  if (huePop && huePop.anchor === anchor) { closeHuePicker(); return; }
  closeHuePicker();
  const el = document.createElement("div");
  el.className = "huepop";
  el.innerHTML = VARIANT_HUES.map(h =>
    `<button data-h="${h}" style="background:${shadeOf(h, 0, 2)}"
       class="${h === current ? "on" : ""}"></button>`).join("");
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = clamp(r.left - 4, 6, innerWidth - el.offsetWidth - 6) + "px";
  el.style.top = (r.bottom + 6) + "px";
  el.addEventListener("click", e => {
    const b = e.target.closest("[data-h]");
    if (!b) return;
    onPick(Number(b.dataset.h));
    closeHuePicker();
  });
  huePop = { el, anchor };
  setTimeout(() => addEventListener("click", outsideHueClick), 0);
}

function closeHuePicker() {
  huePop?.el.remove();
  huePop = null;
  removeEventListener("click", outsideHueClick);
}

function outsideHueClick(e) {
  if (!e.target.closest(".huepop, .huepick")) closeHuePicker();
}

function hueOfHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-6) return 205;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(((h * 60) % 360 + 360) % 360);
}

const effectiveRate = cfg => {
  if (!cfg) return 0;
  // Only rotation has a well-defined cyclic rate; drift and radial flow
  // recycle at a period set by extent and speed instead.
  let r = 0;
  for (const c of (cfg.components || [])) {
    for (const v of [c.rotation_deg_per_sec, c.rotation_outer_deg_per_sec]) {
      if (v && Math.abs(v) > Math.abs(r)) r = v;
    }
  }
  return r;
};

const componentMoves = c =>
  c.time_scale !== 0 && (!!c.rotation_deg_per_sec || !!c.rotation_outer_deg_per_sec ||
  !!c.radial_speed_mps || !!c.drift_x_mps || !!c.drift_y_mps ||
  (c.wander_hz > 0 && (c.random_fraction > 0 || c.radial_wander_m > 0)));

const hasMotion = cfg => !!cfg && (cfg.components || []).some(componentMoves);

function summarize(cfg) {
  if (!cfg) return "original, untreated";
  const comps = cfg.components || [];
  const bits = [];
  if (!comps.length) {
    bits.push("no components yet");
  } else if (comps.length > 1) {
    const total = comps.reduce((n, c) => n + componentSources(c), 0);
    bits.push(`${comps.length} components · ${total} sources`);
    bits.push(comps.map(c => c.label || LATTICES[c.lattice]?.label || c.lattice)
      .join(" + ").toLowerCase());
  } else {
    bits.push(componentSummary(comps[0]));
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

function emptyField() {
  const c = defaultField();
  c.components = [];
  return c;
}

function newPassage(start, end, name) {
  return {
    name: name || `Passage ${S.passages.length + 1}`,
    start, end, open: true, selected: 0,
    // Nothing is assumed about what the passage is for: the untreated signal
    // is the only thing every session needs.
    variants: [{ name: "untreated", config: null }],
  };
}

/** A variant built from a single component takes that component's name, with
 *  a number appended when the passage already has one of the same kind. */
function autoName(passage, cfg) {
  const comps = cfg?.components || [];
  if (comps.length !== 1) return null;
  const base = comps[0].label || LATTICES[comps[0].lattice]?.label || "component";
  const taken = passage.variants.filter(v =>
    v.name === base || v.name.startsWith(base + " ")).length;
  return taken ? `${base} ${taken + 1}` : base;
}

function renameFromComponents(passage, variant) {
  if (variant.renamed) return;
  const auto = autoName(passage, variant.config);
  if (auto) variant.name = auto;
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

/** A share of the sources rotates together; the rest wander without a net
 *  direction, after the coherence manipulation in random-dot kinematograms. */
/** Same configuration with every kind of motion removed: rotation, radial
 *  flow, drift, and wander, which freezes at a seed-determined offset. */
function controlOf(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.rotation_deg_per_sec = 0;
  c.total_degrees = null;
  // Stop the clock rather than the rates: the control then keeps the same
  // spatial and level distribution, including any edge fade.
  for (const k of (c.components || [])) k.time_scale = 0;
  return c;
}

/** A turning ring: the simplest configuration and the one a new passage
 *  starts from. Everything about it stays editable. */
function rotatingRing(rate = 60) {
  const c = defaultField();
  c.components[0].rotation_deg_per_sec = rate;
  c.decorr.amount = 1.0;
  c.decorr.family = "allpass";
  return c;
}

// ====================================================================
// Component editor
// ====================================================================

function parseList(s) {
  const t = (s || "").trim();
  if (!t) return null;
  const out = t.split(/[,\s]+/).filter(Boolean).map(Number);
  return out.some(Number.isNaN) ? null : out;
}

const componentSources = c => isGrid(c)
  ? Math.max(c.cols, 1) * Math.max(c.rows, 1)
  : Math.max(c.rings, 1) * Math.max(c.per_ring, 1);

function componentSummary(c) {
  const bits = [isGrid(c) ? `${c.cols}×${c.rows} grid`
    : (c.rings > 1 ? `${c.rings} rings × ${c.per_ring}` : `ring of ${c.per_ring}`)];
  const motion = [];
  if (c.rotation_deg_per_sec) {
    motion.push(c.rotation_outer_deg_per_sec != null
      ? `turn ${c.rotation_deg_per_sec}→${c.rotation_outer_deg_per_sec}°/s`
      : `turn ${c.rotation_deg_per_sec}°/s`);
  }
  if (c.radial_speed_mps)
    motion.push(`${c.radial_speed_mps < 0 ? "in" : "out"} ${fmt(Math.abs(c.radial_speed_mps), 1)} m/s`);
  if (c.drift_x_mps || c.drift_y_mps) {
    const dir = Math.abs(c.drift_y_mps) >= Math.abs(c.drift_x_mps)
      ? (c.drift_y_mps < 0 ? "back" : "forward")
      : (c.drift_x_mps > 0 ? "right" : "left");
    motion.push(`drift ${dir} ${fmt(Math.hypot(c.drift_x_mps, c.drift_y_mps), 1)} m/s`);
  }
  bits.push(motion.length ? motion.join(", ") : "still");
  if (c.random_fraction > 0) bits.push(`${Math.round(c.random_fraction * 100)}% random`);
  if (c.decorr) bits.push(`decorr ${fmt(c.decorr.amount, 2)}`);
  return bits.join(" · ");
}

/** One row of controls bound to obj[row.k]. Shared by both editors. */
function makeParamRow(row, obj, onChange, rebuild) {
  const el = document.createElement("div");
  el.className = "prow";
  const lab = document.createElement("span");
  lab.className = "plabel";
  lab.append(LABELS[row.k] || row.k, infoBtn(row.ref));
  el.appendChild(lab);
  const v = obj[row.k];
  const changed = (val, structural) => {
    obj[row.k] = val; onChange(); if (structural) rebuild();
  };

  if (row.type === "range") {
    const sl = document.createElement("input");
    sl.type = "range";
    Object.assign(sl, { min: row.min, max: row.max, step: row.step, value: v ?? 0 });
    const num = document.createElement("input");
    num.type = "number"; num.className = "pval";
    Object.assign(num, { min: row.min, max: row.max, step: row.step, value: v ?? 0 });
    sl.addEventListener("input", () => { num.value = sl.value; changed(Number(sl.value), false); });
    sl.addEventListener("change", () => { if (row.structural) rebuild(); });
    num.addEventListener("change", () => { sl.value = num.value; changed(Number(num.value), row.structural); });
    el.append(sl, num);
    const u = document.createElement("span");
    u.className = "unit"; u.textContent = row.unit || "";
    el.appendChild(u);
  } else if (row.type === "int") {
    const n = document.createElement("input");
    n.type = "number";
    Object.assign(n, { min: row.min, max: row.max, step: row.step, value: v ?? 0 });
    n.addEventListener("change", () => changed(Number(n.value), row.structural));
    el.appendChild(n);
  } else if (row.type === "optnum") {
    const n = document.createElement("input");
    n.type = "text"; n.placeholder = row.placeholder || ""; n.value = v ?? "";
    n.addEventListener("change", () =>
      changed(n.value.trim() === "" ? null : Number(n.value), row.structural));
    el.appendChild(n);
  } else if (row.type === "sel") {
    const s = document.createElement("select");
    s.innerHTML = row.opts.map(o =>
      `<option value="${o}"${String(o) === String(v) ? " selected" : ""}>${LATTICES[o]?.label || o}</option>`).join("");
    s.addEventListener("change", () => {
      const raw = s.value;
      changed(Number.isNaN(Number(raw)) || raw === "" ? raw : Number(raw), true);
    });
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
    t.addEventListener("change", () => changed(parseList(t.value), false));
    el.appendChild(t);
  }
  return el;
}

/** Parameter groups fold shut by default: a variant has more settings than
 *  fit on a screen, and most sessions touch only a few of them. */
const FOLDED = new Set(JSON.parse(localStorage.getItem("sk.folded") || "null")
  || ["Decorrelation", "Physical model"]);

function buildParams(host, cfg, onChange) {
  host.innerHTML = "";
  const rebuild = () => buildParams(host, cfg, onChange);
  for (const grp of PARAMS) {
    const obj = grp.path ? cfg[grp.path] : cfg;
    if (!obj) continue;
    const box = document.createElement("div");
    const folded = FOLDED.has(grp.group);
    box.className = "pgroup" + (folded ? " folded" : "");

    const gh = document.createElement("div");
    gh.className = "ghead";
    const caret = document.createElement("span");
    caret.className = "fold";
    caret.innerHTML = chevron(!folded, 12);
    gh.append(caret, grp.group, infoBtn(grp.ref));
    gh.addEventListener("click", e => {
      if (e.target.closest(".i")) return;
      FOLDED.has(grp.group) ? FOLDED.delete(grp.group) : FOLDED.add(grp.group);
      localStorage.setItem("sk.folded", JSON.stringify([...FOLDED]));
      rebuild();
    });
    box.appendChild(gh);

    for (const row of grp.rows) {
      if (row.showIf && !row.showIf(obj)) continue;
      box.appendChild(makeParamRow(row, obj, onChange, rebuild));
    }
    host.appendChild(box);
  }
}

function buildComponentEditor(host, cfg, onChange, hue) {
  host.innerHTML = "";
  if (!cfg.components) cfg.components = [];
  const rebuild = () => buildComponentEditor(host, cfg, onChange, hue);
  const n = Math.max(cfg.components.length, 2);

  cfg.components.forEach((c, ci) => {
    const chue = componentHue(c, ci);
    const mod = document.createElement("div");
    mod.className = "ringmod";
    if (c.collapsed) mod.classList.add("collapsed");
    mod.style.borderLeft = `3px solid ${shadeOf(chue, 1, 2)}`;

    const head = document.createElement("div");
    head.className = "rmhead";
    const twist = document.createElement("button");
    twist.className = "sm ghost twist";
    twist.innerHTML = chevron(!c.collapsed);
    twist.title = c.collapsed ? "show settings" : "hide settings";
    twist.addEventListener("click", e => {
      e.stopPropagation(); c.collapsed = !c.collapsed; rebuild();
    });
    head.appendChild(twist);

    // The component's colour, which is how it is identified in the monitor.
    const swatch = document.createElement("button");
    swatch.className = "huepick";
    swatch.title = "component colour";
    swatch.style.background = shadeOf(chue, 1, 2);
    swatch.addEventListener("click", e => {
      e.stopPropagation();
      toggleHuePicker(swatch, chue, h => { c.hue = h; rebuild(); onChange(); });
    });
    head.appendChild(swatch);

    const name = document.createElement("input");
    name.className = "cname";
    name.value = c.label || "";
    name.placeholder = `${LATTICES[c.lattice]?.label || c.lattice} ${ci + 1}`;
    name.addEventListener("change", () => { c.label = name.value; onChange(); });
    head.appendChild(name);

    const sum = document.createElement("span");
    sum.className = "rmsum";
    sum.textContent = componentSummary(c);
    head.append(sum, Object.assign(document.createElement("span"), { className: "grow" }));

    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.className = "sm ghost"; b.textContent = label; b.title = title;
      b.addEventListener("click", e => { e.stopPropagation(); fn(); });
      return b;
    };
    head.appendChild(mk("Copy", "copy; paste into this or any variant", () => {
      CLIP.component = JSON.parse(JSON.stringify(c));
      rebuild();
    }));
    head.appendChild(mk("×", "remove this component", () => {
      cfg.components.splice(ci, 1); rebuild(); onChange();
    }));
    mod.appendChild(head);

    if (!c.collapsed) {
      const body = document.createElement("div");
      body.className = "rmbody";
      const refresh = () => { sum.textContent = componentSummary(c); onChange(); };

      for (const row of COMPONENT_ROWS) {
        if (row.adv && !c.advanced) continue;
        if (row.showIf && !row.showIf(c)) continue;
        body.appendChild(makeParamRow(row, c, refresh,
          row.structural ? rebuild : () => { }));
      }

      const more = document.createElement("button");
      more.className = "sm ghost";
      more.textContent = c.advanced ? "Fewer settings" : "More settings";
      more.addEventListener("click", () => { c.advanced = !c.advanced; rebuild(); });
      body.appendChild(more);

      // Per-component decorrelation, so components in one field can differ.
      const dec = document.createElement("div");
      dec.className = "pgroup";
      const dh = document.createElement("div");
      dh.className = "ghead";
      dh.append("Decorrelation", infoBtn("decorrelation"));
      const toggle = document.createElement("button");
      toggle.className = "sm ghost";
      toggle.textContent = c.decorr ? "inherit" : "set separately";
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
        const note = document.createElement("div");
        note.className = "note";
        note.textContent = "Using the variant's decorrelation.";
        dec.appendChild(note);
      }
      body.appendChild(dec);
      mod.appendChild(body);
    }
    host.appendChild(mod);
  });

  if (!cfg.components.length) {
    const empty = document.createElement("div");
    empty.className = "note";
    empty.textContent = "No components yet. Add one to give this variant a field.";
    host.appendChild(empty);
  }

  const bar = document.createElement("div");
  bar.className = "ringbar";
  const addSel = document.createElement("select");
  addSel.className = "sm";
  addSel.innerHTML = `<option value="">Add component…</option>` +
    Object.entries(LATTICES).map(([k, v]) =>
      `<optgroup label="${v.label} — ${v.hint}">` +
      COMPONENT_PRESETS[k].map((p, i) =>
        `<option value="${k}:${i}">${esc(p.label)}</option>`).join("") +
      `</optgroup>`).join("");
  addSel.addEventListener("change", () => {
    if (!addSel.value) return;
    const [lat, i] = addSel.value.split(":");
    cfg.components.push(defaultComponent(lat, COMPONENT_PRESETS[lat][Number(i)]));
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

/** Only the selected passage is shown.
 *
 * Passages contain variants which contain components, and drawing all three
 * levels at once put the deepest controls in a column too narrow for them.
 * A selector keeps the hierarchy without nesting it on screen.
 */
function renderPassages() {
  const host = $("#passages");
  host.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "passagebar";
  const pick = document.createElement("select");
  pick.innerHTML = S.passages.map((p, i) =>
    `<option value="${i}"${i === S.active ? " selected" : ""}>${esc(p.name)}` +
    ` — ${fmt(p.start, 1)}–${fmt(p.end, 1)}s</option>`).join("")
    || `<option>no passages yet</option>`;
  pick.addEventListener("change", () => {
    S.active = Number(pick.value);
    S.live = null; S.latched = false;
    renderPassages(); drawWave(); showMetrics();
  });
  bar.append(Object.assign(document.createElement("span"),
    { className: "dim", textContent: "Passage" }), pick);

  const p0 = S.passages[S.active];
  if (p0) {
    const rename = document.createElement("input");
    rename.value = p0.name; rename.style.maxWidth = "160px";
    rename.addEventListener("change", () => { p0.name = rename.value; renderPassages(); });
    const del = document.createElement("button");
    del.className = "sm ghost"; del.textContent = "Remove passage";
    del.addEventListener("click", () => {
      S.passages.splice(S.active, 1);
      S.active = clamp(S.active, 0, S.passages.length - 1);
      S.live = null; S.latched = false;
      // Any render still in flight was for the old set of passages.
      S.renderToken = (S.renderToken || 0) + 1;
      S.rendered = null; S.buffers = {};
      stopPlayback();
      const btn = $("#render");
      btn.disabled = false; btn.classList.remove("busy"); btn.textContent = "Render";
      renderPassages(); drawWave(); markStale();
    });
    const only = document.createElement("button");
    only.className = "sm"; only.textContent = "Render this passage";
    only.title = "render only the selected passage";
    only.addEventListener("click", () => doRender([S.active]));
    bar.append(rename, Object.assign(document.createElement("span"),
      { className: "grow" }), only, del);
  }
  host.appendChild(bar);

  S.passages.forEach((p, pi) => {
    if (pi !== S.active) return;
    const el = document.createElement("div");
    el.className = "passage sel";

    const head = document.createElement("div");
    head.className = "pashead";
    head.append(Object.assign(document.createElement("b"),
      { textContent: "Variants" }));
    const span = document.createElement("span");
    span.className = "span";
    span.textContent = `${fmt(p.start, 1)}–${fmt(p.end, 1)}s`;
    head.append(span, Object.assign(document.createElement("span"),
      { className: "grow" }));

    const mk = (label, title, fn, cls = "sm") => {
      const b = document.createElement("button");
      b.className = cls; b.textContent = label; b.title = title;
      b.addEventListener("click", e => { e.stopPropagation(); fn(); });
      return b;
    };
    const add = document.createElement("button");
    add.className = "sm";
    add.textContent = "+ variant";
    add.title = "add an empty variant to build from components";
    add.addEventListener("click", e => {
      e.stopPropagation();
      p.variants.push({ name: `variant ${p.variants.length}`, config: emptyField() });
      renderPassages(); markStale();
    });
    head.appendChild(add);
    el.appendChild(head);

    {
      const body = document.createElement("div");
      body.className = "pasbody";

      p.variants.forEach((v, vi) => {
        const isLive = S.live && S.live.pi === pi && S.live.vi === vi;
        const latched = isLive && S.latched;
        const hue = variantColour(v, vi);
        const vr = document.createElement("div");
        vr.className = "variant" + (isLive ? " live" : "") + (latched ? " latched" : "");
        if (vi > 0) vr.style.borderLeft = `4px solid ${shadeOf(hue, 0, 2)}`;

        const key = document.createElement("span");
        key.className = "key"; key.textContent = vi === 0 ? "–" : vi;
        vr.appendChild(key);

        const vn = document.createElement("input");
        vn.className = "vname"; vn.value = v.name;
        vn.addEventListener("change", () => {
          v.name = vn.value;
          v.renamed = true;          // stop tracking the component name
        });
        vr.appendChild(vn);

        const tag = document.createElement("span");
        tag.className = "tag " + (v.config ? "spin" : "dry");
        if (v.config) {
          const comps = v.config.components || [];
          const src = comps.reduce((n, c) => n + componentSources(c), 0);
          tag.textContent = `${comps.length} comp · ${src} src`;
          tag.title = summarize(v.config);
        } else {
          tag.textContent = "original";
        }
        vr.appendChild(tag);
        vr.appendChild(document.createElement("span")).className = "grow";

        if (vi > 0) {
          // An explicit control, since nothing about a row suggests that
          // clicking it would hold the variant on.
          const latch = document.createElement("button");
          latch.className = "vlatch";
          latch.textContent = latched ? "Latched" : "Latch";
          latch.title = latched
            ? "release; playback returns to the untreated signal"
            : "hold this variant on until released";
          latch.addEventListener("click", e => {
            e.stopPropagation();
            S.active = pi;
            if (latched) { S.latched = false; applyVariant(pi, 0); }
            else { S.latched = true; applyVariant(pi, vi); }
          });
          vr.appendChild(latch);

          // Colour belongs to the component now, and is set on its header.
        }

        if (v.config && hasMotion(v.config)) {
          vr.appendChild(mk("+ control", "add the matched still twin", () => {
            p.variants.splice(vi + 1, 0, {
              name: v.name + " · control", config: controlOf(v.config),
              hue: (hue + 180) % 360,
            });
            renderPassages(); markStale();
          }));
        }
        const chev = mk("", v.open ? "hide settings" : "show settings", () => {
          v.open = !v.open; renderPassages();
        }, "sm ghost twist");
        chev.innerHTML = chevron(v.open);
        vr.appendChild(chev);
        if (vi > 0) vr.appendChild(mk("×", "remove variant", () => {
          p.variants.splice(vi, 1); renderPassages(); markStale();
        }, "sm ghost"));

        // Clicking latches the variant on; clicking again releases it.
        vr.addEventListener("click", e => {
          if (e.target.closest("button, input")) return;
          S.active = pi;
          if (latched) { S.latched = false; applyVariant(pi, 0); }
          else { S.latched = true; applyVariant(pi, vi); }
        });
        body.appendChild(vr);

        if (v.open && v.config) {
          const pane = document.createElement("div");
          pane.style.cssText = "padding:2px 8px 10px 26px";
          const onchg = () => {
            const comps = v.config.components || [];
            const src = comps.reduce((n, c) => n + componentSources(c), 0);
            tag.textContent = `${comps.length} comp · ${src} src`;
            tag.title = summarize(v.config);
            renameFromComponents(p, v);
            vn.value = v.name;
            markStale();
          };
          const compHost = document.createElement("div");
          buildComponentEditor(compHost, v.config, onchg, hue);
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

  // cursor, and the playhead of whichever thing is sounding
  if (S.cursor !== null && S.cursor !== undefined) {
    x.strokeStyle = "#4a4640"; x.lineWidth = 1;
    x.beginPath(); x.moveTo(px(S.cursor), 0); x.lineTo(px(S.cursor), h); x.stroke();
  }
  const head = previewSrc ? previewPosition() : (S.rendered ? playPosition() : null);
  if (head !== null) {
    x.strokeStyle = "#a33a2a"; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(px(head), 0); x.lineTo(px(head), h); x.stroke();
  }

  x.fillStyle = "#7c766c"; x.font = "10px ui-monospace, monospace";
  const step = Math.max(15, Math.round(S.duration / 18 / 15) * 15);
  for (let t = 0; t < S.duration; t += step) x.fillText(mmss(t), px(t) + 2, h - 3);
}

/** Waveform interaction, on the left button alone.
 *
 *   click   move the cursor, and make the passage under it the active one
 *   drag    mark out a selection, then play it
 *
 * The right button is deliberately unused. A custom menu on it has to suppress
 * the browser's own, and the suppression is unreliable across browsers, so the
 * browser menu appears over the waveform instead of the intended one. The edges
 * of a selection are editable as numbers beside the waveform, which is more
 * precise than a menu anyway.
 */
function wireWave() {
  const c = $("#wave");
  let mode = null;          // null | "down" (may still be a click) | "select"
  let from = null, downX = 0;
  const tAt = e => {
    const r = c.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width * S.duration, 0, S.duration);
  };

  // Nothing here acts on the right button, so a right click on the canvas is
  // swallowed rather than being allowed to drop a menu over the waveform.
  c.addEventListener("contextmenu", e => e.preventDefault());

  c.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    from = tAt(e); downX = e.clientX; mode = "down";
  });

  c.addEventListener("mousemove", e => {
    if (!mode) return;
    // A few pixels of travel separates a drag from an unsteady click. The
    // threshold is in pixels, not seconds, because a second is a different
    // distance on a two-minute track than on a ten-minute one.
    if (mode === "down" && Math.abs(e.clientX - downX) < 3) return;
    mode = "select";
    const t = tAt(e);
    S.sel = [Math.min(from, t), Math.max(from, t)];
    syncSel();
    drawWave();
  });

  addEventListener("mouseup", () => {
    if (!mode) return;
    if (mode === "select") {
      if (S.sel[1] - S.sel[0] < 0.5) S.sel[1] = Math.min(S.duration, S.sel[0] + 0.5);
      syncSel();
      // Hearing the selection immediately is what makes an edge adjustable by
      // ear rather than by number.
      previewSelection(S.sel[0], false);
    } else {
      S.cursor = from;
      const hit = S.passages.findIndex(p => from >= p.start && from <= p.end);
      if (hit >= 0 && hit !== S.active) { S.active = hit; renderPassages(); }
    }
    mode = null; from = null;
    drawWave();
  });

  addEventListener("resize", drawWave);
}

const syncSel = () => {
  $("#pstart").value = S.sel[0].toFixed(1);
  $("#pend").value = S.sel[1].toFixed(1);
};

/** Play the current selection straight from the source file.
 *
 * Deciding which stretch of a track is worth studying is a listening job, and
 * it should not require committing to a passage and waiting for a render
 * first. This plays the untreated audio directly, so it is instant.
 */
let previewSrc = null, previewGain = null;

function stopPreview() {
  try { previewSrc?.stop(); } catch (_) { }
  previewSrc = null;
  updateTransport();
}

/** Decode the source once and sum it to mono.
 *
 * The spatializer is fed the mono sum, so auditioning the original stereo
 * would preview material the renderer never sees.
 */
async function sourceMono() {
  if (S.sourceBuffer && S.sourceFor === S.track) return S.sourceBuffer;
  const r = await fetch(`/api/source/${encodeURIComponent(S.track)}`);
  const decoded = await AC.decodeAudioData(await r.arrayBuffer());
  const n = decoded.length;
  const mono = AC.createBuffer(1, n, decoded.sampleRate);
  const out = mono.getChannelData(0);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const src = decoded.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += src[i];
  }
  if (decoded.numberOfChannels > 1) {
    for (let i = 0; i < n; i++) out[i] /= decoded.numberOfChannels;
  }
  S.sourceBuffer = mono;
  S.sourceFor = S.track;
  return mono;
}

/** Play from the cursor, looping the selection when there is one. */
async function previewSelection(from = null, loop = true) {
  stopPlayback();
  stopPreview();
  if (!S.track) return;
  let buf;
  try { buf = await sourceMono(); } catch (_) { return; }
  if (AC.state === "suspended") AC.resume();

  const [a, b] = S.sel;
  const start = from !== null ? from : (S.cursor ?? a);
  previewGain = AC.createGain();
  previewGain.connect(AC.destination);
  previewSrc = AC.createBufferSource();
  previewSrc.buffer = buf;
  if (loop && b - a > 0.2) {
    previewSrc.loop = true;
    previewSrc.loopStart = a;
    previewSrc.loopEnd = b;
  }
  previewSrc.connect(previewGain);
  const t0 = AC.currentTime + 0.02;
  previewSrc.start(t0, clamp(start, 0, S.duration - 0.05));
  S.previewAt = { start, t0, loop: loop && b - a > 0.2, a, b };
  updateTransport();
}

/** Where the preview has reached, for drawing the playhead. */
function previewPosition() {
  const p = S.previewAt;
  if (!previewSrc || !p) return S.cursor ?? 0;
  let t = p.start + (AC.currentTime - p.t0);
  if (p.loop) {
    const len = p.b - p.a;
    if (t > p.a) t = p.a + (((t - p.a) % len) + len) % len;
  }
  return clamp(t, 0, S.duration);
}

// ====================================================================
// Render and playback
// ====================================================================

const AC = new (window.AudioContext || window.webkitAudioContext)();
let dryGain = null, dryNode = null;
let varNodes = [];      // {pi, vi, src, gain}

/** Render passages. Pass a list of indices to render only some of them, which
 *  keeps a quick change to one passage from re-rendering the whole session. */
async function doRender(only = null) {
  if (!S.passages.length) return;
  // Guards against being wired straight to a click handler, which would pass
  // the event in place of the index list.
  if (!Array.isArray(only)) only = null;
  S.renderOnly = only;
  // A render in flight describes the passages as they were when it started.
  // If they change underneath it, its result no longer matches what is on
  // screen, so it is discarded rather than applied.
  const token = (S.renderToken = (S.renderToken || 0) + 1);
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
      passages: S.passages.map((p, i) => ({
        name: p.name, start: p.start, end: p.end,
        // A passage not being rendered still needs a slot, so indices in the
        // response keep lining up with the ones on screen.
        variants: (only && !only.includes(i)) ? []
          : p.variants.map(v => ({ label: v.name, config: v.config }))
      }))
    });
    if (token !== S.renderToken) return;      // superseded while in flight
    S.rendered = res;

    msg.textContent = "Decoding…";
    S.dryBuffer = await decode(res.dry.url);
    S.buffers = {};
    await Promise.all(res.passages.flatMap((p, pi) =>
      p.variants.map(async (v, vi) => {
        if (v.url) S.buffers[`${pi}:${vi}`] = await decode(v.url);
      })));

    if (token !== S.renderToken) return;
    msg.textContent = `Rendered in ${res.render_seconds}s.`;
    showMetrics();
    startPlayback(passage()?.start ?? 0);
  } catch (e) {
    if (token === S.renderToken) {
      msg.className = "msg err";
      msg.textContent = "Render failed: " + e.message;
    }
  } finally {
    if (token !== S.renderToken) return;
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
  const idx = Array.isArray(vi) ? vi[0] : vi;
  S.live = (idx === null || idx === undefined || idx === 0) ? null : { pi, vi: idx };
  const share = 1;
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
    S.live && n.pi === S.live.pi && n.vi === S.live.vi ? share : 0));

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
  // Hold a number to hear a variant momentarily; hold Ctrl with it, or click
  // the row, to latch it on until released the same way.
  let held = null;
  addEventListener("keydown", e => {
    if (e.target?.matches?.("input, select, textarea")) return;
    if ($("#sheet").classList.contains("on") || Tour.active) return;
    // A trial owns the keyboard while it runs: space holds B there, and the
    // digits would let a listener reach a variant the trial did not offer.
    if (S.blind) return;
    if (e.code === "Space") { e.preventDefault(); $("#play").click(); return; }
    // Ctrl or Cmd with a digit produces a different e.key on some layouts, so
    // the digit is taken from the physical key instead.
    const n = e.code && e.code.startsWith("Digit")
      ? parseInt(e.code.slice(5), 10) : parseInt(e.key, 10);
    if (!(n >= 1 && n <= 9) || !passage() || n >= passage().variants.length) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const already = S.latched && S.live && S.live.vi === n;
      S.latched = !already;
      applyVariant(S.active, already ? 0 : n);
      held = null;
      renderPassages();
      return;
    }
    if (held === null) { held = n; S.latched = false; applyVariant(S.active, n); }
  });
  addEventListener("keyup", e => {
    const n = e.code && e.code.startsWith("Digit")
      ? parseInt(e.code.slice(5), 10) : parseInt(e.key, 10);
    if (n === held) {
      held = null;
      if (!S.latched) applyVariant(S.active, S.ref);
    }
  });
  addEventListener("blur", () => {
    if (held !== null) { held = null; if (!S.latched) applyVariant(S.active, S.ref); }
  });
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

/** The variant currently drawn, as an HSL hue, with components taking shades
 *  of it so a field of several reads as one thing with parts. */
function liveHue() {
  if (!S.live) return 205;
  const v = passageAt(S.live.pi)?.variants[S.live.vi];
  return variantColour(v || {}, S.live.vi);
}
const passageAt = i => S.passages[i];

function shadeRGB(hue, k, n) {
  // hsl -> rgb, so canvas can build rgba strings with a live alpha
  const l = (n <= 1 ? 42 : 26 + (k / (n - 1)) * 34) / 100, s = 0.42;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (hue % 360) / 60, x = c * (1 - Math.abs(hp % 2 - 1));
  const m = l - c / 2;
  const t = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return t.map(u => Math.round((u + m) * 255));
}

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
  // Hue names the component; shade within it names the ring or row, so depth
  // stays legible without a second colour scheme. Only one variant sounds at a
  // time now, so a hue per variant bought nothing, while a hue per component
  // tells a listener which part of a multi-part field they are looking at.
  const compShades = v.params.component_shades || [1];
  const hues = liveComponentHues(compShades.length);
  const hueOf = i => hues[ringOf[i] % hues.length];
  const shadesIn = i => Math.max(2, compShades[ringOf[i]] || 1);
  const shadeIdx = v.params.resolved_shade_of || Array(nSrc).fill(0);
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

  // Sources only. Trails and a polygon joining each ring were drawn here, and
  // on a ring of nine they turned the picture into a thicket: the motion was
  // legible from the dots alone and the extra ink competed with it.
  fr.az.forEach((a, i) => {
    const [sx, sy] = posD(a, distAt(fr)[i]);
    const coh = 1 - (fr.amt[i] ?? 1);       // filled = coherent, hollow = decorrelated
    const lv = lvlAt(fr)[i];                // a fading source fades on screen
    const [cr, cg, cb] = shadeRGB(hueOf(i), shadeIdx[i], shadesIn(i));
    x.beginPath(); x.arc(sx, sy, 4.5 + 4.5 * coh, 0, Math.PI * 2);
    x.fillStyle = `rgba(${cr},${cg},${cb},${((0.10 + 0.85 * coh) * lv).toFixed(3)})`;
    x.fill();
    x.strokeStyle = `rgba(${cr},${cg},${cb},${(0.25 + 0.75 * lv).toFixed(3)})`;
    x.lineWidth = 1.2; x.stroke();
  });

  const comps = v.params.resolved_components || [];
  const domRate = comps.reduce((a, c) =>
    Math.abs(c.rotation_deg_per_sec) > Math.abs(a) ? c.rotation_deg_per_sec : a, 0);
  drawRotationArrow(x, cx, cy, R + 17, domRate, "#2c5f7c");
  // Arrow showing which way a drifting lattice is travelling.
  for (const c of comps) {
    if (!c.drift_x_mps && !c.drift_y_mps) continue;
    const dir = Math.atan2(c.drift_x_mps, c.drift_y_mps);
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
    const name = labels[i] || c.lattice;
    const parts = [];
    if (c.rotation_deg_per_sec) parts.push(`${fmt(c.rotation_deg_per_sec, 0)}°/s`);
    if (c.radial_speed_mps) parts.push(`${fmt(c.radial_speed_mps, 1)} m/s radial`);
    if (c.drift_x_mps || c.drift_y_mps)
      parts.push(`${fmt(Math.hypot(c.drift_x_mps, c.drift_y_mps), 1)} m/s drift`);
    return `${name}: ${parts.length ? parts.join(", ") : "still"}`;
  });
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
  bar.innerHTML = v
    ? `<span class="tag spin">${esc(v.label)}</span>
       <span class="dim">${S.latched ? "latched" : "applied"}</span>`
    : `<span class="tag dry">untreated</span>
       <span class="dim">hold a number key, or click a variant to latch it</span>`;

  const host = $("#readout");
  if (!v || !v.params) {
    host.innerHTML = p
      ? `<span class="note">${esc(p.name)}, ${fmt(p.start, 1)}–${fmt(p.end, 1)}s, playing untreated.</span>`
      : "";
    return;
  }
  const pr = v.params, d = pr.resolved_decorr;
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
    const motion = [];
    if (c.rotation_deg_per_sec) {
      motion.push(c.rotation_outer_deg_per_sec != null
        ? `turn ${fmt(c.rotation_deg_per_sec, 0)}→${fmt(c.rotation_outer_deg_per_sec, 0)}°/s`
        : `turn ${fmt(c.rotation_deg_per_sec, 0)}°/s`);
    }
    if (c.radial_speed_mps)
      motion.push(`${c.radial_speed_mps < 0 ? "inward" : "outward"} ${fmt(Math.abs(c.radial_speed_mps), 1)} m/s`);
    if (c.drift_x_mps || c.drift_y_mps)
      motion.push(`drift ${fmt(c.drift_x_mps, 1)}, ${fmt(c.drift_y_mps, 1)} m/s`);
    const shape = c.lattice === "cartesian"
      ? `${c.cols}×${c.rows} grid`
      : (c.rings > 1 ? `${c.rings} rings × ${c.per_ring}` : `ring of ${c.per_ring}`);
    const cd = c.decorr || d;
    rows.push([`<b>${esc(labels[ci] || c.lattice)}</b>`,
      `${shape} · ${idx.length} src · ${motion.length ? motion.join(", ") : "stationary"}`]);
    if (az) rows.push(["  azimuths", az]);
    if (dist) rows.push(["  distances", dist]);
    if (lvl && componentMoves(c)) rows.push(["  levels", lvl]);
    if (c.random_fraction > 0)
      rows.push(["  random share", `${Math.round(c.random_fraction * 100)}%`]);
    rows.push(["  decorrelation",
      `${cd.family} ${fmt(cd.amount, 2)} · ${fmt(cd.ir_ms, 0)}ms${c.decorr ? "" : " (inherited)"}`]);
  });

  rows.push(
    ["amounts now", fr ? fr.amt.map(a => fmt(a, 2)).join(" ") : fmt(d.amount, 2)],
    ["bands", d.crossovers ? `${d.crossovers.join("/")} Hz × ${(d.band_amounts || []).join(", ")}` : "full band"],
    ["head radius", `${fmt(pr.head_radius * 100, 1)} cm`],
    ["seed", pr.seed],
  );
  host.innerHTML = "<table>" +
    rows.map(([k, val]) => `<tr><td>${k}</td><td>${esc(String(val))}</td></tr>`).join("")
    + "</table>";
}

/** A transport that follows you off the Bench.
 *
 * Audio keeps playing when another page is opened, so there has to be a way to
 * stop it from wherever you are.
 */
function updateTransport() {
  const bar = $("#globaltransport");
  if (!bar) return;
  const onBench = $("#bench").classList.contains("on");
  const sounding = S.playing || !!previewSrc;
  bar.classList.toggle("on", sounding && !onBench);
  if (!sounding || onBench) return;
  const p = passage();
  // The variant label is the one thing a trial exists to hide, and this bar is
  // pinned to the bottom of every page. During a trial it shows the side of
  // the key instead, which the listener can already see.
  const what = previewSrc
    ? `selection ${fmt(S.sel[0], 1)}–${fmt(S.sel[1], 1)}s`
    : S.blind
      ? `trial ${S.blind.idx + 1} · ${S.blind.holding ? "B" : "A"}`
      : `${p ? p.name : "passage"}${S.live ? " · " + esc(
          S.rendered.passages[S.live.pi].variants[S.live.vi]?.label || "") : " · untreated"}`;
  $("#gtwhat").innerHTML = what;
  $("#gtclock").textContent = previewSrc
    ? mmssms(previewPosition()) : mmssms(playPosition());
}

function tick() {
  drawRing();
  updateTransport();
  if (previewSrc) {
    $("#selclock").textContent = mmssms(previewPosition());
    drawWave();
  }
  if (S.rendered) {
    const t = playPosition();
    $("#clock").textContent = `${mmssms(t)} / ${mmss(S.duration)}`;
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
    html += '<div class="cmatwrap"><table class="cmat">' + c.matrix.map(r => "<tr>" + r.map(x => {
      const t = Math.abs(x);
      return `<td style="background:rgba(44,95,124,${(t * .8).toFixed(2)});color:${t > .55 ? "#fff" : "#7c766c"}">${x.toFixed(1)}</td>`;
    }).join("") + "</tr>").join("") + "</table></div>";
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
    a.href = URL.createObjectURL(blob); a.download = "sonokinetic-passages.json"; a.click();
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
/** Trial items for a paired comparison.
 *
 * A trial holds two conditions at once and the listener moves between them, so
 * the items ask which of the two rather than how much of a quality. Absolute
 * ratings would throw away the sensitivity that switching buys: a rating
 * collected from one stimulus is compared against a remembered one, and memory
 * for spatial quality is the thing that fades.
 *
 * The free description runs first, before any fixed response supplies the
 * categories. What the percept is like is exactly what the fixed items cannot
 * ask, and asking afterwards collects their vocabulary back.
 */
const PAIR_QUESTIONS = [
  { id: "description", type: "text", optional: true, ref: "phenomenology",
    text: "What did you notice when you switched?",
    placeholder: "Whatever stands out. There is no right answer, and “nothing” is a real one." },
  { id: "differ", type: "opts", ref: "forced-choice",
    text: "Did the two differ at all?",
    opts: ["yes", "no", "cannot say"] },
  { id: "confidence", type: "scale", ref: "forced-choice",
    text: "How sure are you of that?", lo: "guessing", hi: "certain",
    when: r => r.differ === "yes" || r.differ === "no" },
  { id: "which_moves", type: "opts", ref: "auditory-motion",
    text: "Which one moved more?", when: r => r.differ === "yes",
    opts: ["A", "B", "the same", "cannot say"] },
  { id: "motion_kind", type: "opts", ref: "auditory-motion",
    text: "What kind of movement?",
    when: r => r.which_moves === "A" || r.which_moves === "B",
    opts: ["circling", "side to side", "nearer and farther", "irregular", "cannot say"] },
  { id: "which_diffuse", type: "opts", ref: "localization",
    text: "In which was it harder to point at anything?", when: r => r.differ === "yes",
    opts: ["A", "B", "the same", "cannot say"] },
  { id: "pointable", type: "opts", ref: "localization",
    text: "Setting the comparison aside, could you point at any individual source in either?",
    opts: ["yes, clearly", "yes, vaguely", "no"] },
  { id: "notes", type: "text", text: "Anything else", optional: true },
];

function questionHtml(q) {
  let controls;
  if (q.type === "scale") {
    controls = `<div class="scale7"><span class="endlab">${esc(q.lo)}</span>` +
      Array.from({ length: 7 }, (_, k) => `<button data-v="${k}">${k}</button>`).join("") +
      `<span class="endlab">${esc(q.hi)}</span></div>`;
  } else if (q.type === "text") {
    controls = `<textarea class="tnotes" data-text="${q.id}"
      placeholder="${esc(q.placeholder || "Anything worth recording about this one.")}"></textarea>`;
  } else {
    controls = `<div class="opts">` +
      q.opts.map(o => `<button data-v="${esc(o)}">${esc(o)}</button>`).join("") + `</div>`;
  }
  return `<div class="qbox" data-q="${q.id}">
    <div class="qtext">${esc(q.text)}${q.ref ? ` <button class="i" data-ref="${q.ref}">i</button>` : ""}</div>
    ${controls}</div>`;
}

/** How many times a listener must move between the two before answering.
 *
 * Answering without having compared is the failure this design exists to
 * prevent, and it is easy to do by accident when the form is already on
 * screen. The count is logged either way, so a listener who switched the
 * minimum and one who switched thirty times stay distinguishable. */
const MIN_SWITCHES = 4;

function refreshTrialState() {
  const b = S.blind;
  if (!b) return;
  for (const q of PAIR_QUESTIONS) {
    if (!q.when) continue;
    const box = $(`.qbox[data-q="${q.id}"]`);
    const on = q.when(b.responses);
    box?.classList.toggle("off", !on);
    if (!on) delete b.responses[q.id];
  }
  const answered = PAIR_QUESTIONS.every(q =>
    q.optional || (q.when && !q.when(b.responses)) || (q.id in b.responses));
  const compared = b.switches >= MIN_SWITCHES;
  const next = $("#bnext");
  if (next) next.disabled = !(answered && compared);
  const gate = $("#bgate");
  if (gate) {
    gate.textContent = compared
      ? `${b.switches} switches`
      : `Switch between A and B at least ${MIN_SWITCHES - b.switches} more time${
          MIN_SWITCHES - b.switches === 1 ? "" : "s"} before answering.`;
    gate.classList.toggle("ok", compared);
  }
}

/** Build the trial list: pairs, not single conditions.
 *
 * Identity pairs, where both sides are the same render, are the catch trials.
 * They are stronger than presenting the untreated signal alone, because the
 * correct answer is known exactly and the listener has no way to spot them:
 * the task, the material and the controls are identical to a real pair.
 */
function buildTrials(pool, reps, againstFirst, identity) {
  const pairs = [];
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      if (!againstFirst || i === 0) pairs.push([pool[i], pool[j]]);

  const shuffle = xs => {
    for (let k = xs.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [xs[k], xs[j]] = [xs[j], xs[k]];
    }
    return xs;
  };

  const out = [];
  for (let r = 0; r < reps; r++) {
    const round = pairs.map(p => [...p]);
    if (identity) {
      const c = pool[Math.floor(Math.random() * pool.length)];
      round.push([c, c]);
    }
    // Which member of a pair answers to the key is decided per trial, so a
    // listener cannot learn that the held side is always the treated one.
    for (const p of shuffle(round))
      out.push(Math.random() < 0.5 ? { a: p[0], b: p[1] } : { a: p[1], b: p[0] });
  }
  return out;
}

function startBlind() {
  const rp = S.rendered?.passages[S.active];
  if (!rp || rp.variants.length < 2) {
    $("#btrial").innerHTML = '<p class="note">Render a passage with at least two variants first.</p>';
    return;
  }
  const pool = rp.variants.map((v, i) => ({ vi: i, label: v.label, kind: v.kind }));
  const order = buildTrials(pool, Number($("#brepeats").value) || 3,
                            $("#bagainstdry").checked, $("#bidentity").checked);
  if (!order.length) {
    $("#btrial").innerHTML = '<p class="note">That combination produces no pairs.</p>';
    return;
  }
  S.blind = { order, idx: 0, session: $("#bsession").value || "s1",
              responses: {}, t0: 0, switches: 0, holding: false };
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
  b.responses = {}; b.t0 = performance.now(); b.switches = 0; b.holding = false;

  // Labels are never shown. The passage loops from its start and keeps
  // looping: the listener decides when they have compared enough, since
  // capping the time would add a variable without answering anything.
  $("#loop").checked = true;
  startPlayback(passage().start);
  applyVariant(S.active, b.order[b.idx].a.vi, 0);

  $("#bprogress").textContent = `Trial ${b.idx + 1} of ${b.order.length}`;
  $("#btrial").innerHTML = `
    <div class="abbar">
      <div class="abside live" id="abA"><b>A</b><span>on release</span></div>
      <button class="abhold" id="abhold">Hold for B</button>
      <div class="abside" id="abB"><b>B</b><span>while held</span></div>
    </div>
    <p class="dim">Hold the space bar, or the button above, to hear B. Release
      for A. The passage loops until you move on.</p>
    <div id="bgate" class="gate"></div>` +
    PAIR_QUESTIONS.map(questionHtml).join("") +
    `<div class="row"><button id="breplay">Restart the loop</button>
      <button id="bnext" class="primary" disabled>Next trial</button></div>`;

  $$(".qbox", $("#btrial")).forEach(qb => {
    $$("[data-v]", qb).forEach(btn => btn.addEventListener("click", () => {
      $$("[data-v]", qb).forEach(o => o.classList.remove("on"));
      btn.classList.add("on");
      S.blind.responses[qb.dataset.q] = btn.dataset.v;
      refreshTrialState();
    }));
  });
  const hold = $("#abhold");
  hold.addEventListener("pointerdown", e => { e.preventDefault(); holdB(true); });
  addEventListener("pointerup", () => { if (S.blind?.holding) holdB(false); });
  refreshTrialState();
  $("#breplay").addEventListener("click", () => startPlayback(passage().start));
  $("#bnext").addEventListener("click", submitTrial);
}

/** Move to B and back, counting the crossings. */
function holdB(on) {
  const b = S.blind;
  if (!b || b.holding === on) return;
  b.holding = on;
  const t = b.order[b.idx];
  applyVariant(S.active, (on ? t.b : t.a).vi);
  if (on) b.switches++;
  $("#abA")?.classList.toggle("live", !on);
  $("#abB")?.classList.toggle("live", on);
  $("#abhold")?.classList.toggle("down", on);
  refreshTrialState();
}

async function submitTrial() {
  const b = S.blind;
  const t = b.order[b.idx];
  const vs = S.rendered.passages[S.active].variants;
  holdB(false);
  $$("#btrial [data-text]").forEach(el => {
    const val = el.value.trim();
    if (val) b.responses[el.dataset.text] = val;
  });
  await post("/api/trial", {
    session: b.session, trial: b.idx,
    condition: vs[t.a.vi].label, condition_b: vs[t.b.vi].label,
    params: vs[t.a.vi].params, params_b: vs[t.b.vi].params,
    identity: t.a.vi === t.b.vi,
    responses: b.responses, blind: true, switches: b.switches,
    seconds: (performance.now() - b.t0) / 1000, presentation_index: t.a.vi,
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

  // Space holds B during a trial. It types a space inside the description box,
  // so a focused field keeps it; the on-screen button covers that case.
  addEventListener("keydown", e => {
    if (!S.blind || e.code !== "Space" || e.repeat) return;
    if (e.target?.matches?.("input, select, textarea")) return;
    if ($("#sheet").classList.contains("on") || Tour.active) return;
    e.preventDefault(); holdB(true);
  });
  addEventListener("keyup", e => {
    if (S.blind && e.code === "Space") { e.preventDefault(); holdB(false); }
  });
  addEventListener("blur", () => { if (S.blind?.holding) holdB(false); });
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
      el: '.tab[data-tab="blind"]',
      title: "Blind test",
      body: `Holds two variants at once with their labels hidden, one on the
        space bar and one on release, and writes responses to disk. This page
        is what turns listening into data.`,
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
        that wander instead of taking part in it.
        <br><br>Two lattices are available. A <b>polar</b> one is concentric
        rings; a <b>grid</b> is a rectangle of sources spanning an extent in
        metres. Rotation, radial flow and drift combine freely on either, so a
        whirlpool is one polar lattice turning while flowing inward, and driving
        through a field of sources is a grid with a backward drift.
        <br><br>Components can be copied and pasted between variants, so two
        variants can share one exactly.`,
    },
    {
      el: () => $(".ringbar select"),
      title: "Component presets",
      body: `The menu offers starting points on either lattice: a turning ring,
        concentric rings closing in or opening out, a whirlpool, and grids
        drifting past the listener. Each sets a few numbers and leaves
        everything editable.`,
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

function blindTour() {
  return [
    {
      el: '.tab[data-tab="blind"]',
      title: "Blind testing",
      body: `Listening while knowing which condition is playing is exploration
        rather than evidence. This page hides the labels, shuffles what is
        presented, and records responses as they are made.`,
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
      el: "#brepeats",
      title: "A trial is a pair",
      body: `Each trial holds two variants at once: one sounds while the space
        bar is held, the other while it is released, and the passage loops
        until the listener moves on. This is the comparison the bench is built
        around, for the same reason. Memory for spatial quality fades within
        seconds, so two renders heard in succession is a weaker test than
        moving between them.`,
    },
    {
      el: "#bidentity",
      title: "Catch trials",
      body: `A catch trial pairs a variant with itself, so the two sides are
        the same render and the correct answer is that nothing differs. How
        often a difference gets reported anyway measures how much of the rest
        is expectation. Nothing distinguishes it from a real trial.`,
    },
    {
      el: "#btrial",
      title: "The questions",
      body: `Because a trial holds two conditions, the items ask which of the
        two rather than how much of a quality. Free description comes first, so
        the fixed items do not supply the words it is written in. Which side
        moved more is asked separately from which was harder to point at, since
        those are the two properties the question holds apart. Direction is not
        asked at all: the head model cannot tell front from back, so it is not
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
  S.cursor = clamp(S.cursor || 0, 0, S.duration);

  // Passages belong to the track they were cut from. Carried onto a shorter
  // file they point past its end, and then the waveform looks empty, the
  // transport has nothing to play and no passage can be selected: every
  // symptom of a broken track, on a track that is fine.
  const kept = [];
  for (const p of S.passages) {
    const a = clamp(p.start, 0, S.duration);
    const b = clamp(p.end, 0, S.duration);
    if (b - a >= 1) { p.start = a; p.end = b; kept.push(p); }
  }
  const dropped = S.passages.length - kept.length;
  S.passages = kept;
  S.active = Math.max(0, Math.min(S.active, kept.length - 1));

  S.rendered = null; S.dryBuffer = null; S.buffers = {}; S.live = null;
  stopPlayback(); stopPreview();
  syncSel(); drawWave(); renderPassages(); showMetrics(); markStale();
  if (dropped) {
    $("#renderstate").textContent =
      `${dropped} passage${dropped > 1 ? "s" : ""} fell outside this track and ` +
      `${dropped > 1 ? "were" : "was"} removed.`;
  }
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

  $("#gtstop").addEventListener("click", () => { stopPreview(); stopPlayback(); });
  $("#gtbench").addEventListener("click", () => showTab("bench"));

  $("#selplay").addEventListener("click", () => previewSelection(S.cursor ?? S.sel[0], false));
  $("#selloop").addEventListener("click", () => previewSelection(S.sel[0], true));
  $("#selstop").addEventListener("click", () => { stopPreview(); drawWave(); });

  if (tracks.length) {
    await loadTrack(tracks[0].name);
    // Opens on sustained material, which decorrelates far more readily than
    // percussive material and is the better starting stimulus.
    // Sustained material decorrelates far more readily than percussive
    // material, so the default runs from the theremin section up to the guitar
    // entry rather than sampling a few seconds of it.
    // Sustained material from the theremin section up to where the drums
    // return, which is the longest stretch of the track without hard onsets.
    S.sel = [Math.min(141, Math.max(0, S.duration - 10)), Math.min(185, S.duration)];
    S.cursor = S.sel[0];
    S.passages = [newPassage(S.sel[0], S.sel[1], "Passage 1")];
    syncSel(); renderPassages(); drawWave();
  }

  const qp = new URLSearchParams(location.search);
  if (qp.get("mode") === "test") enterParticipantMode(qp);

  requestAnimationFrame(tick);
}

boot();
