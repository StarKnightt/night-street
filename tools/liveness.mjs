/* The capture-time liveness assertion.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Three times now this tree has shipped a frame that looked plausible and was
 * wrong in the same way, and `NOTES.md` names two of them: a `uCam` uniform
 * written in `useFrame`, and a mote field that "sat 32 m behind the camera in
 * every capture ever reviewed". The third was the sun's shadow box, fixed by
 * `src/scene/sunFollow.ts` in 0a4f58b.
 *
 * The shape is always the same. Per-frame state is written from a `useFrame`
 * subscriber; a capture teleports the camera and draws inside one synchronous
 * `page.evaluate`, so no animation frame runs between the move and the draw;
 * the state therefore describes a camera that is not the camera being
 * rendered. Nothing throws, nothing logs, the frame is a picture of a
 * different viewpoint's lighting and it is reviewed as if it were this one.
 *
 * None of the three was caught by looking. Two were caught by an unrelated
 * measurement coming back at exactly zero, and one by someone reading a
 * position out of a debug dump. So the defence has to be an assertion that
 * runs on every capture, not a habit.
 *
 * ── What it asserts ───────────────────────────────────────────────────────
 *
 * That every enumerable piece of per-frame-driven placement agrees with the
 * camera the renderer actually drew with. Each check reports the values it
 * read and the world position they refer to, per NOTES.md's rule that a
 * statistic with no provenance is a statistic about an unknown place — a
 * check that says "FAIL" without saying where it looked is the same defect
 * one level up.
 *
 * ── What it deliberately does not do ──────────────────────────────────────
 *
 * It transcribes no constant. The shadow arrangement comes out of
 * `window.__sunFollow.residual()`, which derives it from the residuals the
 * hook *learned* off `Street.tsx`; the snap grid comes off the live shadow
 * camera; the camera comes off the render. Nothing here would go on reading
 * correct the day `SHADOW_HALF_W` changed.
 *
 * ── Escape hatch ──────────────────────────────────────────────────────────
 *
 * `window.__livenessOff = true` suppresses it, and `--nofollow` sets it
 * implicitly, because a tool whose whole purpose is to capture the bug must
 * be able to. Nothing else should switch it off.
 */

/* Page-side, as source text, because it is installed with `addInitScript`
 * before any page script runs and therefore cannot close over anything here. */
export const LIVENESS_SRC = `
window.__liveness = function liveness(label) {
  const out = { label: label || null, checks: [], failures: [] };
  if (window.__livenessOff) { out.skipped = true; return out; }

  const s = window.__scene;
  if (!s) { out.skipped = 'no __scene'; return out; }
  const cam = s.camera;
  const cp = [cam.position.x, cam.position.y, cam.position.z];
  const r3 = (v) => v.map((n) => +n.toFixed(4));
  out.camera = r3(cp);

  const add = (name, ok, detail) => {
    const row = { name: name, ok: !!ok, ...detail };
    out.checks.push(row);
    if (!ok) out.failures.push(row);
  };

  /* 1. The sun's shadow box, in texels of its own map.
   *
   * Tolerance is one texel, not zero: Street.tsx's follower and the hook snap
   * the same camera to the same grid, so they agree exactly, but a live frame
   * that arrived between the two can legitimately be one grid step out. Two
   * texels is 21 mm on a 44 m box; the failure this catches is 31 metres. */
  const sf = window.__sunFollow;
  if (!sf) {
    add('sun shadow box', false, { why: 'window.__sunFollow is absent — the follower is not mounted' });
  } else {
    const r = sf.residual(cam);
    if (!r) {
      add('sun shadow box', false, { why: 'no sun with a shadow in the scene, or the arrangement was never learned' });
    } else {
      add('sun shadow box', r.texels <= 1.0 + 1e-6, {
        texelsOff: +r.texels.toFixed(3),
        metresOff: +r.metres.toFixed(4),
        texelMetres: +r.texel.toFixed(5),
        shadowTargetWorld: r3(r.target),
        expectedTargetWorld: r3(r.expected),
        cameraWorld: r3(r.camera),
        followerEnabled: sf.on,
      });
    }
  }

  /* 2. Is the camera inside its own shadow frustum at all?
   *
   * Independent of check 1 and of the hook's bookkeeping: it asks the shadow
   * camera's real projection where the rendered camera lands. A point outside
   * the frustum is reported *lit* by three's shadow lookup, which is why the
   * pre-fix stills had no cast shadows rather than obviously broken ones. */
  let sun = null;
  s.scene.traverse((o) => {
    if (o.isDirectionalLight && o.castShadow && (!sun || o.intensity > sun.intensity)) sun = o;
  });
  if (sun && sun.shadow) {
    const sc = sun.shadow.camera;
    sc.updateMatrixWorld();
    const T = window.__THREE;
    const p = new T.Vector3(cp[0], cp[1], cp[2]).project(sc);
    const worst = Math.max(Math.abs(p.x), Math.abs(p.y));
    add('camera inside shadow frustum', worst <= 1.0, {
      ndc: r3([p.x, p.y, p.z]),
      cameraWorld: r3(cp),
      shadowCameraWorld: r3([sc.position.x, sc.position.y, sc.position.z]),
      extents: [sc.left, sc.right, sc.bottom, sc.top, sc.near, sc.far],
    });
  }

  /* 3. Any uniform that is a camera position.
   *
   * The \`uCam\` instance by name and by shape rather than by a list, so a
   * fourth one added tomorrow is caught without editing this file. A Vector3
   * uniform whose name mentions a camera or an eye is asserted to be the
   * camera being drawn with. */
  const seen = new Set();
  const stale = [];
  let scanned = 0;
  const look = (owner, uniforms) => {
    if (!uniforms) return;
    for (const k of Object.keys(uniforms)) {
      if (!/cam|eye/i.test(k)) continue;
      const v = uniforms[k] && uniforms[k].value;
      if (!v || typeof v.x !== 'number' || typeof v.z !== 'number' || typeof v.y !== 'number') continue;
      scanned++;
      const d = Math.hypot(v.x - cp[0], v.y - cp[1], v.z - cp[2]);
      if (d > 0.05) stale.push({ owner: owner, uniform: k, held: r3([v.x, v.y, v.z]), metresOff: +d.toFixed(3) });
    }
  };
  s.scene.traverse((o) => {
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) {
      if (!m || seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      look((o.name || o.type) + '/' + (m.name || m.type), m.uniforms);
      if (m.userData && m.userData.shader) look((o.name || o.type) + '/onBeforeCompile', m.userData.shader.uniforms);
    }
  });
  if (window.__dust) look('dust', window.__dust.uniforms);
  if (window.__grade) look('grade', window.__grade.uniforms);
  add('camera-position uniforms', stale.length === 0, {
    scanned: scanned, stale: stale, cameraWorld: r3(cp),
  });

  /* 4. The dust field's gate.
   *
   * The mote positions are keyed off three's own \`cameraPosition\`, which
   * cannot be stale — that was the fix. What can be stale is what it is gated
   * against: an un-bound or disposed shadow map silently ungates the whole
   * field, and a shadow matrix belonging to a previous frame lights exactly
   * the motes that should be dark. Both are the same bug shape one level in. */
  if (window.__dust) {
    const u = window.__dust.uniforms;
    const on = u.uShadowOn && u.uShadowOn.value > 0.5;
    const mat = u.uShadowMat && u.uShadowMat.value;
    const same = !!(on && sun && sun.shadow && mat === sun.shadow.matrix);
    add('dust shadow gate', !on || same, {
      gateOn: !!on,
      matrixIsTheSunsOwn: same,
      why: on && !same ? 'the dust is gated against a shadow matrix that is not the live one' : undefined,
      // The field wraps around cameraPosition in the vertex shader, so its
      // origin is the rendered camera by construction; recorded for provenance.
      fieldOriginWorld: r3(cp),
    });
  }

  /* 5. The grade's per-frame camera terms.
   *
   * \`uCoc\` carries the camera's eye height and pitch for the defocus's
   * ground-distance solve, written in the same \`draw()\` the capture path
   * calls. If it ever moves back into the frame loop this catches it. */
  if (window.__grade && window.__grade.uniforms && window.__grade.uniforms.uCoc) {
    const c = window.__grade.uniforms.uCoc.value;
    const dy = Math.abs(c.y - Math.max(cp[1], 0.2));
    add('grade uCoc eye height', dy <= 1e-3, {
      held: +c.y.toFixed(4), cameraY: +cp[1].toFixed(4), metresOff: +dy.toFixed(4),
    });
  }

  return out;
};
`;

/** Install the assertion into a page before any of its own scripts run. */
export async function installLiveness(page, { off = false } = {}) {
  await page.addInitScript(LIVENESS_SRC);
  if (off) await page.addInitScript('window.__livenessOff = true;');
}

/** Run it out of band, for a tool that renders without going through capture(). */
export async function checkLive(page, label) {
  return page.evaluate((l) => (window.__liveness ? window.__liveness(l) : { skipped: 'not installed' }), label);
}

/** One line per check, with the provenance. */
export function formatLiveness(r) {
  if (!r || r.skipped) return `  liveness: skipped (${(r && r.skipped) || 'no result'})`;
  const lines = [`  liveness${r.label ? ' [' + r.label + ']' : ''}  camera ${(r.camera || []).join(', ')}`];
  for (const c of r.checks) {
    const { name, ok, ...rest } = c;
    lines.push(`    ${ok ? 'ok  ' : 'FAIL'} ${name}  ${JSON.stringify(rest)}`);
  }
  return lines.join('\n');
}
