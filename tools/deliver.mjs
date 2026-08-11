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
/* Cut the take short, and fade it out.
 *
 * These exist for the insurance cut. A thirty-second walk that ends in shade
 * can be turned into a twenty-one-second walk that ends in the sun band it was
 * already crossing, without a GPU and without touching the take — and a hard
 * cut mid-stride reads as a file that got truncated, where half a second of
 * fade reads as an edit. The suffix keeps it off the delivered name. */
const UNTIL = +flag('until', 0);
const FADE = +flag('fadeout', 0);
const SUFFIX = flag('suffix', '');

/* --mux: put the track on the file that was already verified.
 *
 * Passing --audio to a fresh encode works, but it re-runs both x264 passes,
 * and the file that then ships is not the file the luminance arc and the
 * frame-by-frame checks were run against — it is a second encode that should
 * be identical and has not been shown to be. Audio arriving late in the night
 * is the normal case, so the normal case should be a stream copy: the video
 * bitstream is carried over untouched and only the AAC is new.
 *
 * The 120 ms ramps are for the boundaries, not for taste. The take starts and
 * ends mid-stride with traffic and room tone at full level, and a WAV that
 * begins at a non-zero sample is a click on every player that does not
 * crossfade its own start. */
if (args.includes('--mux')) {
  if (!AUDIO) { console.error('--mux needs --audio <file.wav>'); process.exit(2); }
  const outFpsM = HALF ? FPS / 2 : FPS;
  const vid = path.join(ROOT, 'shots', tag, `${shot}-${outFpsM}p${SUFFIX}.mp4`);
  if (!fs.existsSync(vid)) { console.error(`no picture at ${path.relative(ROOT, vid)}`); process.exit(1); }
  const dur = +(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', vid], { encoding: 'utf8' }).stdout || '0').trim();
  const outM = vid.replace(/\.mp4$/, '-sound.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-i', vid, '-i', AUDIO,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-af', `afade=t=in:st=0:d=0.12,afade=t=out:st=${(dur - 0.12).toFixed(3)}:d=0.12`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-shortest', outM], { encoding: 'utf8' });
  if (r.status !== 0) { console.error((r.stderr || '').split('\n').slice(-15).join('\n')); process.exit(1); }
  const sz = fs.statSync(outM).size / 1048576;
  console.log(`  ${path.relative(ROOT, vid)} + ${path.basename(AUDIO)}`);
  console.log(`  -> ${path.relative(ROOT, outM)}  ${sz.toFixed(1)} MB  (video stream copied)`);
  process.exit(0);
}

const src = path.join(ROOT, 'shots', tag, shot);
if (!fs.existsSync(src)) { console.error(`no frames at ${path.relative(ROOT, src)}`); process.exit(1); }
const frames = fs.readdirSync(src).filter((f) => /\.(jpg|png)$/.test(f)).sort();
if (!frames.length) { console.error('no frames'); process.exit(1); }
const ext = path.extname(frames[0]).slice(1);

const outFps = HALF ? FPS / 2 : FPS;
const out = path.join(ROOT, 'shots', tag, `${shot}-${outFps}p${SUFFIX}.mp4`);

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
  FADE && UNTIL ? `fade=t=out:st=${(UNTIL - FADE).toFixed(3)}:d=${FADE}` : null,
  'format=yuv420p',
].filter(Boolean).join(',');

const common = [
  '-y',
  '-framerate', String(FPS),
  ...(UNTIL ? ['-t', String(UNTIL)] : []),
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
