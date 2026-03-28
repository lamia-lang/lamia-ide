# Lamia Studio

A lightweight IDE for the [Lamia](https://github.com/user/lamia) language.

## What's Included

| Component | Purpose |
|---|---|
| `build.sh` | Bundles extension + branding, produces distributable |
| `extension/` | VS Code extension: `.lm` / `.hu` syntax highlighting, run button, lamia CLI integration |
| `branding/` | Custom product name, icons, welcome page |
| `defaults/` | Beginner-friendly `settings.json` shipped out of the box |

## Download

Grab the latest release for your platform from the
[Releases](../../releases) page:

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `LamiaStudio-*-darwin-arm64.dmg` |
| macOS (Intel) | `LamiaStudio-*-darwin-x64.dmg` |
| Linux (x64) | `LamiaStudio-*-linux-x64.tar.gz` |
| Windows (x64) | `LamiaStudio-*-win32-x64.zip` |

## Building from Source

**Prerequisite:** [Pillow](https://pillow.readthedocs.io/) is required to generate icons and in-app branding assets (welcome backgrounds, watermarks). Install it once:

```bash
pip install Pillow
```

Then build:

```bash
# Builds for your current platform, output goes to dist/out/
./build.sh
```

`build.sh` auto-runs `scripts/generate-icons.py` and `scripts/generate-branding.py` if their outputs are missing. You can also run them manually beforehand.

## Releasing

Push a version tag to trigger the CI release workflow, which builds for all
platforms and creates a draft GitHub Release with all deliverables attached:

```bash
git tag v1.0.0
git push origin v1.0.0
```

You can also trigger a release manually from the Actions tab via "Run workflow".

## Renaming the App

Edit `APP_NAME` at the top of `build.sh` — the app name, bundle identifier, data folder, and
release title are all derived from it automatically:

```bash
APP_NAME="Lamia Studio"
```

## Updating the Editor Base

Edit `EDITOR_VERSION` in `build.sh` and re-run `./build.sh`:

```bash
EDITOR_VERSION="1.100.33714"
```

## Project Structure

```
lamia-ide/
├── build.sh                        # Build script (one platform at a time)
├── .github/workflows/release.yml   # CI: builds all platforms, creates release
├── scripts/
│   ├── generate-icons.py           # Generates .icns / .ico / .png from source art
│   └── generate-branding.py        # Generates welcome PNGs, letterpress & code-icon SVGs
├── branding/
│   ├── product.json                # App name, URLs, telemetry overrides
│   └── icons/                      # App icons (replace with real assets)
├── defaults/
│   └── settings.json               # Beginner-friendly editor defaults
└── extension/
    ├── package.json                # VS Code extension manifest
    ├── syntaxes/
    │   ├── lm.tmLanguage.json      # .lm syntax grammar
    │   └── hu.tmLanguage.json      # .hu syntax grammar
    └── lamia.code-snippets         # Handy snippets for new users
```
