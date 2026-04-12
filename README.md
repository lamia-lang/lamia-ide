# Lamia Studio

A lightweight IDE for the [Lamia](https://github.com/lamia-lang/lamia) programming language, built on VSCodium.

[![Release](https://img.shields.io/github/v/release/lamia-lang/lamia-ide?label=Download&style=for-the-badge)](https://github.com/lamia-lang/lamia-ide/releases/latest)

## Building from Source (Recommended for macOS & Windows)

Building locally is the easiest way to get started on **macOS** and **Windows** — it avoids Gatekeeper / SmartScreen warnings entirely since the app is built on your machine.

**Prerequisites:** [Node.js](https://nodejs.org/) and [Python 3.10+](https://www.python.org/downloads/)

```bash
git clone https://github.com/lamia-lang/lamia-ide.git
cd lamia-ide
./build.sh
```

On macOS the output is a DMG in `dist/out/`. On Windows it produces a ZIP. Since you built it locally, no code-signing warnings will appear.

> **Note:** Icons and branding assets are pre-built and included in the repository. [Pillow](https://pillow.readthedocs.io/) is only needed if you want to regenerate them from the source design files (`pip install Pillow && python3 scripts/generate-icons.py`).

## Pre-built Releases

Pre-built binaries are available for all platforms. On **Linux** this is the recommended approach (no signing issues). On macOS and Windows the binaries work but require a one-time workaround for unsigned-app warnings — see below.

| Platform | Download | Notes |
|---|---|---|
| **macOS** (Apple Silicon) | [`LamiaStudio-*-darwin-arm64.dmg`](https://github.com/lamia-lang/lamia-ide/releases/latest) | See [macOS](#macos) below |
| **macOS** (Intel) | [`LamiaStudio-*-darwin-x64.dmg`](https://github.com/lamia-lang/lamia-ide/releases/latest) | See [macOS](#macos) below |
| **Linux** (x64) | [`LamiaStudio-*-linux-x64.tar.gz`](https://github.com/lamia-lang/lamia-ide/releases/latest) | Extract and run |
| **Windows** (x64) | [`LamiaStudio-*-win32-x64.zip`](https://github.com/lamia-lang/lamia-ide/releases/latest) | See [Windows](#windows) below |

### Prerequisites

**Python 3.10+** is required for running Lamia code and the built-in chat. The IDE itself (editing, syntax highlighting, file navigation) works without Python.

### macOS

Lamia Studio is not notarized (no Apple Developer license — this is an open-source project). macOS Gatekeeper will block the first launch. To fix this:

1. Open the DMG, drag **Lamia Studio** to Applications
2. **Do not double-click to open.** Instead, run this once in Terminal:
   ```bash
   xattr -cr "/Applications/Lamia Studio.app"
   ```
3. Now open Lamia Studio normally — it will work from here on

Alternatively, right-click the app → **Open** → click **Open** in the dialog. This also creates a permanent Gatekeeper exception, but may need to be done twice.

### Windows

The app is not signed with a code-signing certificate. Windows SmartScreen may show **"Windows protected your PC"** on first launch:

1. Click **More info**
2. Click **Run anyway**

This only happens once.

### Linux

Extract the tarball and run. No signing issues.

```bash
tar -xzf LamiaStudio-*-linux-x64.tar.gz
cd LamiaStudio-*
./bin/codium
```

## What's Included

| Component | Purpose |
|---|---|
| `build.sh` | Bundles extension + branding, produces distributable |
| `extension/` | VS Code extension: `.lm` / `.hu` syntax highlighting, chat, run button, lamia CLI integration |
| `branding/` | Custom product name, icons, welcome page |
| `defaults/` | Beginner-friendly `settings.json` shipped out of the box |

## Launch from Terminal

If you have the `lamia` CLI installed, you can open the IDE from any directory:

```bash
lamia .
```

## Releasing

Push a version tag to trigger the CI release workflow:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This builds for all platforms and creates a GitHub Release with all deliverables attached. You can also trigger a release manually from the Actions tab.