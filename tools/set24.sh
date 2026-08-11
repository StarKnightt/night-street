#!/usr/bin/env bash
# The established capture set, as one command.
#
# Eleven invocations of shoot.mjs produce the twenty-four frames the project is
# reviewed on, and the flags for each of them lived only in shell history. That
# is how a review round gets spent re-deriving a field of view from a report
# file. Pass the tag: ./tools/set24.sh sys4a
set -e
T="$1"
S="node tools/shoot.mjs"

$S "$T"                                                                   # 7: 02 20 40 60 80 95 tilt
$S "$T-up"    --t 0.15,0.4,0.72 --pitch 0.62 --noTilt                     # 3
$S "$T-split" --t 0.78,0.88 --pitch 0.2 --fov 62 --noTilt                 # 2
$S "$T-lit"   --t 0.4,0.86 --yaw -1.15 --pitch 0.22 --noTilt              # 2
$S "$T-near"  --t 0.4 --pitch -0.5 --noTilt                               # 1: 40
$S "$T-near"  --t 0.4 --pitch -0.5 --fov 8 --name crop --noTilt --keep    # 1: crop
$S "$T-shop"  --t 0.4 --yaw 1.5708 --pitch 0.06 --fov 70 --name door --noTilt
$S "$T-shop"  --t 0.4 --yaw 1.5708 --pitch 0.17 --fov 55 --name store --noTilt --keep
$S "$T-shut"  --t 0.4 --yaw -1.5708 --pitch 0.14 --fov 62 --name part --noTilt
$S "$T-shut"  --t 0.3 --yaw -1.5708 --pitch 0.14 --fov 62 --name down --noTilt --keep
$S "$T-pair"  --t 0.55 --yaw -0.55 --fov 70 --noTilt --name 55
$S "$T-face"  --t 0.4 --yaw 1.15 --pitch 0.22 --noTilt --name 40
$S "$T-sun"   --t 0.3 --yaw 0.42 --fov 58 --noTilt --name 30
$S "$T-walk"  --t 0.4 --yaw 1.15 --pitch -0.3 --noTilt --name 40
