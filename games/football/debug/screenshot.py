#!/usr/bin/env python3
"""
Take a headless screenshot of the football test-renderer page.

Usage (from any cwd):
  /srv/services/web/homepage/venv/bin/python3 \
      /srv/services/web/homepage/games/football/debug/screenshot.py [out.png]

Defaults to saving alongside this script as ./shot.png. Pass an
alternative path as the first argument to override.
"""
import os
import sys
from playwright.sync_api import sync_playwright

URL = "https://xiaomyung.com/games/football/test-renderer.html"
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shot.png")
OUT = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(
        viewport={"width": 1600, "height": 900},
        ignore_https_errors=True,
    )
    page = ctx.new_page()
    page.goto(URL, wait_until="networkidle", timeout=20000)
    # wait a bit for atlas generation + first frame
    page.wait_for_timeout(1500)
    page.screenshot(path=OUT, full_page=True)
    browser.close()

print(f"saved: {OUT}")
