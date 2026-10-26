from attentionos_media.timemap import TimeMap, to_frame


def test_frame_quantisation_matches_javascript_round():
    # floor(x * fps + 0.5): 0.05 s at 30 fps is 1.5 frames -> 2 (JS Math.round), not banker's rounding.
    assert to_frame(0.05, 30) == 2
    assert to_frame(0.35, 30) == 11  # 10.5 exactly: JS rounds up, Python's round() would give 10
    assert to_frame(1.1, 30) == 33
    assert to_frame(0.0, 30) == 0


def test_round_trip_source_output():
    tm = TimeMap.from_keep_ranges([(0.0, 1.0), (2.0, 3.0), (4.5, 5.0)], 30, 6.0)
    assert tm.output_frames == 30 + 30 + 15
    for k in tm.keeps:
        for f in range(k.src_start, k.src_end):
            out = tm.src_to_out(f)
            assert out is not None
            assert tm.out_to_src(out) == f
    assert tm.src_to_out(45) is None  # inside the first cut (1.0–2.0 s)
    assert tm.src_to_out_snap(45) == 30  # playback resumes at output frame 30


def test_merges_overlapping_and_adjacent_ranges_and_clamps():
    tm = TimeMap.from_keep_ranges([(1.0, 2.0), (0.5, 1.2), (2.0, 2.5), (5.8, 9.0)], 30, 6.0)
    assert [(k.src_start, k.src_end) for k in tm.keeps] == [(15, 75), (174, 180)]
    assert tm.output_frames == 66


def test_empty_and_degenerate():
    tm = TimeMap.from_keep_ranges([], 30, 5.0)
    assert tm.output_frames == 0
    assert tm.output_range_to_source(0, 10) == []
    tm2 = TimeMap.from_keep_ranges([(1.0, 1.0), (2.0, 1.5)], 30, 5.0)
    assert tm2.keeps == []


def test_source_range_spanning_a_cut_maps_to_two_output_ranges():
    tm = TimeMap.from_keep_ranges([(0.0, 1.0), (2.0, 3.0)], 30, 3.0)
    assert tm.source_range_to_output(20, 70) == [(20, 30), (30, 40)]
    assert tm.output_range_to_source(25, 35) == [(25, 30), (60, 65)]


def test_words_map_to_output_and_cut_words_vanish():
    tm = TimeMap.from_keep_ranges([(0.0, 1.0), (2.0, 3.0)], 30, 3.0)
    assert tm.map_word(2.1, 2.4) == (1.1, 1.4)
    assert tm.map_word(1.2, 1.8) is None
    start, end = tm.map_word(0.9, 2.2)  # straddles the cut: first and last kept frame
    assert start == 0.9 and abs(end - 1.2) < 1e-9


def test_pauses_are_compared_in_one_time_base():
    """The ported bug: a pause found in source time must be mapped before it is compared with output times."""
    tm = TimeMap.from_keep_ranges([(0.0, 2.0), (3.0, 6.0)], 30, 6.0)
    source_pause = (4.0, 4.4)  # a pause in the second keep range (source seconds)
    out_spans = tm.source_range_to_output(to_frame(source_pause[0], 30), to_frame(source_pause[1], 30))
    assert out_spans == [(90, 102)]  # 3.0–3.4 s of output, not 4.0–4.4
    beat_output = (2.9, 3.6)  # an output-time beat
    a, b = to_frame(beat_output[0], 30), to_frame(beat_output[1], 30)
    assert any(s < b and e > a for s, e in out_spans)
    naive = to_frame(source_pause[0], 30) < b and to_frame(source_pause[1], 30) > a
    assert naive is False  # the old comparison would have missed the overlap


def test_joins():
    tm = TimeMap.from_keep_ranges([(0.0, 1.0), (2.0, 3.0), (4.0, 4.5)], 30, 5.0)
    assert tm.joins_output_frames() == [30, 60]
