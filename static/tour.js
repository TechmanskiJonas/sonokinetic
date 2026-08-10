/* Guided tours.
 *
 * A spotlight over one element with a popover beside it. Written directly
 * rather than vendored so the step contract can carry what this interface
 * needs: steps that prepare state, steps that wait on a condition before Next
 * enables, and steps that let clicks through so the user performs the action
 * themselves.
 *
 * Step fields:
 *   el       selector or function returning an element; omit to centre
 *   title    heading
 *   body     HTML
 *   before   async fn run on entering the step
 *   revert   fn run when leaving via Back, to undo what the step did
 *   until    fn polled ~4x/sec; Next stays disabled until it returns true
 *   hint     text shown while until is unsatisfied ("Drag on the waveform…")
 *   interact when true the page stays clickable so the user can act
 *
 * Clicking outside never ends a tour; End tour and Esc do.
 */

const Tour = (() => {
  let steps = [], at = -1, active = false, waiting = null;

  const el = {};
  function build() {
    if (el.root) return;
    el.root = document.createElement("div");
    el.root.className = "tour";
    el.root.innerHTML = `
      <div class="tour-mask"><div class="tour-hole"></div></div>
      <div class="tour-pop">
        <div class="tour-step"></div>
        <h3 class="tour-title"></h3>
        <div class="tour-body"></div>
        <div class="tour-wait" hidden></div>
        <div class="tour-foot">
          <button class="sm ghost tour-end">End tour</button>
          <span class="grow"></span>
          <button class="sm tour-prev">Back</button>
          <button class="primary tour-next">Next</button>
        </div>
      </div>`;
    document.body.appendChild(el.root);
    el.mask = el.root.querySelector(".tour-mask");
    el.hole = el.root.querySelector(".tour-hole");
    el.pop = el.root.querySelector(".tour-pop");
    el.title = el.root.querySelector(".tour-title");
    el.body = el.root.querySelector(".tour-body");
    el.step = el.root.querySelector(".tour-step");
    el.wait = el.root.querySelector(".tour-wait");
    el.next = el.root.querySelector(".tour-next");
    el.prev = el.root.querySelector(".tour-prev");

    el.next.addEventListener("click", () => go(at + 1));
    el.prev.addEventListener("click", back);
    el.root.querySelector(".tour-end").addEventListener("click", end);
    addEventListener("keydown", onKey, true);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(); }
    else if (e.key === "ArrowRight" && !el.next.disabled) { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowLeft" && at > 0) { e.preventDefault(); back(); }
  }

  function target() {
    const s = steps[at];
    if (!s || !s.el) return null;
    return typeof s.el === "function" ? s.el() : document.querySelector(s.el);
  }

  function position() {
    if (!active) return;
    const node = target();
    const pad = 6;
    if (!node) {
      el.hole.style.cssText = "width:0;height:0;left:50%;top:50%";
      el.pop.style.left = `calc(50% - ${el.pop.offsetWidth / 2}px)`;
      el.pop.style.top = `calc(50% - ${el.pop.offsetHeight / 2}px)`;
      return;
    }
    const r = node.getBoundingClientRect();
    el.hole.style.left = (r.left - pad) + "px";
    el.hole.style.top = (r.top - pad) + "px";
    el.hole.style.width = (r.width + pad * 2) + "px";
    el.hole.style.height = (r.height + pad * 2) + "px";

    const pw = el.pop.offsetWidth, ph = el.pop.offsetHeight;
    let top = r.bottom + 14, left = r.left;
    if (top + ph > innerHeight - 10) {
      top = r.top - ph - 14;
      if (top < 10) {
        top = Math.min(Math.max(10, r.top), innerHeight - ph - 10);
        left = r.right + 14 + pw > innerWidth - 10 ? r.left - pw - 14 : r.right + 14;
      }
    }
    el.pop.style.left = Math.min(Math.max(10, left), innerWidth - pw - 10) + "px";
    el.pop.style.top = Math.min(Math.max(10, top), innerHeight - ph - 10) + "px";
  }

  /** Re-measure continuously: renders finish, panels redraw, and the page can
   *  scroll under an interactive step, all of which move the anchor. */
  function follow() {
    if (!active) return;
    position();
    requestAnimationFrame(follow);
  }

  function clearWait() {
    if (waiting) { clearInterval(waiting); waiting = null; }
    el.wait.hidden = true;
    el.next.disabled = false;
  }

  async function go(i) {
    if (i < 0) return;
    if (i >= steps.length) return end();
    clearWait();
    at = i;
    const s = steps[at];

    el.root.classList.toggle("interact", !!s.interact);
    if (s.before) { try { await s.before(); } catch (_) { } }
    await new Promise(r => setTimeout(r, s.settle ?? 60));

    el.step.textContent = `Step ${at + 1} of ${steps.length}`;
    el.title.textContent = s.title;
    el.body.innerHTML = s.body;
    el.prev.disabled = at === 0;
    el.next.textContent = at === steps.length - 1 ? "Done" : "Next";

    target()?.scrollIntoView({ block: "center" });
    position();

    if (s.until && !s.until()) {
      el.next.disabled = true;
      el.wait.hidden = false;
      el.wait.textContent = s.hint || "Complete the step to continue.";
      waiting = setInterval(() => { if (s.until()) clearWait(); }, 250);
    }
  }

  function back() {
    if (at <= 0) return;
    const s = steps[at];
    if (s.revert) { try { s.revert(); } catch (_) { } }
    go(at - 1);
  }

  function start(list) {
    build();
    steps = list;
    active = true;
    el.root.classList.add("on");
    go(0);
    requestAnimationFrame(follow);
  }

  function end() {
    clearWait();
    active = false;
    at = -1;
    el.root?.classList.remove("on");
  }

  return { start, end, get active() { return active; } };
})();
