#!/usr/bin/env bash
# After the 6L ensemble run: same recipe for the 3-layer CPU student.
export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8
until grep -qE "done in|Traceback" distill_v3_6L_ens.log 2>/dev/null; do sleep 30; done
.venv/Scripts/python.exe train/distill.py --teacher runs/v3-base/best runs/v2/best --student-init runs/v2-3L/best --out runs/v3-3L-ens > distill_v3_3L_ens.log 2>&1
echo DONE
