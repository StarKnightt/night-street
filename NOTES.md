# Deferred work

Items that have been diagnosed and deliberately left for a later pass. Nothing
here is a bug report against the current build; each is owned by a pass that has
not run yet.

The technique brief for Systems 5, 6 and 8 — lighting, atmosphere and
post-processing — lives at `docs/TECHNIQUE.md`. Read it before starting any of
the three.

## Post-processing / colour grade pass owns

- **Road hue and saturation.** The matrix sits at about 3 degrees red with a
  saturation of 0.23, where real asphalt measures 0.05–0.12. The sunlit
  carriageway reads at luminance ~0.30 and saturation ~0.35; the targets are
  luminance ~0.18, saturation ~0.15, and the hue pulled off pure orange toward
  neutral-warm. Note for whoever takes this: tinting the inter-chip cavities
  toward zenith blue was tried and made the saturation *worse*, because the chip
  scatter is sparse and leaves too few cavities to act on. That is a dead end —
  do not retry it.
- **Road centreline.** Now worn far enough that it reads as a crack rather than
  as paint; p99 along it is only 149. Over-corrected, pull it back.
- **Shaded ground balance.** Blue leads red by 18 counts. Plausible, but
  slightly cool — verify against reference before accepting.

## Later polish

- Window contrast on the far-distance backdrop blocks in `lit/86` is only 4–8
  luminance units, too ghostly to register as windows.
- The gutter grit band in `80.png` holds the brightest pixel in the lower frame
  at (250, 239, 226) as fuzzy white spray. It reads as noise rather than as
  debris.
- Flat rooflines with no parapet or clutter on the mid-distance dark masses, for
  example `pair/55.png` around x 700–890.
- The street's terminating wall in `tilt.png` is carried entirely by haze and
  has nothing on it if the haze thins.
- Faint 1 px vertical light streaks in the haze at the far end of `tilt.png`,
  probably surviving distant geometry edges.

## Deferred material work

- Chip embedding and the contact meniscus on the asphalt.
- Wheel tramline form.
- Voronoi crack distribution.
- Stucco spall relief.
- Shopfront glazing depth.

## The display response does not hold in the emissive path

`display = 0.284 * L^0.4545` is the curve every level in the project is
authored against, and System 5 found the edge of it. Inverting a target through
it works for a surface being lit. It does not work for a surface that *is* the
light, above about L = 1, because that is where the AgX shoulder starts and a
power law is the wrong shape for a shoulder.

Three points measured off `sys5a`, all emissive, all read as the median of the
lit face:

| authored L (peak channel) | curve predicts | measured |
|---|---|---|
| 1.22  | 132 | 184 |
| 3.75  | 132 | 223 |
| 10.85 | 214 | 234 |

The consequence is that emissives authored anywhere above L ≈ 1 all arrive
within about fifty 8-bit values of each other, and a level meant to be dull
arrives bright. It cost this system one capture round: the warming street lamps
were authored at 3.75 and came off disk as bright as the working ones, with the
right hue and the wrong level. `scene/lights.ts` now carries a measured
correction on that one constant and says so.

Anyone authoring a new emissive: put it in, shoot it, read the pixel, and
invert against the table above rather than against the formula. Two iterations
is normal; one is not enough, because the local slope up there is about 0.16
and not 0.45.
