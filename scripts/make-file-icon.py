# The icon Windows shows for PDF files opened with PDF Editor: a page with a folded corner, a red
# "PDF" label (so it reads as a PDF at a glance) and the app's G as a small badge.
# python3 scripts/make-file-icon.py  -> public/pdf-file.ico (+ pdf-file.png preview)
import os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
S = 1024  # drawn big, scaled down per size
# a bold sans font for the "PDF" label (here, or on Windows); none found = stop (PIL's own tiny
# bitmap font left the label empty)
BOLD = next((f for f in ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', 'arialbd.ttf'), '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'] if os.path.exists(f)), None)
if not BOLD:
    sys.exit('make-file-icon.py: no bold font found for the label (DejaVu Sans Bold or Arial Bold)')

def page_icon(size, badge=True):
    k = S / 256
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # soft shadow
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(sh)
    x0, y0, x1, y1, fold = 44 * k, 14 * k, 212 * k, 242 * k, 52 * k
    d.polygon([(x0 + 4 * k, y0 + 6 * k), (x1 - fold + 4 * k, y0 + 6 * k), (x1 + 4 * k, y0 + fold + 6 * k), (x1 + 4 * k, y1 + 6 * k), (x0 + 4 * k, y1 + 6 * k)], fill=(0, 0, 0, 70))
    sh = sh.filter(ImageFilter.GaussianBlur(8 * k))
    im.alpha_composite(sh)
    d = ImageDraw.Draw(im)
    # page
    d.polygon([(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)], fill=(255, 255, 255, 255), outline=(176, 186, 184, 255), width=int(3 * k))
    # folded corner
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(222, 228, 227, 255), outline=(176, 186, 184, 255), width=int(3 * k))
    # text lines (only where they stay visible)
    if size >= 48:
        for i, w in enumerate([100, 120, 86, 112]):
            yy = (62 + i * 18) * k
            d.rounded_rectangle([x0 + 22 * k, yy, x0 + (22 + w) * k, yy + 7 * k], radius=3 * k, fill=(205, 213, 211, 255))
    # red PDF label across the lower part
    by0, by1 = (146 if size >= 48 else 120) * k, (196 if size >= 48 else 200) * k
    d.rounded_rectangle([x0 - 18 * k, by0, x0 + 150 * k, by1], radius=10 * k, fill=(206, 32, 41, 255))
    f = ImageFont.truetype(BOLD, int((40 if size >= 48 else 62) * k))
    t = 'PDF'
    tb = d.textbbox((0, 0), t, font=f)
    tx = x0 - 18 * k + (168 * k - (tb[2] - tb[0])) / 2 - tb[0]
    ty = by0 + ((by1 - by0) - (tb[3] - tb[1])) / 2 - tb[1]
    d.text((tx, ty), t, font=f, fill=(255, 255, 255, 255))
    # the app's G as a badge, bottom right
    if badge and size >= 32:
        g = Image.open('public/icon256.png').convert('RGBA').resize((int(92 * k), int(92 * k)), Image.LANCZOS)
        ring = Image.new('RGBA', (int(100 * k), int(100 * k)), (0, 0, 0, 0))
        ImageDraw.Draw(ring).rounded_rectangle([0, 0, 100 * k - 1, 100 * k - 1], radius=24 * k, fill=(255, 255, 255, 255))
        im.alpha_composite(ring, (int(160 * k), int(152 * k)))
        im.alpha_composite(g, (int(164 * k), int(156 * k)))
    return im.resize((size, size), Image.LANCZOS)

sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
imgs = [page_icon(s) for s in sizes]
imgs[-1].save('public/pdf-file.ico', format='ICO', sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
imgs[-1].save('public/pdf-file.png')
print('ok')
