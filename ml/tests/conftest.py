import sys
from pathlib import Path

ML = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ML / "train"), str(ML / "gold")]
