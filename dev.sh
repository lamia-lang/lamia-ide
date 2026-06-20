#!/usr/bin/env bash
set -euo pipefail

# ── dev.sh ────────────────────────────────────────────────────────────────────
# Fast dev loop: re-applies extension + branding + settings on top of an
# existing base build, then launches the app immediately.
#
# First time (no base build yet): runs build.sh automatically.
# Subsequent runs: ~5-10 seconds instead of a full rebuild.
#
# Usage:
#   ./dev.sh            # re-overlay + launch
#   ./dev.sh --no-launch  # re-overlay only (useful for CI / checking changes)
# ─────────────────────────────────────────────────────────────────────────────

LAUNCH=true
for arg in "$@"; do
    [ "${arg}" = "--no-launch" ] && LAUNCH=false
done

# ── Same config as build.sh ───────────────────────────────────────────────────
APP_NAME="Lamia Studio"
APP_TAGLINE="Write Lamia. Run anything."
DIST_DIR="dist"
WORK_DIR="${DIST_DIR}/work"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
    MINGW*|MSYS*|CYGWIN*) OS="Windows" ;;
esac

# ── Ensure base build exists ──────────────────────────────────────────────────
if [ ! -d "${WORK_DIR}" ]; then
    echo "No base build found in ${WORK_DIR}/."
    echo "Running full build.sh first (this only happens once)..."
    echo ""
    ./build.sh
    echo ""
    echo "Base build complete. Future runs of dev.sh will be fast."
    exit 0
fi

# ── Locate app bundle (same logic as build.sh) ────────────────────────────────
if [ "${OS}" = "Darwin" ]; then
    APP_BUNDLE="${WORK_DIR}/Lamia Studio.app"
    RESOURCES_DIR="${APP_BUNDLE}/Contents/Resources"
    EXTENSIONS_DIR="${RESOURCES_DIR}/app/extensions"
    PRODUCT_JSON="${RESOURCES_DIR}/app/product.json"
elif [ "${OS}" = "Windows" ]; then
    RESOURCES_DIR="${WORK_DIR}/resources"
    EXTENSIONS_DIR="${RESOURCES_DIR}/app/extensions"
    PRODUCT_JSON="${RESOURCES_DIR}/app/product.json"
else
    RESOURCES_DIR="${WORK_DIR}/resources"
    EXTENSIONS_DIR="${RESOURCES_DIR}/app/extensions"
    PRODUCT_JSON="${RESOURCES_DIR}/app/product.json"
fi

if [ ! -d "${RESOURCES_DIR}" ]; then
    echo "Error: base build looks broken (${RESOURCES_DIR} not found)."
    echo "Delete dist/work/ and re-run to trigger a full rebuild:"
    echo "  rm -rf dist/work && ./dev.sh"
    exit 1
fi

# ── Sync lamia engine from local source ───────────────────────────────────────
# Always use the sibling lamia repo so dev.sh runs latest uncommitted code.
LAMIA_REPO="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/lamia"
LAMIA_VENV="${HOME}/.lamia/venv"

if [ -f "${LAMIA_REPO}/pyproject.toml" ] && [ -d "${LAMIA_VENV}" ]; then
    echo "Syncing lamia engine from local source..."
    "${LAMIA_VENV}/bin/pip" install -e "${LAMIA_REPO}" --quiet 2>&1 \
        && echo "  OK (editable: ${LAMIA_REPO})" \
        || echo "  Warning: pip install -e failed; engine may be stale"
    if [ -f "lamia-version.txt" ]; then
        cp "lamia-version.txt" "${LAMIA_VENV}/.lamia-ide-version" 2>/dev/null || true
    fi
    find "${LAMIA_REPO}/lamia" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
elif [ -d "${LAMIA_VENV}" ]; then
    echo "Warning: sibling lamia repo not found at ${LAMIA_REPO}"
    echo "  Engine will use whatever version is installed in the venv."
fi

# ── Compile extension TypeScript ──────────────────────────────────────────────
echo "Compiling extension..."
(cd extension && ./node_modules/.bin/tsc -p ./ 2>&1) \
    && echo "  OK" \
    || { echo "  TypeScript errors above — fix them before launching."; exit 1; }

# ── Re-apply extension ────────────────────────────────────────────────────────
# Install to the USER extensions directory (not the app bundle) so that
# secondarySideBar viewsContainers contribution is honoured by VS Code.
# Also remove any stale copy from the app bundle to avoid conflicts.
rm -rf "${EXTENSIONS_DIR}/lamia-language" 2>/dev/null || true
rm -rf "${EXTENSIONS_DIR}/lamia-ide" 2>/dev/null || true
echo "Applying extension..."
APP_NAME_SLUG="$(echo "${APP_NAME}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
USER_EXT_BASE="${HOME}/.${APP_NAME_SLUG}/extensions"
EXT_NAME=$(python3 -c "import json; print(json.load(open('extension/package.json'))['name'])")
EXT_VER=$(python3 -c "import json; print(json.load(open('extension/package.json'))['version'])")
EXT_PUBLISHER=$(python3 -c "import json; print(json.load(open('extension/package.json'))['publisher'])")
EXT_ID="${EXT_PUBLISHER}.${EXT_NAME}-${EXT_VER}"
LAMIA_EXT_DIR="${USER_EXT_BASE}/${EXT_ID}"
rm -rf "${USER_EXT_BASE}/${EXT_PUBLISHER}.${EXT_NAME}-"* 2>/dev/null || true
mkdir -p "${LAMIA_EXT_DIR}"
cp -R extension/out/                  "${LAMIA_EXT_DIR}/out/"
cp -R extension/media                 "${LAMIA_EXT_DIR}/media"
cp    extension/package.json          "${LAMIA_EXT_DIR}/package.json"
cp -R extension/syntaxes              "${LAMIA_EXT_DIR}/syntaxes"
cp -R extension/icons                 "${LAMIA_EXT_DIR}/icons"
cp    extension/lamia.code-snippets   "${LAMIA_EXT_DIR}/lamia.code-snippets"
cp    extension/language-configuration-lm.json "${LAMIA_EXT_DIR}/language-configuration-lm.json"
cp    extension/language-configuration-hu.json "${LAMIA_EXT_DIR}/language-configuration-hu.json"
cp    models.json                              "${LAMIA_EXT_DIR}/models.json"
cp    lamia-version.txt                        "${LAMIA_EXT_DIR}/lamia-version.txt"

# Register extension and clear any obsolete markers
rm -f "${USER_EXT_BASE}/.obsolete"
cat > "${USER_EXT_BASE}/extensions.json" << EXTJSON
[{
  "identifier": {"id": "${EXT_PUBLISHER}.${EXT_NAME}"},
  "version": "${EXT_VER}",
  "location": {"\$mid": 1, "path": "${EXT_ID}", "scheme": "file"},
  "relativeLocation": "${EXT_ID}",
  "metadata": {"installedTimestamp": 0}
}]
EXTJSON
echo "  OK"

# ── Re-apply product.json ─────────────────────────────────────────────────────
if [ -f branding/product.json ] && command -v python3 &>/dev/null; then
    echo "Applying product.json..."
    APP_NAME_SLUG="$(echo "${APP_NAME}"  | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
    APP_NAME_COMPACT="$(echo "${APP_NAME}" | tr -d ' -' | tr '[:upper:]' '[:lower:]')"
    APP_NAME_BUNDLE_ID="com.$(echo "${APP_NAME_SLUG}" | tr '-' '.')"
    python3 -c "
import json
with open('${PRODUCT_JSON}') as f: base = json.load(f)
with open('branding/product.json') as f: overrides = json.load(f)
overrides['nameShort'] = '${APP_NAME}'
overrides['nameLong']  = '${APP_NAME}'
overrides['applicationName']      = '${APP_NAME_SLUG}'
overrides['dataFolderName']       = '.${APP_NAME_SLUG}'
overrides['win32MutexName']       = '${APP_NAME_COMPACT}'
overrides['urlProtocol']          = '${APP_NAME_SLUG}'
overrides['darwinBundleIdentifier'] = '${APP_NAME_BUNDLE_ID}'
base.update(overrides)
with open('${PRODUCT_JSON}', 'w') as f: json.dump(base, f, indent=2)
"
    echo "  OK"
fi

# ── Re-apply icons ────────────────────────────────────────────────────────────
echo "Applying icons..."
if [ "${OS}" = "Darwin" ]; then
    if [ -f branding/icons/lamia.icns ]; then
        cp branding/icons/lamia.icns "${RESOURCES_DIR}/VSCodium.icns"
        cp branding/icons/lamia.icns "${RESOURCES_DIR}/lamia.icns"
    fi
    INFO_PLIST="${APP_BUNDLE}/Contents/Info.plist"
    if [ -f "${INFO_PLIST}" ]; then
        plutil -replace CFBundleIconFile -string "lamia" "${INFO_PLIST}" 2>/dev/null || true
    fi
elif [ "${OS}" = "Windows" ]; then
    if [ -f branding/icons/lamia.ico ]; then
        find "${WORK_DIR}" -name "*.ico" -path "*/resources/*" | while read -r ico; do
            cp branding/icons/lamia.ico "${ico}"
        done
    fi
else
    if [ -f branding/icons/lamia-256.png ]; then
        find "${WORK_DIR}" -name "code.png" -path "*/resources/*" | while read -r png; do
            cp branding/icons/lamia-256.png "${png}"
        done
    fi
fi
echo "  OK"

# ── Re-apply in-app branding assets ──────────────────────────────────────────
echo "Applying branding assets..."
OUT_MEDIA="${RESOURCES_DIR}/app/out/media"
WELCOME_MEDIA="${RESOURCES_DIR}/app/out/vs/workbench/contrib/welcomeGettingStarted/common/media"

[ -f branding/code-icon.svg ] && cp branding/code-icon.svg "${OUT_MEDIA}/code-icon.svg"
for variant in dark light hcDark hcLight; do
    [ -f "branding/letterpress-${variant}.svg" ] && \
        cp "branding/letterpress-${variant}.svg" "${OUT_MEDIA}/letterpress-${variant}.svg"
done
for variant in dark light dark-hc light-hc; do
    [ -f "branding/welcome-${variant}.png" ] && \
        cp "branding/welcome-${variant}.png" "${WELCOME_MEDIA}/${variant}.png"
done
echo "  OK"

# ── Re-apply default settings ─────────────────────────────────────────────────
if [ -f defaults/settings.json ]; then
    echo "Applying default settings..."
    if [ "${OS}" = "Darwin" ]; then
        SETTINGS_DIR="${APP_BUNDLE}/Contents/Resources/app/out/vs/workbench"
    else
        SETTINGS_DIR="${WORK_DIR}/resources/app/out/vs/workbench"
    fi
    mkdir -p "${SETTINGS_DIR}"
    cp defaults/settings.json "${SETTINGS_DIR}/defaultSettings.json"
    echo "  OK"
fi

if [ "${OS}" = "Darwin" ]; then
    echo "Re-signing..."
    xattr -cr "${APP_BUNDLE}" 2>/dev/null || true
    codesign --force --sign - "${APP_BUNDLE}" 2>/dev/null || true
    echo "  OK"
fi

# ── Launch ────────────────────────────────────────────────────────────────────
echo ""
echo "Done. Changes applied."

if [ "${LAUNCH}" = "true" ]; then
    if [ "${OS}" = "Darwin" ]; then
        if pgrep -f "${APP_BUNDLE}" &>/dev/null; then
            echo "Quitting running instance..."
            pkill -f "${APP_BUNDLE}" || true
            sleep 1
        fi
        echo "Launching ${APP_NAME}..."
        MACOS_BIN="${APP_BUNDLE}/Contents/MacOS"
        if [ -x "${MACOS_BIN}/Electron" ]; then
            "${MACOS_BIN}/Electron" &
        else
            # Newer VSCodium builds use the app name as the binary
            "${MACOS_BIN}/$(ls "${MACOS_BIN}" | head -1)" &
        fi
    elif [ "${OS}" = "Windows" ]; then
        taskkill /IM "Code.exe" /F 2>/dev/null || true
        start "" "${WORK_DIR}/Code.exe"
    else
        pkill -x codium 2>/dev/null || true
        sleep 1
        "${WORK_DIR}/bin/codium" &
    fi
fi
