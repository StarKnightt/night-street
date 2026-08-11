"""Targeted diagnostics for the three suspected bugs plus the anisotropy re-test.

Each of these answers a question that looking at the frame cannot settle: how
tall the kerb actually renders at different stops, whether the horizon band is a
real luminance spike or an illusion of the surrounding darkness, and whether the
grain carries a directional bias even though its Fourier peak is broadband.
"""
import sys
import numpy as np
from PIL import Image


def load(p):
    return np.asarray(Image.open(p).convert('L'), dtype=np.float64) / 255.0


def horizon(path, y0=250, y1=360):
    """Row-mean luminance through the horizon, away from the road centre."""
    a = load(path)
    print(f'\n  horizon profile — {path}')
    cols = np.r_[0:260, 1340:1600]          # flanks only: apron, not carriageway
    prof = a[y0:y1, cols].mean(axis=1)
    base = np.median(prof)
    pk = prof.max()
    py = int(np.argmax(prof)) + y0
    print(f'    flank rows {y0}-{y1}: median={base:.4f} peak={pk:.4f} at y={py}'
          f'  spike={pk / max(base, 1e-6):.2f}x')
    for i in range(0, y1 - y0, 8):
        bar = '#' * int(prof[i] * 900)
        print(f'      y={y0 + i:4d} {prof[i]:.4f} {bar}')


def kerb(path, xband):
    """Apparent kerb upstand: rows between the top arris highlight and the road."""
    a = load(path)
    x0, x1 = xband
    col = a[:, x0:x1].mean(axis=1)
    d = np.diff(col)
    top = int(np.argmax(np.abs(d)))
    print(f'    {path:26s} x={x0}-{x1}  strongest edge at y={top}  '
          f'above={col[max(top - 6, 0)]:.3f} below={col[min(top + 6, len(col) - 1)]:.3f}')
    return top


def straight_lines(path):
    """Columns whose vertical run is unusually dark over a long span."""
    a = load(path)
    band = a[430:560, :]
    colmean = band.mean(axis=0)
    sm = np.convolve(colmean, np.ones(31) / 31, 'same')
    dip = sm - colmean
    idx = np.argsort(dip)[-14:]
    print(f'\n  persistent dark columns — {path}')
    print('    ' + ', '.join(f'x={i}({dip[i]:.3f})' for i in sorted(idx) if dip[i] > 0.004))


def anisotropy(path, box):
    """Directional bias of the grain, independent of any single Fourier peak.

    A peak/median ratio can sit at a healthy broadband value while the whole
    spectrum is still stretched along one axis, which is exactly what a
    'brushed' or 'combed' look is. Summing spectral energy into orientation
    bins and reporting max/mean over those bins catches that; an isotropic
    field lands near 1.0.
    """
    x0, y0, n = box
    a = load(path)[y0:y0 + n, x0:x0 + n]
    a = a - np.mean(a)
    win = np.outer(np.hanning(n), np.hanning(n))
    f = np.abs(np.fft.fftshift(np.fft.fft2(a * win))) ** 2
    c = n // 2
    yy, xx = np.mgrid[0:n, 0:n]
    dy, dx = yy - c, xx - c
    rr = np.hypot(dy, dx)
    m = (rr > 6) & (rr < n * 0.45)
    ang = (np.degrees(np.arctan2(dy, dx)) + 180.0) % 180.0
    bins = np.zeros(18)
    for b in range(18):
        sel = m & (ang >= b * 10) & (ang < (b + 1) * 10)
        bins[b] = f[sel].mean() if sel.any() else 0
    bins /= bins.mean()
    peak = int(np.argmax(bins))
    print(f'    {path:26s} anisotropy={bins.max():.2f}  strongest axis='
          f'{peak * 10}-{peak * 10 + 10} deg')
    print('      ' + ' '.join(f'{v:.2f}' for v in bins))
    return bins.max()


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if what in ('all', 'horizon'):
        horizon('shots/iter4/02.png')
    if what in ('all', 'kerb'):
        print('\n  kerb edge position by stop')
        kerb('shots/iter4/02.png', (150, 200))
        kerb('shots/iter4/95.png', (150, 200))
        kerb('shots/iter4/tilt.png', (150, 200))
    if what in ('all', 'lines'):
        straight_lines('shots/iter4/02.png')
    if what in ('all', 'aniso'):
        print('\n  grain anisotropy (1.0 = no preferred direction)')
        anisotropy('shots/near/crop.png', (300, 200, 384))
        anisotropy('shots/near/40.png', (500, 560, 320))
        anisotropy('shots/iter4/tilt.png', (600, 640, 256))
