/* Make GLSL link failures impossible to miss.
 *
 * A program that fails to link does not stop the frame. Three binds it, the
 * draw call silently produces nothing useful, and the surface renders as a
 * flat untextured fallback that looks exactly like a lighting bug. A duplicate
 * `float pv` declaration killed the pavement program on this project and it
 * survived two full review rounds, because the per-round check was "zero
 * console errors" and everyone was looking at the picture rather than the log.
 *
 * Three's default reporting for this is a console.error from inside
 * `onFirstUse`, which fires lazily on the first draw that uses the program —
 * potentially long after boot, and easy for a capture tool to miss depending
 * on when it attached its listeners. Rather than depend on that timing, this
 * installs `renderer.debug.onShaderError`, which three calls in place of its
 * own reporting, and records a structured entry on `window.__shaderErrors`.
 *
 * The capture harness reads that array and fails the run non-zero if it is not
 * empty. See tools/harness.mjs.
 */
import type * as THREE from 'three';

export type ShaderError = {
  /** The SHADER_NAME three compiled the program under, e.g. "MeshStandardMaterial". */
  program: string;
  /** Link-stage info log. */
  programLog: string;
  /** Compile info logs, with the offending source lines quoted inline. */
  vertex: string;
  fragment: string;
};

declare global {
  interface Window {
    __shaderErrors?: ShaderError[];
  }
}

/** Three prefixes every program it builds with `#define SHADER_NAME <name>`. */
function programName(source: string): string {
  return /^\s*#define\s+SHADER_NAME\s+(.+)$/m.exec(source)?.[1].trim() ?? 'unknown';
}

/**
 * Quote the source around each reported error.
 *
 * A GLSL info log says `ERROR: 0:412: 'pv' : redefinition`, and 412 is a line
 * in the fully assembled source including three's several-hundred-line prefix
 * of defines and chunks. Without the actual line printed beside it, finding
 * that in a generated shader means reconstructing the prefix by hand.
 */
function annotate(gl: WebGL2RenderingContext | WebGLRenderingContext, shader: WebGLShader): string {
  const log = (gl.getShaderInfoLog(shader) || '').trim();
  if (!log) return '';
  const src = (gl.getShaderSource(shader) || '').split('\n');
  const out: string[] = [];
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    out.push(line.trim());
    const n = /ERROR:\s*\d+:(\d+)/.exec(line);
    if (!n) continue;
    const at = parseInt(n[1], 10);
    for (let i = Math.max(1, at - 2); i <= Math.min(src.length, at + 2); i++) {
      out.push(`   ${i === at ? '>' : ' '} ${String(i).padStart(5)} | ${src[i - 1]}`);
    }
  }
  return out.join('\n');
}

/**
 * Route link failures into `window.__shaderErrors` and onto the console.
 *
 * Must run before the first material compiles — three consults
 * `debug.onShaderError` at link-check time and there is no way to learn about
 * a program that has already been checked.
 */
export function installShaderErrorWatch(renderer: THREE.WebGLRenderer): void {
  const errors: ShaderError[] = (window.__shaderErrors ??= []);

  /* Without this the hook is never consulted at all. It defaults to true, but
   * bundlers and hosts do turn it off in production builds and a silent
   * watchdog is worse than none. */
  renderer.debug.checkShaderErrors = true;

  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const entry: ShaderError = {
      program: programName(gl.getShaderSource(vs) || ''),
      programLog: (gl.getProgramInfoLog(program) || '').trim(),
      vertex: annotate(gl, vs),
      fragment: annotate(gl, fs),
    };
    errors.push(entry);

    /* Setting the hook suppresses three's own report, so this has to carry the
     * console side of it too. */
    console.error(
      `SHADER LINK FAILED: ${entry.program}\n` +
      (entry.programLog ? `program: ${entry.programLog}\n` : '') +
      (entry.vertex ? `vertex:\n${entry.vertex}\n` : '') +
      (entry.fragment ? `fragment:\n${entry.fragment}\n` : ''),
    );
  };
}
