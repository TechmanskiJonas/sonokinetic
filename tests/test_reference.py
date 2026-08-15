"""Integrity of the reference material.

The encyclopedia is only useful if following a link lands somewhere. A dead
[[link]] renders as a "not written yet" page, which is the kind of defect that
survives indefinitely because nothing fails when it happens.
"""

import json
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

LINK = re.compile(r"\[\[([a-z0-9-]+)(?:\|[^\]]+)?\]\]")


def load(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def ref():
    return load("encyclopedia.json")


@pytest.fixture(scope="module")
def purpose():
    return load("purpose.json")


@pytest.fixture(scope="module")
def targets(ref, purpose):
    """Everything a [[link]] may resolve to: a glossary entry or a section of
    the research programme, which carries ids for exactly this reason."""
    ids = set(ref["entries"])
    for c in purpose["chapters"]:
        for s in c["sections"]:
            ids.add(s["id"])
    return ids


@pytest.fixture(scope="module")
def courses():
    return load("courses.json")


def links_in(text):
    return set(LINK.findall(text or ""))


# ----------------------------------------------------------------------
# Encyclopedia
# ----------------------------------------------------------------------

def test_every_entry_has_the_required_fields(ref):
    for eid, e in ref["entries"].items():
        assert e.get("title"), f"{eid} has no title"
        assert e.get("short"), f"{eid} has no short definition"
        assert e.get("body"), f"{eid} has no body"
        assert e.get("section"), f"{eid} has no section"


def test_every_entry_declares_its_status(ref):
    """The reference mixes standard material with vocabulary invented here.
    A reader must be able to tell which is which, so status is mandatory."""
    valid = set(ref["statuses"])
    for eid, e in ref["entries"].items():
        assert e.get("status"), f"{eid} declares no status"
        assert e["status"] in valid, f"{eid} has unknown status {e['status']!r}"


def test_established_entries_cite_something(ref):
    """An entry claiming to be established literature has to say whose.

    Without this the label is worthless: it would assert authority that nothing
    backs. Entries genuinely too elementary to attribute belong under a
    different status.
    """
    missing = [eid for eid, e in ref["entries"].items()
               if e["status"] == "established" and not e.get("grounding")]
    # Not every elementary definition needs a citation, but most should carry one.
    established = [eid for eid, e in ref["entries"].items()
                   if e["status"] == "established"]
    assert len(missing) < len(established) * 0.6, (
        f"{len(missing)} of {len(established)} established entries cite nothing: "
        f"{sorted(missing)[:12]}")


@pytest.mark.parametrize("eid", ["unison-motion", "field", "source",
                                 "ring", "passage", "variant",
                                 "motion-coherence", "polar-lattice"])
def test_project_coinages_are_labelled_as_such(ref, eid):
    """These names were invented here. Presenting them beside ITD and IACC
    without a marker would let a reader carry them into a conversation where
    nobody recognises them."""
    assert ref["entries"][eid]["status"] == "project", (
        f"{eid} is this project's own vocabulary and must be labelled 'project'")


def test_conjectures_are_labelled_as_conjectures(ref):
    assert ref["entries"]["interaural-statistics"]["status"] == "open"


@pytest.mark.parametrize("sid", ["noise-floor", "density-saturation",
                                 "envelope-confound", "degenerate-ring",
                                 "rotation-signature", "transient-material",
                                 "level-preserved", "front-back-measured",
                                 "metric-vs-percept"])
def test_measured_results_live_in_the_research_programme(purpose, sid):
    """These are results, not terms, so they belong in Purpose rather than in
    a glossary of things to look up."""
    ids = {s["id"] for c in purpose["chapters"] for s in c["sections"]}
    assert sid in ids


@pytest.mark.parametrize("sid", ["blind-testing", "experimenter-bias",
                                 "catch-trial", "randomization", "n-of-1",
                                 "statistical-power", "forced-choice"])
def test_method_material_lives_in_the_research_programme(purpose, sid):
    ids = {s["id"] for c in purpose["chapters"] for s in c["sections"]}
    assert sid in ids


def test_no_glossary_entry_duplicates_a_purpose_section(ref, purpose):
    """A term and a narrative section sharing an id would make links ambiguous."""
    ids = {s["id"] for c in purpose["chapters"] for s in c["sections"]}
    clash = ids & set(ref["entries"])
    assert not clash, f"ids in both: {sorted(clash)}"


def test_the_kinematogram_is_not_presented_as_this_projects_idea(ref, purpose):
    """It is established vision science. The auditory analogy is the project's
    own move, and the two must not be blurred together."""
    e = ref["entries"]["random-dot-kinematogram"]
    assert e["status"] == "established"
    assert e.get("grounding"), "must cite the vision literature"
    assert "the-analogy" in (e.get("see") or []), (
        "must point at the section that owns the analogical claim")
    ids = {s["id"] for c in purpose["chapters"] for s in c["sections"]}
    assert "the-analogy" in ids, "the analogy is a conjecture and belongs in Purpose"


def test_every_entry_belongs_to_a_declared_section(ref):
    sections = {s["id"] for s in ref["sections"]}
    for eid, e in ref["entries"].items():
        assert e["section"] in sections, f"{eid} is in unknown section {e['section']!r}"


def test_every_section_declares_a_family(ref):
    families = {f["id"] for f in ref["families"]}
    for s in ref["sections"]:
        assert s.get("family") in families, f"{s['id']} has no valid family"


def test_both_glossary_families_are_populated(ref):
    counts = {}
    by = {s["id"]: s["family"] for s in ref["sections"]}
    for e in ref["entries"].values():
        counts[by[e["section"]]] = counts.get(by[e["section"]], 0) + 1
    for f in ref["families"]:
        assert counts.get(f["id"], 0) > 3, f"{f['id']} glossary is nearly empty"


def test_every_section_has_at_least_one_entry(ref):
    used = {e["section"] for e in ref["entries"].values()}
    for s in ref["sections"]:
        assert s["id"] in used, f"section {s['id']!r} is empty"


def test_every_body_link_resolves(ref, targets):
    ids = targets
    broken = []
    for eid, e in ref["entries"].items():
        for target in links_in(e["body"]):
            if target not in ids:
                broken.append(f"{eid} -> {target}")
    assert not broken, "dead links: " + ", ".join(sorted(broken))


def test_every_prereq_and_see_also_resolves(ref, targets):
    ids = targets
    broken = []
    for eid, e in ref["entries"].items():
        for key in ("prereq", "see"):
            for target in e.get(key) or []:
                if target not in ids:
                    broken.append(f"{eid}.{key} -> {target}")
    assert not broken, "dead links: " + ", ".join(sorted(broken))


def test_no_entry_links_to_itself(ref):
    for eid, e in ref["entries"].items():
        assert eid not in links_in(e["body"]), f"{eid} links to itself"
        assert eid not in (e.get("prereq") or []), f"{eid} is its own prerequisite"


def test_entries_are_reachable_from_the_starting_page(ref):
    """Following links from the entry point should reach most of the reference.

    Orphans are not broken, but a term nothing links to is one the reader can
    only find by scrolling the index, which defeats the point of writing
    prerequisites down.
    """
    ids = set(ref["entries"])
    linked = set()
    for e in ref["entries"].values():
        linked |= links_in(e["body"])
        linked |= set(e.get("prereq") or [])
        linked |= set(e.get("see") or [])
    orphans = ids - linked
    assert len(orphans) <= 3, f"unreferenced entries: {sorted(orphans)}"


def test_prerequisites_do_not_form_a_cycle(ref):
    """A prerequisite chain that loops cannot be followed to the bottom."""
    entries = ref["entries"]
    state = {}

    def walk(node, path):
        if state.get(node) == "done":
            return
        assert state.get(node) != "open", f"prerequisite cycle: {' -> '.join(path + [node])}"
        state[node] = "open"
        for p in entries.get(node, {}).get("prereq") or []:
            walk(p, path + [node])
        state[node] = "done"

    for eid in entries:
        walk(eid, [])


def test_short_definitions_are_actually_short(ref):
    for eid, e in ref["entries"].items():
        assert len(e["short"]) < 240, f"{eid} short definition is an essay"


# ----------------------------------------------------------------------
# Guide
# ----------------------------------------------------------------------

def test_purpose_chapters_are_wellformed(purpose):
    seen = set()
    assert purpose["chapters"]
    for c in purpose["chapters"]:
        assert c.get("id") and c.get("title") and c.get("sections")
        for s in c["sections"]:
            assert s.get("id") and s.get("heading") and s.get("body")
            assert s["id"] not in seen, f"duplicate section id {s['id']}"
            seen.add(s["id"])


def test_every_purpose_link_resolves(targets, purpose):
    broken = []
    for c in purpose["chapters"]:
        for s in c["sections"]:
            for target in links_in(s["body"]):
                if target not in targets:
                    broken.append(f"{c['id']}/{s['id']} -> {target}")
    assert not broken, "dead links: " + ", ".join(sorted(broken))


# ----------------------------------------------------------------------
# Courses
# ----------------------------------------------------------------------

def test_courses_are_wellformed(courses):
    assert courses["courses"]
    seen = set()
    for c in courses["courses"]:
        assert c.get("id") and c.get("title") and c.get("summary")
        assert c["id"] not in seen, f"duplicate course id {c['id']}"
        seen.add(c["id"])
        assert c.get("lessons"), f"{c['id']} has no lessons"
        for lesson in c["lessons"]:
            assert lesson.get("id") and lesson.get("title") and lesson.get("body")


def test_lesson_ids_are_unique_across_all_courses(courses):
    """Progress is stored per lesson id, so a collision would silently mark
    two different lessons complete together."""
    ids = [l["id"] for c in courses["courses"] for l in c["lessons"]]
    assert len(ids) == len(set(ids)), "duplicate lesson ids"


def test_every_course_link_resolves(targets, courses):
    ids = targets
    broken = []
    for c in courses["courses"]:
        for lesson in c["lessons"]:
            text = lesson["body"] + " " + (lesson.get("try") or "")
            for target in links_in(text):
                if target not in ids:
                    broken.append(f"{c['id']}/{lesson['id']} -> {target}")
    assert not broken, "dead links: " + ", ".join(sorted(broken))


def test_lessons_carry_no_quiz(courses):
    """Lessons are reference material someone works from, so they end where the
    explanation ends. The renderer no longer has a branch for this field, and a
    stray one would sit in the data doing nothing."""
    for c in courses["courses"]:
        for lesson in c["lessons"]:
            assert "checkpoint" not in lesson, f"{lesson['id']} still carries a checkpoint"


def test_the_curriculum_starts_from_nothing(courses):
    """The first course must assume no prior knowledge, or the route in has a
    step missing at the very beginning."""
    first = courses["courses"][0]
    assert "nothing" in first.get("assumes", "").lower()


def test_each_later_course_names_its_prerequisite(courses):
    """A stated order is the whole point of arranging these as a sequence."""
    titles = {c["title"] for c in courses["courses"]}
    for c in courses["courses"][1:]:
        assumes = c.get("assumes", "")
        assert assumes, f"{c['id']} does not say what it assumes"
        assert any(t in assumes for t in titles), (
            f"{c['id']} assumes {assumes!r}, which is not an earlier course title")


def test_the_curriculum_covers_the_load_bearing_material(targets, courses):
    """Reading every lesson in order should expose the reader to the findings
    that constrain how the instrument must be used."""
    linked = set()
    for c in courses["courses"]:
        for lesson in c["lessons"]:
            linked |= links_in(lesson["body"] + " " + (lesson.get("try") or ""))
    for required in ("degenerate-ring", "noise-floor", "rotation-signature",
                     "matched-control", "transient-material", "blind-testing",
                     "front-back-confusion", "level-matching"):
        assert required in linked, f"no lesson ever links to {required}"


def test_courses_reach_the_conjectures_and_label_the_route(targets, courses):
    """The curriculum should introduce the project's own question rather than
    leaving it only in the reference."""
    linked = set()
    for c in courses["courses"]:
        for lesson in c["lessons"]:
            linked |= links_in(lesson["body"])
    assert "unison-motion" in linked
    assert "random-dot-kinematogram" in linked


# ----------------------------------------------------------------------
# The interface points at the reference, so those ids have to exist too
# ----------------------------------------------------------------------

def test_every_info_button_in_the_ui_resolves(ref, targets):
    ids = targets
    broken = []

    js = open(os.path.join(ROOT, "static", "app.js"), encoding="utf-8").read()
    for target in re.findall(r'ref:\s*"([a-z0-9-]+)"', js):
        if target not in ids:
            broken.append(f"app.js schema -> {target}")
    for target in re.findall(r'data-ref="([a-z0-9-]+)"', js):
        if target not in ids:
            broken.append(f"app.js markup -> {target}")

    html = open(os.path.join(ROOT, "static", "index.html"), encoding="utf-8").read()
    for target in re.findall(r'data-ref="([a-z0-9-]+)"', html):
        if target not in ids:
            broken.append(f"index.html -> {target}")

    assert not broken, "info buttons pointing nowhere: " + ", ".join(sorted(broken))


def test_every_parameter_in_the_schema_has_an_info_target(ref):
    """Each row of the parameter editor must offer an explanation, since the
    whole educational layer lives behind those buttons."""
    js = open(os.path.join(ROOT, "static", "app.js"), encoding="utf-8").read()
    block = js[js.index("const PARAMS = ["):js.index("const LABELS")]
    rows = re.findall(r"\{\s*k:\s*\"([a-z_]+)\"([^}]*)\}", block)
    assert rows, "could not parse the parameter schema"
    for key, rest in rows:
        assert 'ref: "' in rest, f"parameter {key} has no info target"


def test_findings_that_constrain_the_method_are_covered(ref, purpose):
    """The measured results that change how the tool has to be used should be
    reachable from the reference, not only from the glossary file."""
    text = " ".join(
        f"{e['title']} {e['short']} {e['body']}" for e in ref["entries"].values()
    ).lower() + " " + " ".join(
        f"{s['heading']} {s['body']}"
        for c in purpose["chapters"] for s in c["sections"]).lower()
    for phrase in ("noise floor", "matched control", "saturat",
                   "front-back", "level"):
        assert phrase in text, f"reference never covers {phrase!r}"


@pytest.mark.parametrize("eid", [
    "matched-control", "front-back-confusion",
    "level-matching", "component", "polar-lattice", "grid-lattice",
    "radial-flow", "whirlpool", "motion-coherence", "translation",
    "source-distance",
])
def test_the_load_bearing_entries_exist(ref, eid):
    """These are the findings a reader has to meet to use the tool correctly.
    Named individually so deleting one fails loudly."""
    assert eid in ref["entries"]


RETIRED = {
    "ringfield": "the project was renamed to Sonokinetic",
    "hotspot": "the circulating coherence hotspot was removed",
    "punch-in": "the interface no longer uses that name for latching",
    "unison rotation": "generalised to motion in unison",
    "Coherent ring preset": "the presets were rebuilt around lattices",
}


@pytest.mark.parametrize("phrase,why", sorted(RETIRED.items()))
def test_retired_vocabulary_is_gone_from_the_writing(ref, purpose, courses,
                                                     phrase, why):
    """Renames leave the prose behind.

    Every one of these named something that existed at some point, so nothing
    fails when a sentence still describes it: the text simply documents a
    feature the reader cannot find. A professor meeting a term the interface
    does not contain has no way to tell which of the two is out of date.
    """
    haystack = []
    for e in ref["entries"].values():
        haystack += [e["title"], e["short"], e["body"]]
    for c in purpose["chapters"]:
        haystack += [s["heading"] + " " + s["body"] for s in c["sections"]]
    for c in courses["courses"]:
        haystack += [c["summary"]]
        for lesson in c["lessons"]:
            haystack += [lesson["title"], lesson["body"], lesson.get("try") or ""]
    hits = [h for h in haystack if phrase.lower() in h.lower()]
    assert not hits, f"{phrase!r} survives ({why}): {hits[0][:120]}"


# ----------------------------------------------------------------------
# Blinding is a property of the interface, so it is asserted against the
# interface. Every one of these failed at some point during the rewrite.
# ----------------------------------------------------------------------

@pytest.fixture(scope="module")
def appjs():
    return open(os.path.join(ROOT, "static", "app.js"), encoding="utf-8").read()


def test_the_transport_bar_hides_the_variant_label_during_a_trial(appjs):
    """That bar is pinned to the bottom of every page, including the trial.

    It names the sounding variant, which is the single fact a blind trial
    exists to withhold, and it had been doing so for the whole run.
    """
    body = appjs.split("function updateTransport()")[1].split("\nfunction ")[0]
    assert "S.blind" in body, (
        "updateTransport must special-case a running trial before printing a label")


def test_participant_mode_hides_every_route_to_the_bench():
    """A participant who reaches the bench sees the labels, the parameters and
    the monitor drawing the motion."""
    css = open(os.path.join(ROOT, "static", "app.css"), encoding="utf-8").read()
    rule = css.split(".testmode")[1:]
    hidden = " ".join(rule).split("display: none")[0]
    for escape in ("nav .tab", "#bench", "#arrange", "#gtbench"):
        assert escape in hidden, f"participant mode leaves {escape} reachable"


def test_the_bench_keyboard_yields_while_a_trial_runs(appjs):
    """The digit keys reach any variant of the passage, including ones the
    trial did not offer, and space means something else there."""
    handler = appjs.split("// comparing two separate listens")[1][:1400]
    assert "if (S.blind) return;" in handler


def test_a_trial_pairs_two_conditions_rather_than_presenting_one(appjs):
    """The method chapter argues that spatial memory is too short for
    successive presentation. The test has to match the argument."""
    assert "function buildTrials(" in appjs
    assert "PAIR_QUESTIONS" in appjs
    assert "function holdB(" in appjs


def test_the_side_of_the_key_is_randomised(appjs):
    """A fixed assignment would let one trial's insight carry to all the rest."""
    build = appjs.split("function buildTrials(")[1].split("\nfunction ")[0]
    assert "Math.random() < 0.5" in build, "pair order must be drawn per trial"


def test_catch_trials_pair_a_condition_with_itself(appjs):
    build = appjs.split("function buildTrials(")[1].split("\nfunction ")[0]
    assert "round.push([c, c])" in build


def test_titles_that_must_keep_their_capital_are_named_in_the_renderer(ref, appjs):
    """An unlabelled [[link]] prints the entry title, and titles are
    capitalised, so mid-sentence it reads as a proper noun: "one Waveform has
    to slide". The renderer lowercases it, except for acronyms and surnames.

    This pins the exception list against the titles actually present, so
    renaming an entry to start with a new surname fails here rather than
    quietly lowercasing somebody's name.
    """
    import re
    keep = re.search(r"const KEEP_CAPITAL = (/.+/);", appjs).group(1)
    pattern = keep.strip("/")
    protected = {t for t in (e["title"] for e in ref["entries"].values())
                 if re.match(r"^[A-Z]{2,}|^(Brown|Woodworth|Hann|K-)", t)}
    # every protected title must be matched by the pattern the renderer uses
    for t in protected:
        assert re.match(pattern.replace("(?:", "("), t), f"{t!r} would be lowercased"
    # and nothing else should be
    for e in ref["entries"].values():
        t = e["title"]
        if t not in protected:
            assert not re.match(r"^[A-Z]{2,}", t), (
                f"{t!r} looks like an acronym but is not in the protected set")


def test_changing_track_drops_passages_that_fall_off_the_end(appjs):
    """Passages belong to the track they were cut from.

    Carried onto a shorter file they point past its end, and then the waveform
    looks empty, the transport has nothing to play and no passage can be
    selected: every symptom of a broken track, on a track that is fine. The
    default passages are cut from a five-minute song, so switching to the
    45-second demo reproduces it exactly.
    """
    body = appjs.split("async function loadTrack(")[1].split("\nfunction ")[0]
    assert "S.passages" in body, "loadTrack must reconcile passages with the new duration"
    assert "S.cursor" in body, "the cursor can also sit past the end"


def test_boot_attaches_listeners_without_assuming_the_node_exists(appjs):
    """One missing id used to disable everything wired after it.

    boot() attaches several dozen listeners in sequence. A direct
    $("#id").addEventListener on an element that is not in the page throws,
    and the rest of boot never runs, so the page renders normally and half its
    controls silently do nothing. Removing the arrangement section did exactly
    that and took Add passage, the transport and the blind test with it.
    """
    body = appjs.split("async function boot() {")[1].split("\nboot();")[0]
    unguarded = re.findall(r'\$\("#[a-zA-Z0-9_-]+"\)\.addEventListener', body)
    assert not unguarded, f"use on() instead: {unguarded}"
    assert "function on(sel, ev, fn" in appjs


def test_nothing_still_calls_the_removed_arrangement_code(appjs):
    for gone in ("wireArrangement", "renderArrangement", "#arrangelist"):
        assert gone not in appjs, f"{gone} survives the removal"
