# A made-up but realistic A1 floor plan (1:100 + a 1:50 unit) for Greenline's screenshots - not a real
# project. python3 scripts/make-sample-plan.py <out.pdf>   (needs reportlab)
import math, random, sys
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

random.seed(7)
W, H = 841 * mm, 594 * mm
M = 1000 / 100 * mm  # one metre on paper at 1:100 (10 mm)
OX, OY = 75 * mm, 95 * mm  # building origin (grid 1/A) on the sheet
out = sys.argv[1]
c = canvas.Canvas(out, pagesize=(W, H))
c.setTitle('Sample Residential Building - Typical Floor Plan')
c.setAuthor('Greenline sample drawing')

P = lambda x, y: (OX + x * M, OY + y * M)
GX = [0, 6, 12, 18, 24, 30, 36, 42]
GY = [0, 7.2, 9.6, 16.8]
GXL = [str(i + 1) for i in range(len(GX))]
GYL = ['A', 'B', 'C', 'D']
BW, BH = GX[-1], GY[-1]

def line(x1, y1, x2, y2, w=0.25, col=(0, 0, 0), dash=None):
    c.setLineWidth(w); c.setStrokeColorRGB(*col)
    c.setDash(list(dash)) if dash else c.setDash()
    a, b = P(x1, y1); d, e = P(x2, y2)
    c.line(a, b, d, e)

def rect(x, y, w, h, lw=0.25, fill=None, col=(0, 0, 0)):
    c.setLineWidth(lw); c.setStrokeColorRGB(*col); c.setDash()
    if fill is not None: c.setFillColorRGB(*fill)
    a, b = P(x, y)
    c.rect(a, b, w * M, h * M, stroke=1, fill=1 if fill is not None else 0)

FS = 1.0
def text(x, y, s, size=7, font='Helvetica', anchor='middle', col=(0, 0, 0)):
    c.setFillColorRGB(*col); c.setFont(font, size * FS)
    a, b = P(x, y)
    {'middle': c.drawCentredString, 'left': c.drawString, 'right': c.drawRightString}[anchor](a, b, s)

# ---- sheet border and zones
c.setLineWidth(1.4); c.rect(10 * mm, 10 * mm, W - 20 * mm, H - 20 * mm)
c.setLineWidth(0.4); c.rect(15 * mm, 15 * mm, W - 30 * mm, H - 30 * mm)
c.setFont('Helvetica', 7)
for i in range(8):
    x = 15 * mm + (W - 30 * mm) * (i + 0.5) / 8
    c.drawCentredString(x, 11.5 * mm, str(i + 1)); c.drawCentredString(x, H - 14 * mm, str(i + 1))
for i, L in enumerate('FEDCBA'):
    y = 15 * mm + (H - 30 * mm) * (i + 0.5) / 6
    c.drawCentredString(12.5 * mm, y, L); c.drawCentredString(W - 12.5 * mm, y, L)

# ---- grid
for x, L in zip(GX, GXL):
    line(x, -3.2, x, BH + 3.2, 0.3, (0.35, 0.35, 0.35), (6, 2, 1, 2))
    for yy in (-4.2, BH + 4.2):
        a, b = P(x, yy); c.setDash(); c.setLineWidth(0.4); c.setStrokeColorRGB(0, 0, 0); c.circle(a, b, 4.2 * mm)
        text(x, yy - 0.28, L, 9, 'Helvetica-Bold')
for y, L in zip(GY, GYL):
    line(-3.2, y, BW + 3.2, y, 0.3, (0.35, 0.35, 0.35), (6, 2, 1, 2))
    for xx in (-4.2, BW + 4.2):
        a, b = P(xx, y); c.setDash(); c.setLineWidth(0.4); c.setStrokeColorRGB(0, 0, 0); c.circle(a, b, 4.2 * mm)
        text(xx, y - 0.28, L, 9, 'Helvetica-Bold')

# ---- walls: poche between two lines
def wall(x1, y1, x2, y2, t):
    if x1 == x2: rect(x1 - t / 2, min(y1, y2), t, abs(y2 - y1), 0.5, (0.72, 0.72, 0.72))
    else: rect(min(x1, x2), y1 - t / 2, abs(x2 - x1), t, 0.5, (0.72, 0.72, 0.72))
ext = 0.3
for a in [(0, 0, BW, 0), (0, BH, BW, BH), (0, 0, 0, BH), (BW, 0, BW, BH)]: wall(*a, ext)
# corridor walls
wall(0, GY[1], BW, GY[1], 0.2); wall(0, GY[2], BW, GY[2], 0.2)
# party walls between flats
for x in GX[1:-1]:
    wall(x, 0, x, GY[1], 0.2); wall(x, GY[2], x, BH, 0.2)
# columns
for x in GX:
    for y in GY:
        rect(x - 0.25, y - 0.25, 0.5, 0.5, 0.5, (0.15, 0.15, 0.15))

# ---- doors (leaf + swing)
def door(x, y, w, ang, flip=1):
    a, b = P(x, y)
    c.setLineWidth(0.35); c.setStrokeColorRGB(0, 0, 0); c.setDash()
    r = w * M
    ex, ey = a + r * math.cos(math.radians(ang + 90 * flip)), b + r * math.sin(math.radians(ang + 90 * flip))
    c.line(a, b, ex, ey)
    c.setLineWidth(0.2); c.setDash(2, 1.5)
    s, e = (ang, 90) if flip == 1 else (ang - 90, 90)
    c.arc(a - r, b - r, a + r, b + r, s, e); c.setDash()

# ---- windows in the outer walls
def window(x1, x2, y):
    rect(x1, y - 0.15, x2 - x1, 0.3, 0.4, (1, 1, 1))
    line(x1, y, x2, y, 0.25)
for i in range(len(GX) - 1):
    a, b = GX[i], GX[i + 1]
    for y in (0, BH):
        window(a + 0.9, a + 2.6, y); window(a + 3.4, b - 0.9, y)

# ---- flats: rooms, fittings, labels
rooms = []
def flat(x0, south):
    y0, y1 = (0, GY[1]) if south else (GY[2], BH)
    d = 1 if south else -1
    edge = y1 if south else y0  # corridor side
    far = y0 if south else y1
    # bedroom / living split
    wall(x0 + 3.2, y0, x0 + 3.2, y1, 0.12)
    # bathroom + kitchen strip by the corridor
    by = edge - d * 2.4
    wall(x0, by, x0 + 6, by, 0.12)
    wall(x0 + 2.0, min(by, edge), x0 + 2.0, max(by, edge), 0.12)
    # tiles in the bathroom (fine grid)
    bx0, bx1 = x0 + 0.15, x0 + 1.9
    ya, yb = sorted([by, edge]); ya += 0.12; yb -= 0.12
    t = 0.3
    xx = bx0
    while xx < bx1: line(xx, ya, xx, yb, 0.08, (0.55, 0.55, 0.55)); xx += t
    yy = ya
    while yy < yb: line(bx0, yy, bx1, yy, 0.08, (0.55, 0.55, 0.55)); yy += t
    # WC, basin, shower
    cx = x0 + 0.6; cy = edge - d * 0.6
    a, b = P(cx, cy); c.setLineWidth(0.3); c.setFillColorRGB(1, 1, 1); c.ellipse(a - 0.22 * M, b - 0.3 * M, a + 0.22 * M, b + 0.3 * M, fill=1)
    rect(x0 + 1.2, (edge - d * 0.55) - 0.2, 0.55, 0.4, 0.3, (1, 1, 1))
    rect(x0 + 0.2, by + (0.15 if south else -1.05), 0.9, 0.9, 0.3)
    line(x0 + 0.2, by + (0.15 if south else -1.05), x0 + 1.1, by + (1.05 if south else -0.15), 0.15)
    # kitchen counter + hob + sink
    kx0 = x0 + 2.2
    ky = edge - d * 0.65
    rect(kx0, ky - 0.3, 3.6, 0.6, 0.3, (0.95, 0.95, 0.95))
    for k in range(4):
        a, b = P(kx0 + 0.5 + (k % 2) * 0.35, ky - 0.12 + (k // 2) * 0.24); c.setFillColorRGB(1, 1, 1); c.circle(a, b, 0.1 * M, fill=0)
    rect(kx0 + 2.3, ky - 0.2, 0.8, 0.4, 0.3, (1, 1, 1))
    # bedroom: bed + wardrobe
    bx = x0 + 3.5
    byy = far + d * 0.4 if south else far + d * 0.4 - 2.0
    rect(bx, (far + 0.4) if south else (far - 2.4), 1.6, 2.0, 0.35, (1, 1, 1))
    rect(bx + 0.15, (far + 0.5) if south else (far - 0.85), 0.55, 0.35, 0.2); rect(bx + 0.9, (far + 0.5) if south else (far - 0.85), 0.55, 0.35, 0.2)
    rect(x0 + 5.35, (far + 0.3) if south else (far - 2.9), 0.6, 2.6, 0.3)
    for k in range(6): line(x0 + 5.35, ((far + 0.3) if south else (far - 2.9)) + 0.43 * k, x0 + 5.95, ((far + 0.3) if south else (far - 2.9)) + 0.43 * k + 0.43, 0.1)
    # living: sofa + table
    rect(x0 + 0.4, (far + 0.5) if south else (far - 1.4), 2.4, 0.9, 0.35, (1, 1, 1))
    rect(x0 + 0.9, (far + 1.8) if south else (far - 2.8), 1.4, 0.8, 0.3)
    # doors
    door(x0 + 4.8 if True else 0, edge, 0.9, 180 if south else 0, 1)
    door(x0 + 3.2, (by - 0.2) if south else (by + 0.2), 0.8, 90 if south else 270, 1)
    door(x0 + 2.0, (edge - d * 0.3), 0.7, 0 if south else 180, -1 if south else 1)
    # labels
    rooms.append((x0 + 1.6, (far + by) / 2, 'LIVING / DINING', 3.2 * abs(by - far)))
    rooms.append((x0 + 4.6, (far + by) / 2, 'BEDROOM', 2.8 * abs(by - far)))
    rooms.append((x0 + 1.0, (by + edge) / 2, 'BATH', 2.0 * 2.4))
    rooms.append((x0 + 4.0, (by + edge) / 2, 'KITCHEN', 4.0 * 2.4))

for i in range(len(GX) - 1):
    if i == 3: continue  # the core
    flat(GX[i], True); flat(GX[i], False)

# ---- core: stairs and two lifts (bay 4)
x0 = GX[3]
for south, y0, y1 in ((True, 0, GY[1]), (False, GY[2], BH)):
    if south:
        rect(x0 + 0.3, 0.3, 2.6, GY[1] - 0.6, 0.35)
        for k in range(16): line(x0 + 0.3, 0.6 + k * 0.38, x0 + 2.9, 0.6 + k * 0.38, 0.2)
        line(x0 + 1.6, 0.6, x0 + 1.6, GY[1] - 0.6, 0.35)
        a, b = P(x0 + 1.0, 1.0); c.setLineWidth(0.4); c.line(a, b, a, b + 5.0 * M); c.line(a, b + 5.0 * M, a - 0.15 * M, b + 4.6 * M); c.line(a, b + 5.0 * M, a + 0.15 * M, b + 4.6 * M)
        text(x0 + 2.3, 3.2, 'UP', 7, 'Helvetica-Bold')
        for k in range(2):
            lx = x0 + 3.3 + k * 1.35
            rect(lx, GY[1] - 2.0, 1.2, 1.6, 0.4)
            line(lx, GY[1] - 2.0, lx + 1.2, GY[1] - 0.4, 0.2); line(lx, GY[1] - 0.4, lx + 1.2, GY[1] - 2.0, 0.2)
        text(x0 + 4.6, GY[1] - 2.6, 'LIFTS', 7)
        text(x0 + 1.6, -1.0, 'STAIR 1', 7)
    else:
        rect(x0 + 0.5, GY[2] + 0.4, 5.0, 2.6, 0.3)
        text(x0 + 3.0, GY[2] + 1.6, 'ELEC. / TELECOM', 6.5)
        rect(x0 + 0.5, GY[2] + 3.4, 5.0, 3.3, 0.3)
        text(x0 + 3.0, GY[2] + 4.9, 'REFUSE + SERVICES', 6.5)
text(BW / 2, (GY[1] + GY[2]) / 2 - 0.2, 'CORRIDOR', 8, 'Helvetica-Bold')
# corridor floor pattern
xx = 0.3
while xx < BW - 0.3:
    line(xx, GY[1] + 0.12, xx, GY[2] - 0.12, 0.06, (0.65, 0.65, 0.65)); xx += 0.6

for x, y, n, a in rooms:
    text(x, y + 0.15, n, 6.5, 'Helvetica-Bold')
    text(x, y - 0.45, f'{a:.1f} m²', 6, 'Helvetica', col=(0.25, 0.25, 0.25))

# ---- dimension chains
def dim_h(xs, y):
    line(xs[0], y, xs[-1], y, 0.3)
    for x in xs:
        a, b = P(x, y); c.setLineWidth(0.5); c.line(a - 1.5, b - 1.5, a + 1.5, b + 1.5)
        line(x, y - 0.4, x, y + 0.4, 0.2)
    for p, q in zip(xs, xs[1:]): text((p + q) / 2, y + 0.25, f'{(q - p) * 1000:.0f}', 6.5)
def dim_v(ys, x):
    line(x, ys[0], x, ys[-1], 0.3)
    for y in ys:
        a, b = P(x, y); c.setLineWidth(0.5); c.line(a - 1.5, b - 1.5, a + 1.5, b + 1.5)
        line(x - 0.4, y, x + 0.4, y, 0.2)
    for p, q in zip(ys, ys[1:]):
        a, b = P(x - 0.3, (p + q) / 2); c.saveState(); c.translate(a, b); c.rotate(90); c.setFont('Helvetica', 6.5); c.setFillColorRGB(0, 0, 0); c.drawCentredString(0, 0, f'{(q - p) * 1000:.0f}'); c.restoreState()
dim_h(GX, BH + 2.0); dim_h([0, BW], BH + 2.8)
dim_v(GY, -2.0); dim_v([0, BH], -2.8)
dim_h(sorted(set([0] + [g + o for g in GX[:-1] for o in (0.9, 2.6, 3.4)] + [g - 0.9 for g in GX[1:]] + [BW])), -1.6)

# ---- north arrow and scale bar
nx, ny = OX + BW * M + 35 * mm, OY + BH * M - 5 * mm
c.setLineWidth(0.6); c.setStrokeColorRGB(0, 0, 0); c.circle(nx, ny, 9 * mm)
p = c.beginPath(); p.moveTo(nx, ny + 8 * mm); p.lineTo(nx - 3 * mm, ny - 5 * mm); p.lineTo(nx, ny - 2 * mm); p.close(); c.setFillColorRGB(0, 0, 0); c.drawPath(p, fill=1)
c.setFont('Helvetica-Bold', 10); c.drawCentredString(nx, ny + 11 * mm, 'N')
sx, sy = OX, OY - 75 * mm
for i in range(5):
    c.setFillColorRGB(*((0, 0, 0) if i % 2 == 0 else (1, 1, 1))); c.rect(sx + i * M, sy, M, 2 * mm, fill=1)
c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica', 7)
for i in range(6): c.drawCentredString(sx + i * M, sy - 4 * mm, str(i))
c.drawString(sx + 5 * M + 4 * mm, sy - 4 * mm, 'm')
c.setFont('Helvetica-Bold', 12); c.drawString(sx, sy + 8 * mm, 'TYPICAL FLOOR PLAN (LEVELS 1-12)')
c.setFont('Helvetica', 8); c.drawString(sx, sy + 3.5 * mm, 'SCALE 1:100')

# ---- general notes
nx0, ny0 = W - 215 * mm, H - 40 * mm
c.setFont('Helvetica-Bold', 9); c.drawString(nx0, ny0, 'GENERAL NOTES')
notes = ['1. ALL DIMENSIONS ARE IN MILLIMETRES UNLESS NOTED OTHERWISE.', '2. DO NOT SCALE FROM THIS DRAWING; USE FIGURED DIMENSIONS ONLY.',
         '3. READ WITH THE STRUCTURAL AND MEP DRAWINGS.', '4. WALL TYPES: EXTERNAL 300 BLOCKWORK, PARTY WALLS 200, PARTITIONS 100.',
         '5. ROOM AREAS ARE NET INTERNAL AREAS.', '6. THIS IS A SAMPLE DRAWING FOR DEMONSTRATION ONLY.', '    IT DOES NOT REPRESENT ANY REAL PROJECT.']
c.setFont('Helvetica', 7)
for i, n in enumerate(notes): c.drawString(nx0, ny0 - 12 - i * 10, n)
# legend
ly = ny0 - 110
c.setFont('Helvetica-Bold', 9); c.drawString(nx0, ly, 'LEGEND')
items = [((0.72, 0.72, 0.72), 'BLOCKWORK WALL'), ((0.15, 0.15, 0.15), 'RC COLUMN'), ((1, 1, 1), 'WINDOW / GLAZING'), ((0.95, 0.95, 0.95), 'KITCHEN COUNTER')]
for i, (col, n) in enumerate(items):
    c.setFillColorRGB(*col); c.setLineWidth(0.4); c.rect(nx0, ly - 18 - i * 14, 14 * mm, 4 * mm, fill=1)
    c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica', 7); c.drawString(nx0 + 18 * mm, ly - 16 - i * 14, n)

# ---- enlarged unit plan 1:50
OX, OY, M, FS = 85 * mm, 395 * mm, 20 * mm, 1.45
rooms = []
for a in [(0, 0, 6, 0), (0, 7.2, 6, 7.2), (0, 0, 0, 7.2), (6, 0, 6, 7.2)]: wall(*a, 0.3 if a[1] == a[3] == 0 else 0.2)
for x in (0, 6):
    for y in (0, 7.2): rect(x - 0.25, y - 0.25, 0.5, 0.5, 0.5, (0.15, 0.15, 0.15))
window(0.9, 2.6, 0); window(3.4, 5.1, 0)
flat(0, True)
for x, y, n, a in rooms:
    text(x, y + 0.12, n, 6.5, 'Helvetica-Bold'); text(x, y - 0.32, f'{a:.1f} m\u00b2', 6, 'Helvetica', col=(0.25, 0.25, 0.25))
dim_h([0, 0.9, 2.6, 3.4, 5.1, 6], -1.0); dim_h([0, 2.0, 3.2, 6], 8.2); dim_v([0, 4.8, 7.2], -1.0); dim_v([0, 7.2], -1.7)
FS = 1.0
c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica-Bold', 12); c.drawString(85 * mm, 395 * mm - 34 * mm, 'UNIT TYPE A - ENLARGED PLAN')
c.setFont('Helvetica', 8); c.drawString(85 * mm, 395 * mm - 38.5 * mm, 'SCALE 1:50')
# ---- key plan
kx, ky, k = 300 * mm, 420 * mm, 2.4 * mm
c.setLineWidth(0.6); c.setStrokeColorRGB(0, 0, 0); c.setFillColorRGB(0.85, 0.93, 0.88)
c.rect(kx, ky, BW * k, BH * k, fill=1)
c.setFillColorRGB(0.2, 0.55, 0.35); c.rect(kx, ky, 6 * k, GY[1] * k, fill=1)
c.setLineWidth(0.3)
for x in GX: c.line(kx + x * k, ky - 2 * mm, kx + x * k, ky + BH * k + 2 * mm)
c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica-Bold', 10); c.drawString(kx, ky + BH * k + 8 * mm, 'KEY PLAN')
c.setFont('Helvetica', 7); c.drawString(kx, ky - 7 * mm, 'UNIT TYPE A SHOWN SHADED')

# ---- title block
tx, ty, tw, th = W - 215 * mm, 15 * mm, 200 * mm, 120 * mm
c.setLineWidth(0.8); c.rect(tx, ty, tw, th)
rows = [(ty + th - 22 * mm, 'GREENLINE SAMPLE DRAWING', 'Helvetica-Bold', 13), (ty + th - 32 * mm, 'Not a real project - for demonstration only', 'Helvetica-Oblique', 8)]
for y, s, f, z in rows: c.setFont(f, z); c.drawString(tx + 5 * mm, y, s)
c.setLineWidth(0.4); c.line(tx, ty + th - 38 * mm, tx + tw, ty + th - 38 * mm)
fields = [('PROJECT', 'SAMPLE RESIDENTIAL BUILDING'), ('DRAWING', 'TYPICAL FLOOR PLAN - LEVELS 1 TO 12'), ('DRAWING NO.', 'GL-A-101'), ('SCALE', '1:100 @ A1'), ('REVISION', 'P1'), ('DATE', '09.11.2026')]
for i, (k, v) in enumerate(fields):
    y = ty + th - 46 * mm - i * 12 * mm
    c.setFont('Helvetica', 6.5); c.setFillColorRGB(0.35, 0.35, 0.35); c.drawString(tx + 5 * mm, y + 3 * mm, k)
    c.setFont('Helvetica-Bold', 9); c.setFillColorRGB(0, 0, 0); c.drawString(tx + 5 * mm, y - 1.5 * mm, v)
    c.line(tx, y - 4.5 * mm, tx + tw, y - 4.5 * mm)
# revision table
rx, ry = tx, ty + th + 5 * mm
c.rect(rx, ry, tw, 30 * mm)
c.setFont('Helvetica-Bold', 7)
for x, s in ((5, 'REV'), (20, 'DATE'), (50, 'DESCRIPTION'), (170, 'BY')): c.drawString(rx + x * mm, ry + 25 * mm, s)
c.setFont('Helvetica', 7)
for i, (r, d, s, b) in enumerate([('P1', '09.11.2026', 'ISSUED FOR TENDER', 'GL'), ('P0', '02.11.2026', 'FIRST ISSUE FOR COMMENT', 'GL')]):
    y = ry + 19 * mm - i * 6 * mm
    for x, t in ((5, r), (20, d), (50, s), (170, b)): c.drawString(rx + x * mm, y, t)

c.showPage(); c.save()
print('written', out)
