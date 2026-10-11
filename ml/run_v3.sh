#!/usr/bin/env bash
# v3 scaling experiment: same data (teacher 42k + silver + silver2 + synth + public), small vs base.
set -x
export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8
COMMON="--epochs 4 --silver data/silver.jsonl data/silver2.jsonl --public data/public.jsonl data/public_extra.jsonl --public-ratio 1.0 --public-w 0.3 --synth-repeat 2"
.venv/Scripts/python.exe train/train.py --out runs/v3-small $COMMON > train_v3_small.log 2>&1
.venv/Scripts/python.exe train/train.py --base jhu-clsp/mmBERT-base --lr 3e-5 --out runs/v3-base $COMMON > train_v3_base.log 2>&1
echo DONE
