#!/usr/bin/env bash
# Does a better (wider) teacher make the same small students better?
set -x
export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8
P=.venv/Scripts/python.exe
$P train/distill.py --teacher runs/v3-base/best --student-init runs/v2-6L/best --out runs/v3-6L-base > distill_v3_6L_base.log 2>&1
$P train/distill.py --teacher runs/v3-base/best runs/v2/best --student-init runs/v2-6L/best --out runs/v3-6L-ens > distill_v3_6L_ens.log 2>&1
echo DONE
