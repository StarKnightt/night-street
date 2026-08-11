"""Measure feature scale and periodicity in a rendered ground plane.

Answers two things opinion cannot settle: does the aggregate actually grow in
pixels as it approaches the camera, and is there a fixed-pitch lattice in it.

The lattice test is spectral. An earlier autocorrelation version of it was
discarded after a control run: a patch of empty sky scored *higher* than the
asphalt, because autocorrelation on a smooth gradient peaks at every small lag
and says nothing about periodicity. What actually distinguishes a lattice is an
isolated spike in the Fourier magnitude at a non-zero frequency, so the patch
is high-passed to kill the lighting gradient and the peak is reported as a
ratio against the median of the spectrum. Broadband texture sits near 10;
anything above about 40 is a real periodic artifact.
"""
import sys
import numpy as np
from PIL import Image


def feature_width(sig):
    """Lag of the first autocorrelation zero-crossing = characteristic width."""
    s = sig - sig.mean()
    if s.std() < 1e-9:
        return float('nan')
    ac = np.correlate(s, s, 'full')[len(s) - 1:]
    ac /= ac[0]
    for i in range(1, len(ac)):
        if ac[i] <= 0:
            return i - 1 + ac[i - 1] / (ac[i - 1] - ac[i])
    return float('nan')


def boxblur(a, r):
    k = np.ones(2 * r + 1) / (2 * r + 1)
    out = np.apply_along_axis(lambda m: np.convolve(m, k, 'same'), 0, a)
    return np.apply_along_axis(lambda m: np.convolve(m, k, 'same'), 1, out)


def lattice(a):
    """Strongest isolated spectral peak, as a ratio over the median."""
    a = a - boxblur(a, 6)                     # high-pass: drop the lighting
    n = min(a.shape[0], a.shape[1])
    a = a[:n, :n]
    win = np.outer(np.hanning(n), np.hanning(n))
    f = np.abs(np.fft.fftshift(np.fft.fft2(a * win)))
    c = n // 2
    yy, xx = np.mgrid[0:n, 0:n]
    rr = np.hypot(yy - c, xx - c)
    f[rr < 4] = 0                             # ignore DC and the very lowest
    med = np.median(f[rr >= 4])
    pk = f.max()
    py, px = np.unravel_index(int(np.argmax(f)), f.shape)
    freq = np.hypot(py - c, px - c) / n
    return pk / max(med, 1e-9), (1.0 / freq if freq > 0 else 0)


def main(path):
    im = Image.open(path)
    w, h = im.size
    a = np.asarray(im.convert('L'), dtype=np.float64)
    print(f'{path}  {w}x{h}')
    print('\n  depth vs feature width (autocorrelation zero-crossing, px)')
    for f in (0.99, 0.95, 0.90, 0.84, 0.78, 0.72, 0.66):
        y = min(int(h * f), h - 1)
        print(f'    y={y:4d} ({f:.2f})  width={feature_width(a[y, int(w * .32):int(w * .68)]):6.2f} px')
    print('\n  lattice test (peak/median, period px)')
    for tag, (x0, y0) in (('asphalt near', (350, 560)),
                          ('asphalt mid', (600, 430)),
                          ('SKY control', (350, 40))):
        y1, x1 = min(y0 + 300, h), min(x0 + 300, w)
        r, per = lattice(a[y0:y1, x0:x1])
        flag = '   <-- LATTICE' if r > 40 else ''
        print(f'    {tag:14s} ratio={r:7.1f}  period={per:5.1f}{flag}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'shots/near/40.png')
