"""DitCopy app icon, graphite tile, white letter, glowing ring and dial ticks.

Writes ditcopy-icon.svg, renders icon-1024.png through headless Chrome (transparent background), then builds icon.icns,
icon.ico and the PNG set in icons/. Needs Chrome (or Chromium) and, for icon.icns, macOS iconutil.
"""
import math
C = 512
def squircle(a=412, n=4.5, steps=720):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = a * math.copysign(abs(c) ** (2 / n), c); y = a * math.copysign(abs(s) ** (2 / n), s)
        pts.append((C + x, C + y))
    return 'M ' + ' L '.join(f'{x:.1f},{y:.1f}' for x, y in pts) + ' Z'
def pol(r, deg):
    a = math.radians(deg - 90)
    return C + r * math.cos(a), C + r * math.sin(a)
# 24 ticks like a frame dial; the 4 quarter ticks are longer
ticks = []
for k in range(24):
    major = k % 6 == 0
    r1, r2 = (322, 350) if major else (330, 346)
    x1, y1 = pol(r1, k * 15); x2, y2 = pol(r2, k * 15)
    op = 0.55 if major else 0.26
    w = 7 if major else 5
    ticks.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#fff" stroke-opacity="{op}" stroke-width="{w}" stroke-linecap="round"/>')
R = 276                      # progress ring radius
SWEEP = 306                  # degrees of green progress, clockwise from 12 o'clock (a copy that is nearly verified)
def arc(r, a0, a1):
    x0, y0 = pol(r, a0); x1, y1 = pol(r, a1); large = 1 if (a1 - a0) % 360 > 180 else 0
    return f'M {x0:.1f},{y0:.1f} A {r},{r} 0 {large} 1 {x1:.1f},{y1:.1f}'
ex, ey = pol(R, SWEEP)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2c35"/><stop offset=".45" stop-color="#17171c"/><stop offset="1" stop-color="#0c0c10"/></linearGradient>
    <radialGradient id="sheen" cx=".5" cy="0" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".5" stop-color="#fff" stop-opacity=".02"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <radialGradient id="ambient" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#2fd6a0" stop-opacity=".10"/><stop offset="1" stop-color="#2fd6a0" stop-opacity="0"/></radialGradient>
    <linearGradient id="bezel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b8f9f" stop-opacity=".75"/><stop offset=".5" stop-color="#3a3b46" stop-opacity=".25"/><stop offset="1" stop-color="#050507" stop-opacity=".9"/></linearGradient>
    <linearGradient id="accent" gradientUnits="userSpaceOnUse" x1="{C-R}" y1="{C-R}" x2="{C+R}" y2="{C+R}"><stop offset="0" stop-color="#7cf5c9"/><stop offset=".55" stop-color="#27c98f"/><stop offset="1" stop-color="#139a70"/></linearGradient>
    <linearGradient id="pfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d9dbe6"/></linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="150%" filterUnits="objectBoundingBox"><feDropShadow dx="0" dy="22" stdDeviation="24" flood-color="#000" flood-opacity=".55"/></filter>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="pshadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity=".55"/></filter>
    <filter id="noise" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" result="n"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .05 0"/></filter>
    <clipPath id="tileclip"><path d="{squircle()}"/></clipPath>
  </defs>
  <g filter="url(#drop)"><path d="{squircle()}" fill="url(#tile)"/></g>
  <g clip-path="url(#tileclip)">
    <rect width="1024" height="1024" fill="url(#sheen)"/>
    <rect width="1024" height="1024" filter="url(#noise)" opacity=".7"/>
    <circle cx="{C}" cy="{C}" r="400" fill="url(#ambient)"/>
    {''.join(ticks)}
    <path d="{arc(R, 0, 359.9)}" fill="none" stroke="#fff" stroke-opacity=".07" stroke-width="26"/>
    <path d="{arc(R, 0, SWEEP)}" fill="none" stroke="#2fd6a0" stroke-opacity=".7" stroke-width="30" filter="url(#glow)"/>
    <path d="{arc(R, 0, SWEEP)}" fill="none" stroke="url(#accent)" stroke-width="26" stroke-linecap="round"/>
    <path d="{arc(R, 2, SWEEP-2)}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="5" stroke-linecap="round" transform="translate(0,-5)"/>
    <circle cx="{ex:.1f}" cy="{ey:.1f}" r="46" fill="#4ce8b4" fill-opacity=".35" filter="url(#glow)"/>
    <circle cx="{ex:.1f}" cy="{ey:.1f}" r="27" fill="url(#accent)"/>
    <circle cx="{ex:.1f}" cy="{ey:.1f}" r="12" fill="#fff"/>
    <!-- geometric D, drawn as one round stroke -->
    <path d="M 397,372 V 652 H 487 A 140,140 0 0 0 487,372 Z" fill="none" stroke="url(#pfill)" stroke-width="66" stroke-linecap="round" stroke-linejoin="round" filter="url(#pshadow)"/>
  </g>
  <path d="{squircle(a=411.2)}" fill="none" stroke="url(#bezel)" stroke-width="2.6"/>
</svg>'''

import os, shutil, struct, subprocess, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__))
open(os.path.join(here, 'ditcopy-icon.svg'), 'w').write(svg)

def find_chrome():
    for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
              shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("chromium-browser") or "",
              r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"):
        if p and os.path.exists(p): return p
    sys.exit("No Chrome or Chromium found to render the SVG.")

with tempfile.TemporaryDirectory() as d:
    page = os.path.join(d, "icon.html")
    open(page, "w").write('<html><body style="margin:0;background:transparent">' + svg + '</body></html>')
    master = os.path.join(here, 'icon-1024.png')
    subprocess.run([find_chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
                    "--window-size=1024,1024", "--screenshot=" + master, "file://" + page], check=True, capture_output=True)
    icons = os.path.join(here, 'icons'); os.makedirs(icons, exist_ok=True)
    sizes = (16, 32, 48, 64, 128, 256, 512)
    def sips(px, out): subprocess.run(["sips", "-z", str(px), str(px), master, "--out", out], capture_output=True, check=True)
    have_sips = shutil.which("sips") is not None
    if have_sips:
        for s in sizes: sips(s, os.path.join(icons, f"ditcopy-{s}.png"))
        shutil.copy(master, os.path.join(icons, "ditcopy-1024.png"))
        # Windows .ico: PNG frames inside an ICO container
        frames = [(s, open(os.path.join(icons, f"ditcopy-{s}.png"), "rb").read()) for s in (16, 32, 48, 64, 128, 256)]
        ico = struct.pack("<HHH", 0, 1, len(frames)); offset = 6 + 16 * len(frames); data = b""
        for s, png in frames:
            ico += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(png), offset + len(data)); data += png
        open(os.path.join(here, "icon.ico"), "wb").write(ico + data)
    if shutil.which("iconutil") and have_sips:
        iset = os.path.join(d, "icon.iconset"); os.makedirs(iset)
        for s in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                sips(s * scale, os.path.join(iset, "icon_%dx%d%s.png" % (s, s, "@2x" if scale == 2 else "")))
        subprocess.run(["iconutil", "-c", "icns", iset, "-o", os.path.join(here, "icon.icns")], check=True)
print("wrote ditcopy-icon.svg, icon-1024.png, icons/, icon.ico, icon.icns")
