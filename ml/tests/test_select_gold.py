from select_gold import QUOTAS, select


def row(text, **t):
    return {"text": text, "t": {lab: t.get(lab, 0.0) for lab, _, _ in QUOTAS}}


def test_fill_weights_stand_for_every_candidate_no_quota_took():
    rows = [row("plain 0"), row("you are trash", toxic=0.9), row("what game?", question=0.9)]
    rows += [row(f"plain {i}") for i in range(1, 10)]
    picked = select(rows, 6)
    quota, fill = picked[:2], picked[2:]
    assert [(r["text"], r["stratum"], r["w"]) for r in quota] == [("you are trash", "toxic", 1.0),
                                                                   ("what game?", "question", 1.0)]
    assert [r["text"] for r in fill] == ["plain 0", "plain 1", "plain 2", "plain 3"]
    assert {r["stratum"] for r in fill} == {"random"}
    assert sum(r["w"] for r in fill) == 10  # 4 random picks stand for the 10 plain candidates
