#!/usr/bin/env python3
"""Build artifact/aria.html (the claude.ai version) from artifact/template.html,
inlining the shared stylesheet, character and timer modules from public/."""
from pathlib import Path

root = Path(__file__).parent
page = (root / "artifact/template.html").read_text()
for marker, src in [("/*__STYLES__*/", "public/styles.css"), ("/*__AVATAR__*/", "public/avatar.js"), ("/*__POMODORO__*/", "public/pomodoro.js")]:
    code = (root / src).read_text().replace("export class ", "class ").replace("export function ", "function ")
    assert marker in page, marker
    page = page.replace(marker, code)
(root / "artifact/aria.html").write_text(page)
print("wrote artifact/aria.html")
