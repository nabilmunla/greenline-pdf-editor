# Synthetic "scanned inspection request" books for the mega stress test (0.9.9, after the Cloudflare
# reports: 200+ MB scans and a 502-page 619 MB file). Every page a 300 dpi colour JPEG (paper grain,
# typed text, stamps' worth of ink) - about 1.2 MB each, A3 landscape every 25th page, /Rotate 90
# every 50th. Written straight to disk.
#   python3 tests/make-mega-scan.py out.pdf PAGES SEED
import io, sys, random
import numpy as np
from PIL import Image, ImageDraw, ImageFont

out, pages, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rnd = random.Random(seed)
rng = np.random.default_rng(seed)
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 34)
except Exception: font = ImageFont.load_default()
WORDS = 'inspection request concrete pour slab level grid column beam reinforcement approved rejected consultant contractor site engineer date remarks drawing reference cover blinding formwork'.split()

def grain(w, h):
    base = 236 + rng.normal(0, 9, (h // 4, w // 4, 3))
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)
bgs = {(2480, 3508): [grain(2480, 3508) for _ in range(4)], (4960, 3508): [grain(4960, 3508) for _ in range(2)]}

def page_jpeg(i):
    a3 = i % 25 == 24
    w, h = (4960, 3508) if a3 else (2480, 3508)
    im = rnd.choice(bgs[(w, h)]).copy()
    d = ImageDraw.Draw(im)
    d.text((180, 160), f'INSPECTION REQUEST No. IR-{1000 + i}', fill=(20, 20, 20), font=font)
    y = 300
    while y < h - 300:
        line = ' '.join(rnd.choice(WORDS) for _ in range(rnd.randint(6, 12 if not a3 else 22)))
        d.text((180, y), line, fill=(30, 30, 40), font=font)
        y += rnd.randint(55, 90)
    for _ in range(rnd.randint(2, 5)):  # ruled boxes, a signature scribble, a stamp
        x0, y0 = rnd.randint(150, w - 900), rnd.randint(300, h - 600)
        d.rectangle([x0, y0, x0 + rnd.randint(300, 800), y0 + rnd.randint(120, 400)], outline=(40, 40, 60), width=4)
    cx, cy = rnd.randint(400, w - 400), rnd.randint(h - 900, h - 300)
    d.ellipse([cx - 160, cy - 160, cx + 160, cy + 160], outline=(30, 60, 170), width=10)
    pts = [(cx - 500 + k * 40, cy + rnd.randint(-60, 60)) for k in range(25)]
    d.line(pts, fill=(20, 40, 150), width=6)
    # scanner noise: speckles across the page (what makes real scans big)
    arr = np.asarray(im).copy()
    m = rng.random(arr.shape[:2]) < 0.0025
    arr[m] = rng.integers(120, 220, (int(m.sum()), 1))
    im = Image.fromarray(arr)
    b = io.BytesIO(); im.save(b, 'JPEG', quality=78, optimize=False)
    return b.getvalue(), w, h, a3

with open(out, 'wb') as f:
    offs = {}
    def obj(n, body):
        offs[n] = f.tell(); f.write(b'%d 0 obj\n' % n); f.write(body); f.write(b'\nendobj\n')
    f.write(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    kids = ' '.join(f'{3 + i * 3} 0 R' for i in range(pages))
    obj(1, b'<< /Type /Catalog /Pages 2 0 R >>')
    obj(2, f'<< /Type /Pages /Kids [{kids}] /Count {pages} >>'.encode())
    total = 0
    for i in range(pages):
        jpg, w, h, a3 = page_jpeg(i)
        total += len(jpg)
        pw, ph = (1190.55, 841.89) if a3 else (595.28, 841.89)
        rot = ' /Rotate 90' if i % 50 == 49 else ''
        p, c, im = 3 + i * 3, 4 + i * 3, 5 + i * 3
        obj(p, f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw} {ph}]{rot} /Resources << /XObject << /Im0 {im} 0 R >> >> /Contents {c} 0 R >>'.encode())
        cs = f'q {pw} 0 0 {ph} 0 0 cm /Im0 Do Q'.encode()
        obj(c, b'<< /Length %d >>\nstream\n' % len(cs) + cs + b'\nendstream')
        obj(im, f'<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpg)} >>\nstream\n'.encode() + jpg + b'\nendstream')
        if i % 50 == 0: print(f'page {i + 1}/{pages}, {total / 1e6:.0f} MB', flush=True)
    n = 3 + pages * 3
    x = f.tell()
    f.write(f'xref\n0 {n}\n0000000000 65535 f \n'.encode())
    for k in range(1, n): f.write(b'%010d 00000 n \n' % offs[k])
    f.write(f'trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n'.encode())
print(out, f'{f.tell() if not f.closed else 0}', 'done')
