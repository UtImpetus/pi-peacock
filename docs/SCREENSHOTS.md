# README screenshots on NixOS

The current README screenshots are SVG terminal captures from temporary demo repos.

## Recommended NixOS workflow

On NixOS, the most reliable path is:

1. capture the terminal with `script` (from `util-linux`)
2. convert the `script` log to asciicast v2 JSON
3. render a still SVG with `svg-term-cli`

This works well even when `termtosvg` packaging is inconvenient.

## Capture

Use a temporary demo repo and open the exact `pi-peacock` state you want to show.

If you want to run directly from this checkout:

```bash
TMP="$(mktemp -d)"

script -q -O "$TMP/out.log" -T "$TMP/timing.log" -m classic \
  -c 'cd /tmp/demo-repo && \
      PI_OFFLINE=1 \
      pi --offline --no-extensions --no-builtin-tools \
         -e /path/to/pi-peacock/extensions/repo-peacock.ts \
         --theme /path/to/pi-peacock/themes \
         "/peacock"' \
  >/dev/null
```

If `pi-peacock` is already installed in pi, you can simplify that to:

```bash
TMP="$(mktemp -d)"

script -q -O "$TMP/out.log" -T "$TMP/timing.log" -m classic \
  -c 'cd /tmp/demo-repo && PI_OFFLINE=1 pi --offline "/peacock"' \
  >/dev/null
```

## Convert to asciicast

```bash
python3 - <<'PY' "$TMP/out.log" "$TMP/timing.log" > "$TMP/demo.cast"
import codecs
import json
import sys
from pathlib import Path

out_file = Path(sys.argv[1])
timing_file = Path(sys.argv[2])
width = 100
height = 28

data = out_file.read_bytes()
pos = 0
records = []
for raw in timing_file.read_text().splitlines():
    raw = raw.strip()
    if not raw:
        continue
    delay_s, count_s = raw.split()[:2]
    delay = float(delay_s)
    count = int(count_s)
    chunk = data[pos:pos + count]
    pos += count
    records.append((delay, chunk))

print(json.dumps({"version": 2, "width": width, "height": height}))

decoder = codecs.getincrementaldecoder("utf-8")("replace")
elapsed = 0.0
for delay, chunk in records:
    elapsed += delay
    text = decoder.decode(chunk, final=False)
    if text:
        print(json.dumps([round(elapsed, 6), "o", text], ensure_ascii=False))
remaining = decoder.decode(b"", final=True)
if remaining:
    print(json.dumps([round(elapsed, 6), "o", remaining], ensure_ascii=False))
PY
```

The `100x28` size matches the current README screenshots.

## Render SVG

```bash
npx -y svg-term-cli \
  --in "$TMP/demo.cast" \
  --out docs/auto-settings.svg \
  --window \
  --width 100 \
  --height 28 \
  --at 700 \
  --no-cursor
```

Notes:

- `--at 700` picks a stable frame after the UI has settled; adjust if needed.
- The incremental UTF-8 decode above avoids the broken replacement glyphs that can appear if multi-byte characters are split across timing chunks.
- Keep captures in temporary demo repos and sanitize repo names, branches, and paths before committing.
- Current README screenshot filenames are:
  - `docs/auto-settings.svg`
  - `docs/rule-settings.svg`
  - `docs/footer-settings.svg`
  - `docs/auto-demo.svg`
  - `docs/rule-demo.svg`
  - `docs/footer-demo.svg`
