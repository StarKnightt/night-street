import * as THREE from 'three';

/* Contact-hardening sun shadows, and why the stock filters cannot give them.
 *
 * The picket railing was printing on the carriageway as a perfectly even comb —
 * same stripe width, same contrast, from the kerb to the vanishing point. The
 * instinct is to add noise to the fence. That would be treating the symptom,
 * because a real picket shadow does not stay sharp: the sun is a disc about half
 * a degree wide, so every shadow edge carries a penumbra that widens in
 * proportion to how far the light has travelled since it passed the caster. A
 * picket shadow is crisp where it leaves the picket and has dissolved into an
 * even wash a few metres later. That single fact is the whole of the effect, and
 * it produces the variation, the softening and the loss of contrast for free.
 *
 * Neither of Three's directional filters can express it:
 *
 *   PCFShadowMap filters a fixed kernel measured in shadow-map texels. The
 *   frustum is fixed, so a texel is a fixed number of millimetres, so the
 *   penumbra is a constant width everywhere in the scene no matter how far a
 *   shadow has run from its caster. That is exactly the reported defect, and no
 *   value of shadowRadius fixes it — it only chooses which constant.
 *
 *   VSM blurs the depth distribution, which softens by a constant amount for the
 *   same reason, and leaks light through thin overlapping casters like a fire
 *   escape.
 *
 * So the filter has to know how far away the blocker is, which means reading the
 * depth rather than asking the hardware for a comparison. That is a blocker
 * search followed by a variable-width filter — percentage-closer soft shadows —
 * and it needs the raw sampler that SHADOWMAP_TYPE_BASIC uses, which is why the
 * renderer is set to BasicShadowMap and all of the filtering happens here.
 *
 * The geometry of this scene makes two details load-bearing rather than
 * optional.
 *
 * The first is the receiver-plane depth gradient. At a sun elevation of four
 * degrees the carriageway is within a few degrees of parallel to the light, so
 * depth along the light changes by about thirteen metres for every metre the
 * surface moves across it. Across a filter kernel that is deliberately tens of
 * centimetres wide that is an enormous depth change, and comparing every tap
 * against the depth at the kernel's centre would make the road shadow-test
 * against itself and go uniformly black. So the depth gradient of the receiver
 * is recovered from screen derivatives and each tap is compared against the
 * plane, not the point. Without this the whole approach fails on the one surface
 * it is meant to fix.
 *
 * The second is that the penumbra is computed in shadow-map UV space, which is
 * perpendicular to the light. A round penumbra there lands on the road as an
 * ellipse stretched by one over the sine of the sun elevation — about fourteen
 * to one. The dramatic smearing along the street therefore comes out of the
 * projection on its own and is not something that has to be authored.
 */

export interface SoftShadowConfig {
  /** Half-width of the shadow camera across the light, world units. */
  halfWidth: number;
  /** Shadow camera top and bottom, world units. */
  top: number;
  bottom: number;
  /** Shadow camera near and far planes. */
  near: number;
  far: number;
  /**
   * Angular diameter of the source in radians. The sun is 0.53 degrees; a
   * larger value is the correct way to express haze scattering the disc into a
   * softer source, and is the only honest knob on shadow softness here.
   */
  sourceAngle: number;
  /** Radius of the blocker search, world units perpendicular to the light. */
  searchRadius: number;
  /** Floor on the filter radius, world units. Keeps contact edges antialiased. */
  minRadius: number;
  /**
   * Ceiling on the filter radius for a *narrow* caster, world units. A thin
   * object far up the light ray is entitled to an enormous penumbra and must not
   * get one; see the note on the cap in getSunShadow.
   */
  tightRadius: number;
  /** Ceiling on the filter radius for a broad caster, world units. */
  maxRadius: number;
  blockerTaps: number;
  filterTaps: number;
}

export const SUN_SHADOW: SoftShadowConfig = {
  halfWidth: 22,
  top: 22,
  bottom: -4,
  near: 1,
  far: 150,
  /* Slightly over the sun's true 0.0093 rad. The disc is never seen naked
   * through twenty kilometres of horizon air — at four degrees elevation the
   * path length is long enough that the effective source is visibly larger than
   * the geometric disc, which is why low-sun shadows lose their edge faster
   * than the textbook number predicts. */
  sourceAngle: 0.0135,
  searchRadius: 0.55,
  minRadius: 0.010,
  tightRadius: 0.090,
  maxRadius: 1.150,
  blockerTaps: 12,
  filterTaps: 20,
};

let installed = false;

/* Where the Vogel disc's rotation comes from — and it is a temporal decision,
 * not a spatial one.
 *
 * A blocker search and a variable-width filter are Monte Carlo estimates: 12
 * and 20 taps of a disc that on this road is up to 1.15 m across. The estimate
 * carries a standard error, and rotating the tap pattern per pixel is what
 * turns that error from a visible ring pattern into a dither. The question
 * nobody asks is what the rotation should be a function of, and the default
 * answer — gl_FragCoord — is the one choice that is wrong for a moving camera:
 * a fragment's screen position changes with every step, so its phase, and
 * therefore its estimate, is redrawn from scratch every frame. Fully
 * decorrelated noise at the smallest camera movement is exactly the signature
 * the walk harness measured on the shadowed carriageway, and it is why that
 * patch was already saturated at 5.6 mm of travel while the facade beside it
 * grew with parallax the way real parallax does.
 *
 *   'screen'  gl_FragCoord — three's own convention, and what shipped
 *   'world'   the shadow-map UV, which is world space perpendicular to the
 *             light, so a point on the road keeps its phase as the camera
 *             walks past it and the residual error rides with the surface
 *   'onetap'  no filter at all, for attribution: if the shimmer survives this
 *             it is not coming from here
 *
 * Selected from the URL because the alternative is a rebuild per measurement,
 * and this file is patched into the shader chunks once at module load.
 */
export type ShadowPhase = 'screen' | 'world' | 'onetap';

export function shadowPhaseFromUrl(): ShadowPhase {
  if (typeof location === 'undefined') return 'world';
  if (location.search.includes('onetap')) return 'onetap';
  if (location.search.includes('phiscreen')) return 'screen';
  return 'world';
}

export function installSoftSunShadows(
  cfg: SoftShadowConfig = SUN_SHADOW,
  phase: ShadowPhase = shadowPhaseFromUrl(),
): void {
  if (installed) return;
  installed = true;

  const W = (cfg.halfWidth * 2).toFixed(4);
  const H = (cfg.top - cfg.bottom).toFixed(4);
  const RANGE = (cfg.far - cfg.near).toFixed(4);

  /* Cap on the recovered depth gradient.
   *
   * On the carriageway the true value is about 2.4 in depth-per-UV; a surface
   * more nearly edge-on to the light goes higher, and at a silhouette the
   * derivatives straddle two surfaces and the solve returns garbage. Clamping
   * costs a little acne resistance on extreme slopes and buys immunity to the
   * one case that would produce bright holes along every shadow edge. */
  const pcss = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0

  float sunIGN( vec2 p ) {
    return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
  }

  vec2 sunVogel( int i, int n, float phi ) {
    float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
    float theta = float( i ) * 2.39996323 + phi;
    return vec2( cos( theta ), sin( theta ) ) * r;
  }

  #define SUN_FRUSTUM_W ${W}
  #define SUN_FRUSTUM_H ${H}
  #define SUN_DEPTH_RANGE ${RANGE}
  #define SUN_SPREAD ${cfg.sourceAngle.toFixed(6)}
  #define SUN_SEARCH ${cfg.searchRadius.toFixed(4)}
  #define SUN_MIN_R ${cfg.minRadius.toFixed(4)}
  #define SUN_TIGHT_R ${cfg.tightRadius.toFixed(4)}
  #define SUN_MAX_R ${cfg.maxRadius.toFixed(4)}
  #define SUN_GRAD_MAX 9.0

  float getSunShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

    shadowCoord.xyz /= shadowCoord.w;

    if ( shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
         shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
         shadowCoord.z > 1.0 || shadowCoord.z < 0.0 ) return 1.0;

    vec2 uv = shadowCoord.xy;
    float z = shadowCoord.z;

    // Depth gradient of the receiving surface, in depth per unit UV. Recovered
    // by solving the 2x2 system relating screen derivatives of UV to screen
    // derivatives of depth.
    vec2 dUVdx = dFdx( uv ), dUVdy = dFdy( uv );
    float dzdx = dFdx( z ), dzdy = dFdy( z );
    float det = dUVdx.x * dUVdy.y - dUVdx.y * dUVdy.x;
    det = ( abs( det ) < 1e-11 ) ? ( det < 0.0 ? -1e-11 : 1e-11 ) : det;
    vec2 grad = vec2( dzdx * dUVdy.y - dzdy * dUVdx.y,
                      dzdy * dUVdx.x - dzdx * dUVdy.x ) / det;
    float gm = length( grad );
    if ( gm > SUN_GRAD_MAX ) grad *= SUN_GRAD_MAX / gm;

    #ifdef USE_REVERSED_DEPTH_BUFFER
      float zc = z - shadowBias;
    #else
      float zc = z + shadowBias;
    #endif

    /* The tap rotation's argument. See the note on ShadowPhase above: this is
     * the difference between a residual that sits still on the road and one
     * that is redrawn every frame.
     *
     * In world mode the argument is the shadow-map UV in texels, times eight.
     * Texels rather than anything else because that is the one grid this
     * function already has that is fixed to the world: the shadow camera is
     * texel-snapped as it follows, so a point on the road keeps its coordinate
     * to within a fraction of a texel as the camera walks. Times eight because
     * one rotation per texel is far too coarse — a shadow texel is 10.7 mm
     * across the light and, at four degrees, 146 mm along it, which is a
     * hundred screen pixels of near carriageway sharing one estimate, and a
     * hundred pixels sharing an error is a blotch rather than a dither. */
    float phi = sunIGN( ${phase === 'world' ? 'uv * shadowMapSize * 8.0' : 'gl_FragCoord.xy'} ) * PI2;

    // ---- blocker search ----------------------------------------------------
    vec2 sUV = vec2( SUN_SEARCH / SUN_FRUSTUM_W, SUN_SEARCH / SUN_FRUSTUM_H );
    float sum = 0.0, cnt = 0.0;
    for ( int i = 0; i < ${cfg.blockerTaps}; i ++ ) {
      vec2 o = sunVogel( i, ${cfg.blockerTaps}, phi ) * sUV;
      float d = texture2D( shadowMap, uv + o ).r;
      float zr = zc + dot( grad, o );
      #ifdef USE_REVERSED_DEPTH_BUFFER
        if ( d > zr ) { sum += d; cnt += 1.0; }
      #else
        if ( d < zr ) { sum += d; cnt += 1.0; }
      #endif
    }
    // Nothing between this fragment and the sun anywhere in the search disc, so
    // it is not merely lit but lit with no nearby edge to filter.
    if ( cnt < 0.5 ) return 1.0;

    float zBlocker = sum / cnt;

    /* Distance the light has travelled since it cleared the caster, in world
     * units. This is the quantity the whole filter exists to obtain, and it is
     * available only because the depth was read rather than compared. */
    #ifdef USE_REVERSED_DEPTH_BUFFER
      float sep = ( zBlocker - z ) * SUN_DEPTH_RANGE;
    #else
      float sep = ( z - zBlocker ) * SUN_DEPTH_RANGE;
    #endif
    sep = max( sep, 0.0 );

    /* Half-width of the penumbra a source of this angular size casts after
     * travelling that far. One multiply, and it is the entire effect. */
    float rIdeal = sep * SUN_SPREAD * 0.5;

    /* The cap, and why it is keyed to how much of the search disc was blocked.
     *
     * The arithmetic above is right and its consequences on the road were not.
     * At four degrees of elevation the light path from a parapet twelve metres up
     * to the carriageway is 12 / sin( 4.2 ) — about a hundred and sixty metres —
     * so rIdeal comes out over a metre and a fire-escape handrail thirty
     * millimetres thick is asked to cast a shadow three metres wide. Two things
     * then go wrong. The filter is sampling a three-metre disc with twenty taps,
     * which is far too few to integrate it, so the noise organises into the soft
     * circular blob the review found mid-carriageway. And even integrated
     * perfectly, a mark that wide with no umbra in it is no longer legible as a
     * shadow — it is a stain, and the review is right that there is a width past
     * which a viewer stops attributing it to a caster.
     *
     * A flat clamp would have fixed the blob and wrecked what is working: the
     * long soft shade line the buildings throw across the road is *also* at this
     * separation, and its softness is both correct and praised. The two cases are
     * not distinguishable by separation, but they are trivially distinguishable
     * by the size of the caster, and the blocker search has already measured
     * that. cnt / taps is the fraction of a disc 0.55 m across that is occluded:
     * near unity inside the shadow of a building, under a tenth for a handrail.
     *
     * So width has to be earned by bulk. A broad occluder keeps the full
     * physical penumbra; a thin one is held near the resolution floor, which
     * both removes the artifact and leaves its shadow narrow enough to trace back
     * to the thing that cast it. This is a sampling-budget decision honestly
     * labelled as one, not a claim about optics. */
    float occ = cnt / float( ${cfg.blockerTaps} );
    float cap = mix( SUN_TIGHT_R, SUN_MAX_R, smoothstep( 0.30, 0.85, occ ) );
    float rWorld = clamp( rIdeal, SUN_MIN_R, cap );
    vec2 rUV = vec2( rWorld / SUN_FRUSTUM_W, rWorld / SUN_FRUSTUM_H );

    float lit = 0.0;
    for ( int i = 0; i < ${phase === 'onetap' ? 1 : cfg.filterTaps}; i ++ ) {
      vec2 o = ${phase === 'onetap' ? 'vec2( 0.0 )' : `sunVogel( i, ${cfg.filterTaps}, phi ) * rUV`};
      float d = texture2D( shadowMap, uv + o ).r;
      float zr = zc + dot( grad, o );
      #ifdef USE_REVERSED_DEPTH_BUFFER
        lit += ( d > zr ) ? 0.0 : 1.0;
      #else
        lit += ( d < zr ) ? 0.0 : 1.0;
      #endif
    }
    lit /= float( ${phase === 'onetap' ? 1 : cfg.filterTaps} );

    return mix( 1.0, lit, shadowIntensity );
  }

#endif
`;

  /* Appended rather than substituted, and called by a new name.
   *
   * Rewriting Three's own getShadow would mean matching the exact text of a
   * preprocessor branch that changes between releases. Adding a function and
   * redirecting the one call site that matters depends only on two short
   * substrings, and if either ever stops matching this throws at startup
   * instead of silently reverting to hard shadows — which, given that a silent
   * capture failure has already cost this project a review round, is the
   * behaviour worth having.
   */
  const pars = 'shadowmap_pars_fragment';
  THREE.ShaderChunk[pars] = THREE.ShaderChunk[pars] + pcss;

  const begin = 'lights_fragment_begin';
  const call = 'getShadow( directionalShadowMap[ i ]';
  if (!THREE.ShaderChunk[begin].includes(call)) {
    throw new Error(
      'installSoftSunShadows: could not find the directional getShadow call in ' +
        `${begin}; three's shader chunks have changed shape and the soft shadow ` +
        'patch needs revisiting.',
    );
  }
  THREE.ShaderChunk[begin] = THREE.ShaderChunk[begin].replace(
    call,
    'getSunShadow( directionalShadowMap[ i ]',
  );
}
