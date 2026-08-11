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

# System 5's four stops. Every position below is derived rather than found:
# tools/sys5.ts runs the same pure layout the scene does and prints where the
# lanterns, the neon and the lit apertures actually are, so these frame the
# work without a discovery batch first.
#
#   lamp    lantern 3 (z -45, west, working) against the sky at 41 degrees up,
#           which is the hardest test in the set — an emissive bowl has to beat
#           a bright sky, and it is also how a street lamp at this hour is
#           actually seen: as a source with a corona, not as a pool.
#   cross   the pharmacy cross at (-5.24, 3.55, -52), the one cool source on
#           the shaded row, at the range its wash on the render is legible.
#   neon    the bar's projecting sign at (5.16, 3.95, -65.26) and the traffic
#           signal at z -61.6 in one frame, with lamp 4 — the warming one —
#           between them. The clock is pinned so the aspect is green rather
#           than whatever the settle time happened to leave it on.
#   spill   the pool from the store's aperture on the footway outside it, with
#           the kerb and the OPEN sign in the same frame. Pitched down, because
#           the spill is on the ground and the -shop stops both look up.
$S "$T-lamp"  --t 0.4 --yaw 0.372  --pitch 0.600 --fov 34 --name head  --noTilt --js "$(AT -1.0 -39.5)"
$S "$T-cross" --t 0.4 --yaw 0.585  --pitch 0.280 --fov 40 --name 52    --noTilt --js "$(AT -1.6 -46.5)"
$S "$T-neon"  --t 0.4 --yaw -0.188 --pitch 0.162 --fov 40 --name bar   --noTilt \
   --js "$(AT 3.0 -53.0); if(window.__sys5) window.__sys5.freeze(26)"
# And the signal from the lane it is addressed to, because a hooded aspect seen
# off its own axis is a crescent and there is no framing that reads both it and
# the bar sign, which faces across the road rather than along it.
$S "$T-neon"  --t 0.4 --yaw -0.042 --pitch 0.129 --fov 16 --name sig   --noTilt --keep \
   --js "$(AT 4.5 -52.0); if(window.__sys5) window.__sys5.freeze(26)"
$S "$T-spill" --t 0.4 --yaw 0.553  --pitch -0.223 --fov 55 --name store --noTilt --js "$(AT -2.6 -20.5)"

# System 6's five stops. Derived the same way System 5's were: tools/sys6.ts
# runs the same layoutBlock the scene runs, reconstructs the two shadow-boundary
# planes the sunward gaps sweep, checks that they reproduce block.ts's own stated
# sun bands (-48.7..-31.9 and -83.7..-72.9 against a prose -49..-32 and -84..-73)
# and prints the camera, the yaw and how many metres of lit air the centre ray
# crosses. Nothing here was found by shooting the street and looking.
#
#   shaft/road  the near boundary of the main wedge where it crosses the
#               carriageway, which runs (-3.15, -27.4) to (3.15, -36.4). That
#               diagonal is the only edge a shaft has in this canyon and the
#               whole argument against a raymarch rests on it existing.
#   shaft/edge  the same wedge seen across rather than along: from the east kerb
#               at z -26 to the shaded west frontage at -38, 8.7 m of lit air
#               against a dark wall. The wedge's best case, and the frame to
#               judge whether it reads as air or as a gradient.
#   mote/sun    straight into the sun, which from (-1, -28) leaves the canyon
#               through the cross-street gap. The centre ray crosses zero metres
#               of wedge — the view direction lies *in* the boundary planes, which
#               is the degenerate case the view gate exists for — so this stop
#               tests the forward lobe and the mote field and nothing else.
#   air/ladder  a 30-degree lens from the head of the walk: near kerb, mid block,
#               backdrop and the closeout in one frame. The height falloff and the
#               aerial perspective are both read here or nowhere.
#   air/away    the anti-sun view, where the old one-sided lobe left the air at
#               exactly the base density and the new phase function does not.
$S "$T-shaft" --t 0.245 --yaw -0.0715 --pitch -0.100 --fov 55 --name road  --noTilt
$S "$T-shaft" --t 0.4   --yaw 0.6051  --pitch 0.100  --fov 50 --name edge  --noTilt --keep \
   --js "$(AT 2.6 -26.0)"
$S "$T-mote"  --t 0.4   --yaw -0.6109 --pitch 0.0733 --fov 40 --name sun   --noTilt \
   --js "$(AT -1.0 -28.0)"
$S "$T-air"   --t 0.02  --yaw 0.0     --pitch 0.0    --fov 30 --name ladder --noTilt
$S "$T-air"   --t 0.6   --yaw 2.5307  --pitch 0.050  --fov 45 --name away   --noTilt --keep
