import numpy as np
from evaluate import out_of_fold
from train import LABELS


def test_a_message_label_never_moves_its_own_decision():
    rng = np.random.default_rng(1)
    Y = rng.integers(0, 2, (150, len(LABELS)))
    P = np.clip(0.4 * Y + 0.6 * rng.random(Y.shape), 0, 1)
    D, fits = out_of_fold(Y, P)
    assert D.shape == Y.shape and len(fits) == 5
    for j in (0, 77):
        Y2 = Y.copy()
        Y2[j] = 1 - Y2[j]
        assert (out_of_fold(Y2, P)[0][j] == D[j]).all()
