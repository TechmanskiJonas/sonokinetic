"""Tests for per-segment timeline emission.

The readout is only worth having if it cannot disagree with the audio. These
check the mapping from source position to output position, which is where that
guarantee actually lives: whenever segments get cropped and concatenated the
two diverge, and a readout derived from the wrong one is silently wrong.
"""

import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ringfield as rf
from sweep import make_test_signal

FS = 44100


@pytest.fixture(scope="module")
def hrtf():
    return rf.AnalyticHRTF(fs=FS)


@pytest.fixture(scope="module")
def track():
    mono = make_test_signal(FS, 12.0)
    stereo = np.stack([mono, np.roll(mono, 64)], axis=-1)
    return mono, stereo


def spin(start, end, **kw):
    dur = max(end - start, 1e-6)
    cfg = rf.FieldConfig(n_sources=kw.pop("n", 3),
                         rotation_deg_per_sec=kw.pop("degrees", 360) / dur, **kw)
    return rf.Segment(start, end, cfg, fade=0.1)


def dry(start, end):
    return rf.Segment(start, end, None, fade=0.1)


# ----------------------------------------------------------------------
# render_timeline: output position equals source position
# ----------------------------------------------------------------------

def test_render_timeline_returns_audio_and_timeline(hrtf, track):
    mono, stereo = track
    segs = [dry(0, 3), spin(3, 7), dry(7, 10)]
    y, tl = rf.render_timeline(mono, stereo, hrtf, segs, FS)
    assert y.shape[1] == 2
    assert len(tl) == 3
    assert [e.kind for e in tl] == ["dry", "spin", "dry"]


def test_render_timeline_positions_are_identity(hrtf, track):
    """Treatments sit at absolute song positions, so nothing is remapped."""
    mono, stereo = track
    segs = [dry(0, 3), spin(3, 7)]
    _, tl = rf.render_timeline(mono, stereo, hrtf, segs, FS)
    for e in tl:
        assert e.out_start == e.src_start
        assert e.out_end == e.src_end


def test_spin_segments_carry_their_full_parameter_set(hrtf, track):
    mono, stereo = track
    segs = [spin(0, 4, n=5, degrees=720)]
    _, tl = rf.render_timeline(mono, stereo, hrtf, segs, FS)
    p = tl[0].params
    assert p["n_sources"] == 5
    assert p["rotation_deg_per_sec"] == pytest.approx(180.0)
    assert len(p["resolved_azimuths"]) == 5
    assert p["resolved_decorr"]["family"] == "velvet"


def test_dry_segments_carry_no_parameters(hrtf, track):
    mono, stereo = track
    _, tl = rf.render_timeline(mono, stereo, hrtf, [dry(0, 4)], FS)
    assert tl[0].params is None


# ----------------------------------------------------------------------
# render_blocks: segments are remapped onto the concatenated output
# ----------------------------------------------------------------------

def test_render_blocks_emits_one_entry_per_segment_not_per_block(hrtf, track):
    """Reporting one entry per block would hide the parameter changes inside
    it, which are exactly what a block is built to compare."""
    mono, stereo = track
    blocks = [
        ("A", [dry(2, 4), spin(4, 6), dry(6, 8)]),
        ("B", [dry(2, 4), spin(4, 6, n=5), dry(6, 8)]),
    ]
    _, tl = rf.render_blocks(mono, stereo, hrtf, blocks, FS, gap=0.5)
    assert len(tl) == 6
    assert sorted(set(e.group for e in tl)) == ["A", "B"]


def test_render_blocks_output_positions_are_shifted_but_source_is_not(hrtf, track):
    """The second block covers the same source passage as the first, so source
    times repeat while output times keep advancing. Getting this backwards is
    the failure the readout is most exposed to."""
    mono, stereo = track
    blocks = [
        ("A", [dry(2, 4), spin(4, 6)]),
        ("B", [dry(2, 4), spin(4, 6, n=5)]),
    ]
    _, tl = rf.render_blocks(mono, stereo, hrtf, blocks, FS, gap=0.5)
    a = [e for e in tl if e.group == "A"]
    b = [e for e in tl if e.group == "B"]

    assert [e.src_start for e in a] == [e.src_start for e in b]
    assert a[0].out_start == pytest.approx(0.0, abs=1e-6)
    assert b[0].out_start > a[-1].out_end
    # gap of 0.5s between blocks
    assert b[0].out_start - a[-1].out_end == pytest.approx(0.5, abs=0.02)


def test_render_blocks_entries_stay_inside_the_rendered_audio(hrtf, track):
    mono, stereo = track
    blocks = [("A", [dry(2, 4), spin(4, 6)]), ("B", [spin(4, 8, n=5)])]
    y, tl = rf.render_blocks(mono, stereo, hrtf, blocks, FS, gap=1.0)
    dur = len(y) / FS
    for e in tl:
        assert 0 <= e.out_start < e.out_end <= dur + 1e-6


def test_render_blocks_entries_do_not_overlap(hrtf, track):
    mono, stereo = track
    blocks = [("A", [dry(2, 4), spin(4, 6)]), ("B", [dry(2, 4), spin(4, 6)])]
    _, tl = rf.render_blocks(mono, stereo, hrtf, blocks, FS, gap=0.5)
    ordered = sorted(tl, key=lambda e: e.out_start)
    for prev, nxt in zip(ordered, ordered[1:]):
        assert nxt.out_start >= prev.out_end - 1e-6


# ----------------------------------------------------------------------
# render_sequence
# ----------------------------------------------------------------------

def test_render_sequence_repeats_one_passage_under_different_treatments(hrtf, track):
    mono, stereo = track
    takes = [
        rf.Take(3, 6, None, label="dry"),
        rf.Take(3, 6, rf.FieldConfig(n_sources=3), label="spin 3"),
        rf.Take(3, 6, rf.FieldConfig(n_sources=5), label="spin 5"),
    ]
    y, tl = rf.render_sequence(mono, stereo, hrtf, takes, FS, gap=0.4)
    assert [e.label for e in tl] == ["dry", "spin 3", "spin 5"]
    assert all(e.src_start == 3 and e.src_end == 6 for e in tl)
    assert tl[0].out_start < tl[1].out_start < tl[2].out_start
    assert tl[1].out_start - tl[0].out_end == pytest.approx(0.4, abs=0.02)


def test_sequence_durations_match_the_source_spans(hrtf, track):
    mono, stereo = track
    takes = [rf.Take(2, 5, None), rf.Take(6, 9, rf.FieldConfig(n_sources=3))]
    _, tl = rf.render_sequence(mono, stereo, hrtf, takes, FS)
    for e in tl:
        assert (e.out_end - e.out_start) == pytest.approx(e.src_end - e.src_start,
                                                          abs=0.02)


# ----------------------------------------------------------------------
# Serialization and export
# ----------------------------------------------------------------------

def test_timeline_is_json_serializable(hrtf, track):
    mono, stereo = track
    _, tl = rf.render_timeline(mono, stereo, hrtf, [dry(0, 2), spin(2, 5)], FS)
    blob = json.dumps(rf.timeline_dict(tl, FS))
    back = json.loads(blob)
    assert back["segments"][1]["params"]["n_sources"] == 3


def test_trace_is_attached_only_when_asked(hrtf, track):
    mono, stereo = track
    segs = [spin(0, 3)]
    _, plain = rf.render_timeline(mono, stereo, hrtf, segs, FS)
    _, traced = rf.render_timeline(mono, stereo, hrtf, segs, FS, with_trace=True)
    assert plain[0].trace is None
    assert traced[0].trace and len(traced[0].trace) > 5


def test_srt_covers_every_segment_in_order(hrtf, track):
    mono, stereo = track
    _, tl = rf.render_timeline(mono, stereo, hrtf,
                               [dry(0, 2), spin(2, 5), dry(5, 7)], FS)
    srt = rf.timeline_srt(tl)
    assert srt.count("-->") == 3
    assert srt.strip().startswith("1\n")
    assert "00:00:02,000 --> 00:00:05,000" in srt


def test_srt_timestamps_are_wellformed():
    assert rf._srt_time(0) == "00:00:00,000"
    assert rf._srt_time(3661.5) == "01:01:01,500"
    assert rf._srt_time(-1) == "00:00:00,000"



def test_group_timeline_buckets_in_order(hrtf, track):
    mono, stereo = track
    blocks = [("A", [dry(2, 4), spin(4, 6)]), ("B", [spin(4, 6)])]
    _, tl = rf.render_blocks(mono, stereo, hrtf, blocks, FS, gap=0.3)
    grouped = rf.group_timeline(tl)
    assert list(grouped) == ["A", "B"]
    assert len(grouped["A"]) == 2 and len(grouped["B"]) == 1


def test_save_timeline_and_srt_write_readable_files(hrtf, track, tmp_path):
    mono, stereo = track
    y, tl = rf.render_timeline(mono, stereo, hrtf, [dry(0, 2), spin(2, 5)], FS)
    j, s = tmp_path / "t.json", tmp_path / "t.srt"
    rf.save_timeline(str(j), tl, FS, duration=len(y) / FS)
    rf.save_srt(str(s), tl)
    assert json.loads(j.read_text())["duration"] == pytest.approx(len(y) / FS)
    assert "-->" in s.read_text()
