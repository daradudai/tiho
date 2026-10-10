import json

from train import load_unseen


def test_gold_texts_never_train_from_any_source(tmp_path):
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    a.write_text("\n".join(json.dumps({"text": t}) for t in ["KEKW  KEKW", "hello"]) + "\n", encoding="utf-8")
    b.write_text(json.dumps({"text": "KEKW KEKW\u200b"}) + "\n", encoding="utf-8")
    rows = load_unseen([str(a), str(b), ""], gold_texts={"KEKW KEKW"})
    assert [r["text"] for r in rows] == ["hello"]
