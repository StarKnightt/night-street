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
# The four sideways stops stand in front of a named unit rather than on the
# walk line, which is why they carry a walker override. The positions come off
# the old reports: shop at the lit unit on the west row (street3.ts, z -26),
# shut/part at the part-raised unit on the east row (z -30). shut/down had no
# recoverable position at all and was reconstructed on the part camera, which
# framed no shutter of any kind; it is now aimed at the fully shuttered west
# unit at z -12.5 — chosen over the one at -47 because a parked car stands in
# front of that one, and over -85 because the haze at that range is the
# subject of a different stop.
AT() { echo "s.goTo=(t)=>{s.walker.x=$1;s.walker.z=$2;s.walker.warp(0.1)}"; }
$S "$T-shop"  --t 0.4 --yaw 1.5708 --pitch 0.06 --fov 70 --name door  --noTilt --js "$(AT -3.2 -26.1)"
$S "$T-shop"  --t 0.4 --yaw 1.5708 --pitch 0.17 --fov 55 --name store --noTilt --keep --js "$(AT -3.2 -26.1)"
$S "$T-shut"  --t 0.4 --yaw -1.5708 --pitch 0.14 --fov 62 --name part --noTilt --js "$(AT 3.2 -30.0)"
$S "$T-shut"  --t 0.4 --yaw 1.5708 --pitch 0.14 --fov 62 --name down --noTilt --keep --js "$(AT -3.2 -12.5)"
$S "$T-pair"  --t 0.55 --yaw -0.55 --fov 70 --noTilt --name 55
$S "$T-face"  --t 0.4 --yaw 1.15 --pitch 0.22 --noTilt --name 40
$S "$T-sun"   --t 0.3 --yaw 0.42 --fov 58 --noTilt --name 30
$S "$T-walk"  --t 0.4 --yaw 1.15 --pitch -0.3 --noTilt --name 40

# System 4's two stops, at the distances a parked car is actually looked at:
# four metres for the stance and the tail, two and a half for the paint and the
# glass. Both stand off the walk line for the same reason the shop stops do.
$S "$T-car"   --t 0.4 --yaw 0.30 --pitch -0.13 --fov 55 --name hero  --noTilt --js "$(AT 0.9 -38.6)"
$S "$T-car"   --t 0.4 --yaw 0.62 --pitch 0.02  --fov 34 --name glass --noTilt --keep --js "$(AT 1.4 -43.5)"
