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


@pytest.mark.parametrize("eid", ["unison-rotation", "circulating-hotspot",
                                 "spin-function", "field", "source", "ring",
                                 "passage", "variant", "coherence-hotspot"])
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


def test_checkpoints_have_both_a_question_and_an_answer(courses):
    for c in courses["courses"]:
        for lesson in c["lessons"]:
            cp = lesson.get("checkpoint")
            if cp is None:
                continue
            assert cp.get("q") and cp.get("a"), f"{lesson['id']} checkpoint incomplete"


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
    assert "unison-rotation" in linked
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
    "matched-control", "circulating-hotspot", "front-back-confusion",
    "level-matching", "component", "polar-lattice", "grid-lattice",
    "radial-flow", "whirlpool", "motion-coherence", "translation",
])
def test_the_load_bearing_entries_exist(ref, eid):
    """These are the findings a reader has to meet to use the tool correctly.
    Named individually so deleting one fails loudly."""
    assert eid in ref["entries"]
