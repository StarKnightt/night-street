import * as THREE from 'three';

/* Direction-dependent haze.
 *
 * Three.js fog is a single colour applied by distance alone, which is correct
 * for an overcast afternoon and wrong for a low sun. At golden hour the air is
 * a forward-scattering medium: looking toward the sun you are looking along
 * the beam and the haze between you and the far end of the street glows, goes
 * milky and eats contrast, while the same air behind you is nearly clear and
 * noticeably cooler. It is one of the strongest depth cues the hour has, and
 * it is free — it only needs the fog colour to depend on view direction rather
 * than being a constant.
 *
 * Patching the fog chunk globally is the right level for this. Every material
 * in the scene already includes it, so there is nothing to remember to wire up
 * per material, and the alternative — an onBeforeCompile on each — would have
 * to be repeated on the road, the footway, the kerb, the castings and the
 * plates and would drift out of step the first time one of them changed.
 */
export function installHaze(sunDir: THREE.Vector3,
                            near: THREE.Color, sunward: THREE.Color) {
  const S = THREE.ShaderChunk;
  if ((S as unknown as Record<string, unknown>).__hazeInstalled) return;
  (S as unknown as Record<string, unknown>).__hazeInstalled = true;

  /* Compiled in as constants rather than supplied as uniforms, and that is a
   * bug fix rather than a micro-optimisation.
   *
   * The previous version declared uHazeSun and uHazeSunColor as uniforms and
   * published them by adding entries to THREE.UniformsLib.fog. That never
   * worked. ShaderLib is built at three's module scope — every entry in it has
   * already merged and cloned UniformsLib.fog by the time anything in this
   * project has had a chance to run — so mutating the library afterwards has no
   * effect on any material that will ever be created. Both uniforms were
   * therefore declared in the shader and never assigned, which in GL means
   * zero: the sun direction was the zero vector, dot(view, sun) was zero, the
   * forward-scattering lobe was zero everywhere, and the haze was the
   * away-from-sun colour in every direction including straight down the beam.
   * The entire directional effect this file exists to produce has been inert
   * for its whole life, which is exactly the "cool grey milk in the sun
   * direction" in the report.
   *
   * The hour is fixed at build time, so neither value needs to be a uniform at
   * all. Baking them removes the failure mode instead of repairing it. */
  const v3 = (c: THREE.Vector3 | THREE.Color, x: 'x' | 'r', y: 'y' | 'g', z: 'z' | 'b') =>
    `vec3(${(c as unknown as Record<string, number>)[x].toFixed(6)}, ` +
    `${(c as unknown as Record<string, number>)[y].toFixed(6)}, ` +
    `${(c as unknown as Record<string, number>)[z].toFixed(6)})`;

  const SUN = v3(sunDir, 'x', 'y', 'z');
  const SUNC = v3(sunward, 'r', 'g', 'b');

  /* The haze colour has to *be* the sky, not an approximation of it.
   *
   * This is the root cause of the hard-edged orange rectangles. Aerial
   * perspective works by an object's radiance converging on the radiance of the
   * air in front of it, and the air in front of a distant object is lit by, and
   * eventually indistinguishable from, the sky in that direction. So at full
   * optical depth an object must land on exactly the sky colour along that ray —
   * at which point its silhouette vanishes, which is what "lost in the haze"
   * physically means.
   *
   * The previous version interpolated between two sampled colours, the sunward
   * and anti-sunward horizon. That is a two-point approximation of a dome with a
   * strong vertical gradient and a twenty-degree halo in it, and it is wrong
   * almost everywhere. A distant backdrop block therefore converged not on the
   * sky behind it but on a different colour, so however far away it was its
   * outline stayed visible — and because those blocks are literally rectangular
   * boxes, and because at that distance the fog factor has saturated so their
   * whole face is one flat value, the result is a perfectly straight-edged flat
   * orange rectangle standing against a mauve sky. Nothing about it is
   * screen-space or a UV bound; it is a building that failed to disappear.
   *
   * The sky here is a closed-form function of direction with no texture and no
   * noise in it, so the fix is to evaluate the same function. Ported term for
   * term from skyRadiance in env.ts, minus the solar disc: the disc belongs to
   * the directional light and to what the camera sees directly, and painting it
   * into the fog would put a second sun on the face of any building that
   * happened to stand in front of the real one.
   *
   * It also answers the second half of the complaint. The glow was "a flat
   * plateau of orange rather than a bright core falling off" because a mix of
   * two constants has no angular structure at all. Evaluating the dome gives it
   * the halo, the vertical gradient and the azimuthal wedge for free.
   */
  const SKY = /* glsl */ `
vec3 hazeSky( vec3 dir ) {
  float up = dir.y;
  vec2 fz = dir.xz;
  float azW = pow( max( 0.0, 0.5 + 0.5 * (
    dot( fz, uHazeSun.xz ) /
    max( 1e-4, length( fz ) * length( uHazeSun.xz ) ) ) ), 4.6 );

  const vec3 zenith      = vec3( 0.0850, 0.1300, 0.3600 );
  const vec3 upperWarm   = vec3( 0.7400, 0.3900, 0.3450 );
  const vec3 horizonSun  = vec3( 3.4000, 1.4200, 0.4200 );
  const vec3 horizonAway = vec3( 0.2000, 0.2000, 0.3100 );

  float band = pow( max( 0.0, 1.0 - max( up, 0.0 ) ), 5.6 );
  float mid  = pow( max( 0.0, 1.0 - max( up, 0.0 ) ), 2.30 );

  vec3 horizonC = mix( horizonAway, horizonSun, azW );
  vec3 base = mix( zenith, upperWarm, mid * ( 0.14 + 0.86 * azW ) );
  vec3 col = mix( base, horizonC, band );

  float ang = acos( clamp( dot( dir, uHazeSun ), -1.0, 1.0 ) );
  float halo = exp( -ang * 5.6 ) * 0.45 + exp( -ang * 19.0 ) * 5.60;
  col += halo * vec3( 1.60, 0.86, 0.34 );

  if ( up < 0.0 ) {
    float d = min( 1.0, -up * 1.15 );
    vec3 gnd = col * vec3( 0.52, 0.50, 0.54 ) + vec3( 0.030, 0.024, 0.026 );
    col = mix( col, gnd, d * 0.85 );
  }
  return col;
}
`;

  S.fog_pars_fragment = `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vHazeWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  const vec3 uHazeSun = ${SUN};
  const vec3 uHazeSunColor = ${SUNC};
${SKY}
#endif
`;

  S.fog_fragment = `
#ifdef USE_FOG
  /* Path length along the ray, not depth along the view axis, and this is the
   * cause of every straight terminator left in the set.
   *
   * three's fog chunk measures -mvPosition.z: the distance to the camera *plane*,
   * not to the camera. For anything near the centre of frame the two agree, which
   * is why this has never shown up down the street. They diverge without limit
   * towards the edges, and the apron is exactly the geometry that lives there —
   * a filler plane extending three hundred and twenty metres sideways. A point on
   * it far out to the right but only sixty metres up the street has a planar
   * depth of sixty metres, so it received the fog of something sixty metres away
   * while actually being three hundred metres off. It therefore kept its own dark
   * albedo instead of being extinguished, and where it ran out you saw it run
   * out: a straight horizontal edge with dark void beneath.
   *
   * Confirmed rather than assumed. Hiding the apron removes the dark region
   * entirely; scaling it four times removes the edge and leaves smooth hazed
   * ground. Both diagnostics are in shots/inert.
   *
   * Radial distance is also simply the right quantity — extinction depends on how
   * far the light actually travelled, not on its component along one axis — so
   * this is a correctness fix that happens to remove an artifact. */
  float hazeDist = length( vHazeWorld - cameraPosition );
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * hazeDist * hazeDist );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, hazeDist );
  #endif

  /* Forward scattering. The lobe is deliberately broad: a narrow one puts a
   * hard-edged glowing disc in the haze that reads as a lens artifact rather
   * than as air, and the real effect is a wide wash that covers most of the
   * sun-facing half of the view. */
  vec3 vDir = normalize( vHazeWorld - cameraPosition );
  float mu = clamp( dot( vDir, uHazeSun ), -1.0, 1.0 );
  float forward = pow( max( mu, 0.0 ), 2.2 );   // matches the sky's azimuthal falloff

  /* The air in front of this fragment, lit by the sky it is looking into. Equal
   * to the background along the same ray, so a fully hazed object disappears
   * instead of leaving an outline.
   *
   * Put through the tone curve and the output encode before it is mixed, and
   * this is the actual bug behind the rectangle.
   *
   * three includes fog_fragment *after* tonemapping_fragment and
   * colorspace_fragment, so by the time this code runs gl_FragColor is no longer
   * scene radiance — it has been through AgX and encoded to sRGB, and it lives in
   * nought-to-one display space. Mixing a linear radiance into it is a category
   * error. hazeSky returns 3.4 at the sunward horizon, which as a display value
   * clamps to 1.0 in red, so at full fog factor the fragment was being assigned
   * pure clipped red-orange with no tone curve applied to it at all: measured on
   * the previous frame the slab came back 0.83, 0.42, 0.37 against a sky of 0.55,
   * 0.43, 0.42 — half a unit of red out, in the one channel that had overflowed.
   *
   * Everything the review described follows from that one line. The haze could
   * not match the sky, because the sky is the same function tone-mapped and this
   * was not, so distant geometry kept a hard silhouette however thick the air
   * got. It clamped, so it had no shape — "a flat plateau of orange rather than a
   * bright core falling off" is precisely what a clipped channel looks like. And
   * the objects it happens to land on are untextured backdrop blocks, so the
   * plateau arrives with straight edges and right-angled corners.
   *
   * It also explains the 0.27 scale factor this file used to carry on
   * fogSunColor, and why that number had to be found by eye: it was compensating
   * for a missing tone curve. With the transform applied the scale factor is not
   * needed and the sunward haze is simply the sky.
   */
  vec3 hazeLin = hazeSky( vDir );
  #if defined( TONE_MAPPING )
    hazeLin = toneMapping( hazeLin );
  #endif
  vec3 haze = linearToOutputTexel( vec4( hazeLin, 1.0 ) ).rgb;

  /* Almost all of the haze lives in the sun-ward direction.
   *
   * The base density is now low enough that looking away from the sun the air
   * is essentially clear and the near-field road keeps every bit of its
   * texture — a uniform density high enough to look like golden hour when
   * facing the sun was milky everywhere and flattened the material work into
   * fog. The asymmetry does the job instead: this multiplies the depth term by
   * up to five looking down the beam and by nothing at all looking away. */
  fogFactor = clamp( fogFactor * ( 1.0 + forward * 2.4 ), 0.0, 1.0 );

  /* Aerial perspective has to actually complete, and this is the other half of
   * the hard-edged rectangle.
   *
   * Making the haze equal the sky is necessary but not sufficient: an object only
   * disappears into the sky if the fog factor reaches one, and an exponential
   * never does. Measured on the frame the review objected to, the backdrop blocks
   * closing the far end sit around eighty metres out, where FogExp2 at this
   * density returns 0.34 and the forward lobe carries it to about 0.89. The
   * missing eleven per cent is the artifact: those blocks are flat untextured
   * slabs presented nearly square to a low sun, so their own colour is bright
   * enough to clip, and one part in nine of a clipping white is still far above
   * the mauve sky at that elevation. Uniform slab, uniform residue, straight
   * edges — a card. That it is worst toward the sun is why raising the exposure
   * and making the directional term live exposed it now.
   *
   * A hundred and sixty metres of urban air with a four-degree sun in it is
   * opaque; there is no honest reading in which it is eleven per cent clear. So
   * the residual transmittance is closed out over the last stretch. It is a
   * statement about long range only — by sixty metres nothing has changed, so the
   * near and middle field, where all the material work lives, is untouched. */
  fogFactor = mix( fogFactor, 1.0, pow( smoothstep( 60.0, 165.0, hazeDist ), 1.6 ) );

  gl_FragColor.rgb = mix( gl_FragColor.rgb, haze, fogFactor );
#endif
`;

  // vHazeWorld is not a standard varying in every material, so the fog
  // vertex chunk publishes one.
  S.fog_pars_vertex = `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vHazeWorld;
#endif
`;
  S.fog_vertex = `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vHazeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif
`;

  void near;
}
