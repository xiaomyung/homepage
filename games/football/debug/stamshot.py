import os
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(HERE, "screenshots")
os.makedirs(OUTDIR, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1800, "height": 1000}, ignore_https_errors=True)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(f"PAGE: {e}"))
    page.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.goto("https://xiaomyung.com/games/football/test-renderer.html", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(3000)
    page.evaluate("document.getElementById('s-stamina').scrollIntoView({block:'center'})")
    page.wait_for_timeout(300)
    for i in range(6):
        page.wait_for_timeout(500)
        page.locator("#s-stamina").screenshot(path=os.path.join(OUTDIR, f"stam2_{i}.png"))
    if errs:
        print("ERRORS:"); [print(" ", e) for e in errs]
    else:
        print("OK")
    browser.close()
