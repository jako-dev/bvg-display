#!/usr/bin/env bash
#
# Regenerates preview/index.html — a listing of the branch previews currently
# published, so /preview/ is a usable page rather than a 404 you have to guess
# paths against.
#
# Usage: preview-index.sh <path-to-gh-pages-worktree>

set -euo pipefail

SITE_DIR="${1:?usage: preview-index.sh <site-dir>}"
PREVIEW_DIR="$SITE_DIR/preview"

# No previews left: drop the listing rather than leave an empty page behind.
if [ ! -d "$PREVIEW_DIR" ] || [ -z "$(find "$PREVIEW_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]; then
    rm -f "$PREVIEW_DIR/index.html"
    rmdir "$PREVIEW_DIR" 2>/dev/null || true
    echo "No previews — removed the listing."
    exit 0
fi

escape_html() {
    sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

{
    cat <<'HTML'
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Vorschau-Deployments — BVG Abfahrtsmonitor</title>
<style>
  :root {
    --surface-0: #0c0d0f; --surface-1: #131519; --surface-2: #1b1e24;
    --text-1: #f2f4f7; --text-2: #a8b0bd; --text-3: #6c7684;
    --line: #23262d; --accent: #6aa5ff;
    color-scheme: dark;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: var(--surface-0); color: var(--text-1);
    padding: 48px 24px; display: flex; justify-content: center;
    -webkit-font-smoothing: antialiased;
  }
  main { width: 100%; max-width: 640px; }
  h1 { font-size: 1.5rem; font-weight: 650; letter-spacing: -0.02em; }
  .lede { color: var(--text-3); margin: 8px 0 28px; font-size: 0.8125rem; }
  ul { list-style: none; display: flex; flex-direction: column; gap: 8px; }
  a.card {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 14px 16px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--surface-1); color: var(--text-1); text-decoration: none;
    transition: border-color 120ms, background 120ms;
  }
  a.card:hover { border-color: var(--accent); background: var(--surface-2); }
  .name { font-weight: 650; word-break: break-word; }
  .go { color: var(--text-3); flex-shrink: 0; }
  footer { margin-top: 32px; font-size: 0.6875rem; color: var(--text-3); }
  footer a { color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>Vorschau-Deployments</h1>
<p class="lede">Branches, die ohne Merge nach <code>main</code> veröffentlicht wurden. Werden automatisch entfernt, sobald der Branch gelöscht wird.</p>
<ul>
HTML

    # -maxdepth 1 -type d: one entry per preview, ignoring their contents.
    find "$PREVIEW_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort | while IFS= read -r slug; do
        safe=$(printf '%s' "$slug" | escape_html)
        printf '  <li><a class="card" href="./%s/"><span class="name">%s</span><span class="go">&rarr;</span></a></li>\n' "$safe" "$safe"
    done

    cat <<'HTML'
</ul>
<footer>Die Live-Version liegt unter <a href="../">../</a>.</footer>
</main>
</body>
</html>
HTML
} > "$PREVIEW_DIR/index.html"

count=$(find "$PREVIEW_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)
echo "Wrote preview/index.html listing $count preview(s)."
