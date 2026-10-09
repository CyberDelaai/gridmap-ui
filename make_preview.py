#!/usr/bin/env python3
"""Render previews/og-<lang>.png — the 1200x630 social / og:image previews of
GRIDMAP, one per UI language.

Shared cyberdeck.tools layout: dark grid background, "> GRIDMAP" +
cyberdeck.tools on the left, the artwork in the middle, the translated tagline
on the right. The artwork is real app output: the script loads the tool's own
language page (./ or ./<lang>/, see make_langs.py) in a hidden frame, sets up
its state, and catches the PNG the app's own export produces — so the preview
follows the app (and its UI / calendar language) without hand edits.

How: serves this folder on a local port and screenshots a layout page with
headless Chrome/Edge, once per language. Fonts come from Google Fonts, so a
network connection is needed. Run make_langs.py first (the language pages must
exist), and re-run make_langs.py afterwards so every page points at its image.

Usage:
    python make_preview.py              # all 8 languages
    python make_preview.py ru de        # just these
    python make_preview.py --html out.html   # also keep the layout page

Browser lookup: $CHROME, then chrome/chromium/msedge on PATH, then the usual
install locations on Windows / macOS.
"""
import argparse
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "previews"
PAGE = "_preview.html"  # written into ROOT while rendering, then removed
W, H = 1200, 630
LANGS = ["en", "ru", "fr", "de", "es", "it", "ja", "zh"]

# ---- per-tool setup -----------------------------------------------------------
NAME = 'GRIDMAP'
GLOW = '#00e9ff'          # artwork halo colour
TILT = 0                # artwork rotation, degrees
ART_W, ART_H = 430, 430  # artwork box (px); the export is scaled to fit
# right-hand tagline per language: two big lines + a small one
TAGLINES = {
    'en': ('GRID', 'DETECTOR', 'for battle maps & VTT'),
    'ru': ('АНАЛИЗАТОР', 'СЕТКИ', 'для боевых карт и VTT'),
    'fr': ('ANALYSEUR', 'DE GRILLE', 'pour cartes de combat'),
    'de': ('RASTER-', 'ANALYSE', 'für Battlemaps & VTT'),
    'es': ('ANALIZADOR', 'DE CUADRÍCULA', 'para mapas de batalla'),
    'it': ('ANALIZZATORE', 'DI GRIGLIA', 'per mappe di battaglia'),
    'ja': ('グリッド', '解析', '戦闘マップ・VTT向け'),
    'zh': ('网格地图', '分析器', '适用于战斗地图与 VTT'),
}
# JS run in the layout page before the app loads (LANG = language code)
SETUP_JS = """// the example battle map (map.png, next to this script) is dropped in once the app is up"""
# JS expression polled until true (w / d = the app frame's window / document)
READY_JS = """d.getElementById('dropzone') && w.GM"""
# JS that triggers the app's own PNG export
EXPORT_JS = """(async () => {
      // drop map.png onto the app like a user would, wait for the grid, then
      // hand back the map with its detected grid drawn over it
      const blob = await (await fetch('map.png')).blob();
      const dt = new w.DataTransfer();
      dt.items.add(new w.File([blob], 'map.png', { type: 'image/png' }));
      d.getElementById('dropzone').dispatchEvent(new w.DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const mapC = d.getElementById('mapCanvas'), gridC = d.getElementById('gridCanvas');
      for (let i = 0; i < 150 && !(w.GM.state.loaded && !d.getElementById('exportBtn').disabled); i++) await sleep(100);
      // map.png has no printed grid and AUTO over-estimates it, so set the cell
      // the way a user would with DRAW CELL: open it, type the SIZE, close it.
      const CELL = 50;   // px per cell on the 1000 px map -> a 20x20 grid
      d.getElementById('drawBtn').click();
      w.GM.state.drawnCell = { x: 0, y: 0, w: CELL, h: CELL };
      d.getElementById('cellX').value = 0; d.getElementById('cellY').value = 0;
      const size = d.getElementById('cellSize');
      size.value = CELL; size.dispatchEvent(new w.Event('change'));
      d.getElementById('drawBtn').click();
      await sleep(400);
      const c = d.createElement('canvas');
      c.width = mapC.width; c.height = mapC.height;
      const g = c.getContext('2d');
      g.drawImage(mapC, 0, 0);
      g.drawImage(gridC, 0, 0, c.width, c.height);
      const a = d.createElement('a');
      a.download = 'preview.png'; a.href = c.toDataURL('image/png'); a.click();
    })();"""
# -------------------------------------------------------------------------------


def build_html():
    taglines = json.dumps(TAGLINES, ensure_ascii=False)
    return (TEMPLATE
            .replace("%NAME%", NAME)
            .replace("%TAGLINES%", taglines)
            .replace("%SETUP%", SETUP_JS)
            .replace("%READY%", READY_JS)
            .replace("%EXPORT%", EXPORT_JS)
            .replace("%GLOW%", GLOW)
            .replace("%TILT%", str(TILT))
            .replace("%ART_W%", str(ART_W))
            .replace("%ART_H%", str(ART_H)))


TEMPLATE = r"""<!DOCTYPE html>
<html><head><meta charset="UTF-8" />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Noto+Sans+JP:wght@400;700&family=Noto+Sans+SC:wght@400;700&display=swap" rel="stylesheet" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    position: relative;
    font-family: 'JetBrains Mono', 'Noto Sans JP', monospace;
    background-color: #0a0c10;
    /* 40px grid, same pitch / phase / tint across every tool's preview */
    background-image:
      linear-gradient(to right, rgba(0, 233, 255, 0.07) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(0, 233, 255, 0.07) 1px, transparent 1px);
    background-size: 40px 40px;
    background-position: 23px 35px;
  }
  body.zh { font-family: 'JetBrains Mono', 'Noto Sans SC', monospace; }
  .left { position: absolute; left: 65px; top: 255px; }
  .logo { color: #ffe500; font-weight: 700; font-size: 46px; line-height: 1; letter-spacing: 1px; white-space: nowrap; }
  .site { color: #8a97a3; font-size: 19px; margin-top: 30px; }
  .right { position: absolute; right: 65px; top: 50%; transform: translateY(-50%); text-align: right; width: 290px; }
  .tag { color: #00e9ff; font-weight: 700; font-size: 34px; line-height: 1.45; letter-spacing: 1px; white-space: nowrap; }
  .sub { color: #8a97a3; font-size: 19px; margin-top: 14px; white-space: nowrap; }
  /* Japanese / Chinese: the tagline is set vertically, columns right to left */
  body.ja .right, body.zh .right {
    writing-mode: vertical-rl; text-orientation: mixed;
    top: 95px; right: 80px; transform: none; width: auto; height: 440px; text-align: center;
  }
  /* CJK font first: its vertical forms turn ー, 、 and brackets upright */
  body.ja .right { font-family: 'Noto Sans JP', 'JetBrains Mono', sans-serif; }
  body.zh .right { font-family: 'Noto Sans SC', 'JetBrains Mono', sans-serif; }
  body.ja .tag, body.zh .tag { font-size: 42px; line-height: 1.3; letter-spacing: 6px; }
  body.ja .tcy, body.zh .tcy { text-combine-upright: all; }
  body.ja .sub, body.zh .sub { font-size: 20px; letter-spacing: 3px; margin: 0 22px 0 0; }
  #art {
    position: absolute; left: 620px; top: 50%;
    transform: translate(-50%, -50%) rotate(%TILT%deg);
    filter: drop-shadow(0 0 22px %GLOW%) drop-shadow(0 0 4px %GLOW%);
  }
  #frame { position: absolute; left: -5000px; top: 0; width: 1440px; height: 1000px; border: 0; }
</style>
</head><body>
  <div class="left"><div class="logo">&gt; %NAME%</div><div class="site">cyberdeck.tools</div></div>
  <div class="right"><div class="tag" id="t1"></div><div class="tag" id="t2"></div><div class="sub" id="t3"></div></div>
  <img id="art" alt="" />
<script>
(async () => {
  const LANG = new URLSearchParams(location.search).get('lang') || 'en';
  const TAG = %TAGLINES%[LANG];
  document.body.classList.add(LANG);
  document.documentElement.lang = LANG;
  ['t1', 't2', 't3'].forEach((id, i) => { document.getElementById(id).textContent = TAG[i]; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // per-tool state, written before the app loads (same origin = same storage)
  %SETUP%

  const frame = document.createElement('iframe');
  frame.id = 'frame';
  frame.src = LANG === 'en' ? './' : './' + LANG + '/';
  document.body.appendChild(frame);
  await new Promise((r) => frame.addEventListener('load', r, { once: true }));
  const w = frame.contentWindow, d = frame.contentDocument;
  // Chrome pauses requestAnimationFrame in a frame it isn't painting (this one
  // is off-screen), which stalls exports that wait a frame: run rAF on a timer.
  w.requestAnimationFrame = (cb) => w.setTimeout(() => cb(w.performance.now()), 16);
  for (let i = 0; i < 200 && !(%READY%); i++) await sleep(100);
  await sleep(600); // let the last render / font swap settle

  // Catch the app's download instead of saving it: its export clicks an
  // <a download> — resolve with that href (and keep blob: URLs alive).
  const href = await new Promise((resolve) => {
    w.URL.revokeObjectURL = () => {};
    const click = w.HTMLAnchorElement.prototype.click;
    w.HTMLAnchorElement.prototype.click = function () {
      if (this.download) return resolve(this.href);
      return click.call(this);
    };
    %EXPORT%
  });

  const art = document.getElementById('art');
  await new Promise((r) => { art.onload = r; art.src = href; });
  const k = Math.min(%ART_W% / art.naturalWidth, %ART_H% / art.naturalHeight);
  art.style.width = Math.round(art.naturalWidth * k) + 'px';
  art.style.height = Math.round(art.naturalHeight * k) + 'px';

  // shrink a tagline line that would overflow its column (long words, CJK)
  await document.fonts.ready;
  const vertical = LANG === 'ja' || LANG === 'zh';
  // vertical CJK: set short Latin / digit runs (ID, 2D…) upright side by side
  // (tate-chu-yoko) in the big lines; longer words like TRPG stay rotated
  if (vertical) document.querySelectorAll('.tag').forEach((el) => {
    el.innerHTML = el.textContent.replace(/(?<![A-Za-z0-9])[A-Za-z0-9]{1,2}(?![A-Za-z0-9])/g, '<span class="tcy">$&</span>');
  });
  document.querySelectorAll('.tag, .sub').forEach((el) => {
    let px = parseFloat(getComputedStyle(el).fontSize);
    const over = () => (vertical ? el.scrollHeight > 440 : el.scrollWidth > 290);
    while (over() && px > 12) el.style.fontSize = (px -= 1) + 'px';
  });
  frame.remove();
})();
</script>
</body></html>
"""


def find_browser():
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    for name in ("chrome", "google-chrome", "chromium", "chromium-browser", "msedge"):
        p = shutil.which(name)
        if p:
            return p
    for p in (
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ):
        if Path(p).exists():
            return p
    sys.exit("No Chrome/Edge found — set $CHROME to a Chromium-based browser.")


def render(langs, page_html):
    browser = find_browser()

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    page = ROOT / PAGE
    page.write_text(page_html, encoding="utf-8")
    OUT_DIR.mkdir(exist_ok=True)
    from PIL import Image
    try:
        for lang in langs:
            if lang != "en" and not (ROOT / lang / "index.html").exists():
                print(f"skip {lang}: {lang}/index.html missing — run make_langs.py first")
                continue
            with tempfile.TemporaryDirectory() as tmp:
                shot = Path(tmp) / "shot.png"
                subprocess.run([
                    browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=1", f"--window-size={W},{H}",
                    "--virtual-time-budget=25000",  # app load + export + fonts before the shot
                    f"--user-data-dir={Path(tmp) / 'profile'}",  # fresh storage every run
                    f"--screenshot={shot}", f"http://127.0.0.1:{server.server_port}/{PAGE}?lang={lang}",
                ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                img = Image.open(shot).convert("RGB")
                if img.size != (W, H):  # headless may hand back a slightly different canvas
                    canvas = Image.new("RGB", (W, H), (10, 12, 16))
                    canvas.paste(img.crop((0, 0, min(W, img.width), min(H, img.height))))
                    img = canvas
                out = OUT_DIR / f"og-{lang}.png"
                img.save(out, optimize=True)
                print(f"wrote previews/{out.name}")
    finally:
        page.unlink(missing_ok=True)
        server.shutdown()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("langs", nargs="*", help="languages to render (default: all)")
    ap.add_argument("--html", type=Path, help="also write the layout page here")
    args = ap.parse_args()
    bad = [l for l in args.langs if l not in LANGS]
    if bad:
        sys.exit(f"unknown language(s): {', '.join(bad)} — use {', '.join(LANGS)}")
    page = build_html()
    if args.html:
        args.html.write_text(page, encoding="utf-8")
    render(args.langs or LANGS, page)


if __name__ == "__main__":
    main()
