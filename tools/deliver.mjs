/* Turn a captured frame sequence into the file that gets posted.
 *
 *   node tools/deliver.mjs <tag> [--shot walk] [--fps 60] [--half] [--audio a.wav]
 *
 * `reel.mjs` already writes an mp4, and that mp4 is a review copy: constant
 * rate factor 17 straight off the frame sequence, which is the right choice
 * when the question is "is there a defect in the render" and the wrong one
 * when the question is "what will this look like after a social platform has
 * re-encoded it".
 *
 * Three things this does that the review encode does not.
 *
 * It can halve the frame rate by decimation rather than by resampling. The
 * capture is driven — every frame is exactly 1/fps of simulated time — so
 * every second frame of a 60 Hz take *is* the 30 Hz take, with identical
 * content and no interpolation anywhere. That makes the 30 and 60 versions
 * differenceable rather than merely similar.
 *
 * It caps the bitrate. Grain and dust are close to incompressible: the grade's
 * sensor grain is a per-frame noise field and the atmosphere is a 76-pixel-
 * per-frame mote field, and between them they will absorb whatever bitrate
 * they are given and then be thrown away by the platform's own encoder. A
 * two-pass cap at a bitrate the platform will not immediately halve is worth
 * more than a CRF that produces a 300 MB file.
 *
 * And it writes `-movflags +faststart` and BT.709 tagging, because a file
 * whose colour primaries are unstated is a file that arrives on somebody's
 * phone with the browser's guess applied to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const tag = args[0] && !args[0].startsWith('--') ? args[0] : null;
if (!tag) { console.error('usage: node tools/deliver.mjs <tag> [--shot walk] [--fps 60]'); process.exit(2); }

const shot = flag('shot', 'walk');
const FPS = +flag('fps', 60);
const HALF = args.includes('--half');
const AUDIO = flag('audio', null);
const MBPS = +flag('mbps', HALF ? 12 : 16);

const src = path.join(ROOT, 'shots', tag, shot);
if (!fs.existsSync(src)) { console.error(`no frames at ${path.relative(ROOT, src)}`); process.exit(1); }
const frames = fs.readdirSync(src).filter((f) => /\.(jpg|png)$/.test(f)).sort();
if (!frames.length) { console.error('no frames'); process.exit(1); }
const ext = path.extname(frames[0]).slice(1);

const outFps = HALF ? FPS / 2 : FPS;
const out = path.join(ROOT, 'shots', tag, `${shot}-${outFps}p.mp4`);

/* Decimation, not resampling. `select` keeps every second frame and `setpts`
 * re-times what is left; `fps=` would resample against a clock and can repeat
 * or drop a frame at the boundaries, which on a driven capture is the one
 * thing that would put a hitch into a gait that measures zero foot slide. */
/* And limited range, explicitly.
 *
 * The frames come off `canvas.toDataURL`, so they are full-range JPEG, and
 * x264 tags that through as `yuvj420p`. Roughly everything plays it correctly
 * and the exceptions crush the shadows by sixteen counts — on a clip whose
 * shaded asphalt sits at code 28 that is most of the road. Convert once, here,
 * and tag it. */
const vf = [
  /* `setpts=N/FRAME_RATE/TB` is the idiom and it is wrong here: FRAME_RATE is
   * still the *input* rate, so the kept frames are re-stamped at 60 Hz and the
   * `-r 30` that follows throws away half of them again. The first run of this
   * produced a 452-frame, fifteen-second file that plays as a correct walk at
   * double speed, which is precisely the kind of defect that survives a
   * glance. Stamp against the output rate. */
  HALF ? `select=not(mod(n\\,2)),setpts=N/${outFps}/TB` : null,
  'scale=in_range=full:out_range=limited',
  'format=yuv420p',
].filter(Boolean).join(',');

const common = [
  '-y',
  '-framerate', String(FPS),
  '-i', path.join(src, `%05d.${ext}`),
  ...(AUDIO ? ['-i', AUDIO] : []),
  '-vf', vf,
  '-r', String(outFps),
  '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-level', '4.2',
  '-b:v', `${MBPS}M`, '-maxrate', `${Math.round(MBPS * 1.4)}M`, '-bufsize', `${MBPS * 3}M`,
  /* Grain and dust are the whole point of this scene and both are exactly
   * what a psychovisual encoder throws away first. Keeping the AQ strength up
   * and the deblocker off the shadows preserves them where the default
   * settings smear the shadowed road into flat plates. */
  '-x264-params', 'aq-mode=3:aq-strength=1.1:deblock=-1,-1:psy-rd=1.0,0.15',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-color_range', 'tv',
  '-movflags', '+faststart',
  ...(AUDIO ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest'] : ['-an']),
];

console.log(`  ${frames.length} ${ext} frames at ${FPS} Hz -> ${outFps} fps, ${MBPS} Mbit/s`);
const pass = (n) => spawnSync('ffmpeg', [
  ...common.slice(0, -0 || common.length),
  '-pass', String(n), '-passlogfile', path.join(ROOT, 'shots', tag, `${shot}-x264`),
  ...(n === 1 ? ['-f', 'mp4', process.platform === 'win32' ? 'NUL' : '/dev/null'] : [out]),
], { encoding: 'utf8' });

for (const n of [1, 2]) {
  const r = pass(n);
  if (r.status !== 0) {
    console.error((r.stderr || '').split('\n').slice(-20).join('\n'));
    process.exit(1);
  }
}
for (const f of fs.readdirSync(path.join(ROOT, 'shots', tag))) {
  if (f.startsWith(`${shot}-x264`)) fs.rmSync(path.join(ROOT, 'shots', tag, f));
}

const st = fs.statSync(out);
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate,nb_frames,pix_fmt',
  '-of', 'default=nw=1', out], { encoding: 'utf8' });
console.log(`  -> ${path.relative(ROOT, out)}  ${(st.size / 1048576).toFixed(1)} MB`);
console.log((probe.stdout || '').trim().split('\n').map((l) => `     ${l}`).join('\n'));
