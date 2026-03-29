#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
# To rename the app, change APP_NAME here — everything else is derived from it.
APP_NAME="Lamia Studio"
APP_TAGLINE="Write Lamia. Run anything."
LAMIA_VERSION="1.0.0"
VSCODIUM_VERSION="1.112.01907"
DIST_DIR="dist"

APP_NAME_SLUG="$(echo "${APP_NAME}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
APP_NAME_COMPACT="$(echo "${APP_NAME}" | tr -d ' -' | tr '[:upper:]' '[:lower:]')"
APP_NAME_BUNDLE_ID="com.$(echo "${APP_NAME_SLUG}" | tr '-' '.')"

# ── Detect platform ───────────────────────────────────────────────────────────
# Override with TARGET_PLATFORM env var for cross-builds in CI (e.g. TARGET_PLATFORM=darwin-x64)
OS="$(uname -s)"
ARCH="$(uname -m)"

if [ -n "${TARGET_PLATFORM:-}" ]; then
    PLATFORM="${TARGET_PLATFORM}"
    case "${PLATFORM}" in
        darwin-*)  EXT="zip" ; OS="Darwin" ;;
        linux-*)   EXT="tar.gz" ; OS="Linux" ;;
        win32-*)   EXT="zip" ; OS="Windows" ;;
        *)         echo "Unknown TARGET_PLATFORM: ${PLATFORM}"; exit 1 ;;
    esac
else
    case "${OS}" in
        MINGW*|MSYS*|CYGWIN*)
            PLATFORM="win32-x64" ; EXT="zip" ; OS="Windows" ;;
        *)  ;;
    esac

    if [ "${OS}" != "Windows" ]; then
        case "${OS}-${ARCH}" in
            Darwin-arm64)  PLATFORM="darwin-arm64" ; EXT="zip" ;;
            Darwin-x86_64) PLATFORM="darwin-x64"   ; EXT="zip" ;;
            Linux-x86_64)  PLATFORM="linux-x64"    ; EXT="tar.gz" ;;
            Linux-aarch64) PLATFORM="linux-arm64"  ; EXT="tar.gz" ;;
            *)
                echo "Unsupported platform: ${OS}-${ARCH}"
                exit 1
                ;;
        esac
    fi
fi

ARTIFACT_NAME="LamiaStudio-${LAMIA_VERSION}-${PLATFORM}"

# ── Generate icons if needed ──────────────────────────────────────────────────
if [ ! -f branding/icons/lamia.icns ] || [ ! -f branding/icons/lamia.ico ]; then
    if command -v python3 &>/dev/null && python3 -c "from PIL import Image" 2>/dev/null; then
        echo "Generating icons..."
        python3 scripts/generate-icons.py
    else
        echo "Warning: icons not found and Pillow not available, skipping icon generation"
        echo "  Run: pip install Pillow && python3 scripts/generate-icons.py"
    fi
fi

# ── Generate in-app branding assets if needed ─────────────────────────────────
if [ ! -f branding/welcome-dark.png ] || [ ! -f branding/code-icon.svg ]; then
    if command -v python3 &>/dev/null && python3 -c "from PIL import Image" 2>/dev/null; then
        echo "Generating in-app branding assets..."
        python3 scripts/generate-branding.py
    else
        echo "Warning: branding assets not found and Pillow not available, skipping"
        echo "  Run: pip install Pillow && python3 scripts/generate-branding.py"
    fi
fi

echo "Building ${APP_NAME} (VSCodium ${VSCODIUM_VERSION}, ${PLATFORM})"

# ── Download VSCodium ─────────────────────────────────────────────────────────
DOWNLOAD_URL="https://github.com/VSCodium/vscodium/releases/download/${VSCODIUM_VERSION}/VSCodium-${PLATFORM}-${VSCODIUM_VERSION}.${EXT}"
DOWNLOAD_FILE="vscodium.${EXT}"

mkdir -p "${DIST_DIR}"

if [ ! -f "${DIST_DIR}/${DOWNLOAD_FILE}" ]; then
    echo "Downloading VSCodium ${VSCODIUM_VERSION}..."
    curl -fL -o "${DIST_DIR}/${DOWNLOAD_FILE}" "${DOWNLOAD_URL}"
else
    echo "Using cached VSCodium download"
fi

# ── Extract ───────────────────────────────────────────────────────────────────
WORK_DIR="${DIST_DIR}/work"
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}"

echo "Extracting..."
if [ "${EXT}" = "zip" ]; then
    unzip -q "${DIST_DIR}/${DOWNLOAD_FILE}" -d "${WORK_DIR}"
else
    tar -xzf "${DIST_DIR}/${DOWNLOAD_FILE}" -C "${WORK_DIR}"
fi

# ── Locate the app bundle ────────────────────────────────────────────────────
if [ "${OS}" = "Darwin" ]; then
    APP_BUNDLE="${WORK_DIR}/VSCodium.app"
    RESOURCES_DIR="${APP_BUNDLE}/Contents/Resources"
    EXTENSIONS_DIR="${RESOURCES_DIR}/app/extensions"
elif [ "${OS}" = "Windows" ]; then
    RESOURCES_DIR="${WORK_DIR}/resources"
    EXTENSIONS_DIR="${RESOURCES_DIR}/app/extensions"
else
    RESOURCES_DIR="${WORK_DIR}/resources"
    EXTENSIONS_DIR="${RESOURCES_DIR}/app/extensions"
fi

# ── Apply branding (product.json) ────────────────────────────────────────────
PRODUCT_JSON="${RESOURCES_DIR}/app/product.json"
if [ -f branding/product.json ]; then
    echo "Applying branding..."
    if command -v python3 &>/dev/null; then
        python3 -c "
import json
with open('${PRODUCT_JSON}') as f: base = json.load(f)
with open('branding/product.json') as f: overrides = json.load(f)
# Inject name fields derived from APP_NAME in build.sh
overrides['nameShort'] = '${APP_NAME}'
overrides['nameLong'] = '${APP_NAME}'
overrides['applicationName'] = '${APP_NAME_SLUG}'
overrides['dataFolderName'] = '.${APP_NAME_SLUG}'
overrides['win32MutexName'] = '${APP_NAME_COMPACT}'
overrides['urlProtocol'] = '${APP_NAME_SLUG}'
overrides['darwinBundleIdentifier'] = '${APP_NAME_BUNDLE_ID}'
base.update(overrides)
with open('${PRODUCT_JSON}', 'w') as f: json.dump(base, f, indent=2)
"
    else
        echo "Warning: python3 not found, skipping product.json merge"
    fi
fi

# ── Patch hardcoded VSCodium display strings in the bundle ───────────────────
echo "Patching display strings..."
_PATCH=$(mktemp /tmp/lamia_patch_XXXXXX.py)
cat > "${_PATCH}" << 'PYEOF'
import os, sys
from pathlib import Path

app_root = Path(os.environ['_LAMIA_RES']) / 'app'
app_name = os.environ['_LAMIA_NAME']
tagline  = os.environ['_LAMIA_TAGLINE']

EXTS = {'.js', '.json', '.html', '.css'}
counts = {'vscodium': 0, 'tagline': 0, 'scm': 0}

def remove_learn_more(text):
    """Remove 'To learn more about how to use git...' up to and including the period."""
    needle = 'to learn more about how to use'
    lower  = text.lower()
    idx = lower.find(needle)
    if idx < 0:
        return text, False
    # Walk forward to find the end of the sentence (period), max 400 chars
    end = idx
    for i in range(idx, min(idx + 400, len(text))):
        if text[i] == '.':
            end = i + 1
            break
    # Also consume a trailing </a>. if present right after
    tail = text[end:end+10]
    if tail.startswith('</a>'):
        end += 4
    if end < len(text) and text[end] == '.':
        end += 1
    return (text[:idx].rstrip() + ' ' + text[end:].lstrip()).strip(), True

paths = (
    list((app_root / 'out').rglob('*')) +
    list((app_root / 'extensions').rglob('*'))
)

for path in paths:
    if not path.is_file() or path.suffix not in EXTS:
        continue
    try:
        original = path.read_text(encoding='utf-8', errors='ignore')
        text = original

        # 1. Remove "To learn more about how to use Git/git..." sentence
        if 'learn more about how to use' in text.lower():
            text, changed = remove_learn_more(text)
            if changed:
                counts['scm'] += 1

        # 2. Replace tagline
        if 'Editing evolved' in text:
            text = text.replace('Editing evolved', tagline)
            counts['tagline'] += 1

        # 3. Rename VSCodium display strings
        if 'VSCodium' in text:
            text = text.replace('VSCodium', app_name)
            counts['vscodium'] += 1

        # 4. Disable integrity check (prevents "installation appears corrupt" warning
        #    that fires because we patched the JS files above)
        if 'isPure(){return this.isPurePromise}' in text:
            text = text.replace(
                'isPure(){return this.isPurePromise}',
                'isPure(){return Promise.resolve({isPure:true,proof:[]})}',
            )
            counts['integrity'] = counts.get('integrity', 0) + 1

        if text != original:
            path.write_text(text, encoding='utf-8')
    except Exception as e:
        print(f'  Warning: {path.name}: {e}', file=sys.stderr)

print(f'  Renamed "VSCodium"        in {counts["vscodium"]} files')
print(f'  Replaced tagline          in {counts["tagline"]} files')
print(f'  Removed SCM "learn more"  in {counts["scm"]} files')
print(f'  Disabled integrity check  in {counts.get("integrity", 0)} files')
PYEOF
_LAMIA_RES="${RESOURCES_DIR}" _LAMIA_NAME="${APP_NAME}" _LAMIA_TAGLINE="${APP_TAGLINE}" python3 "${_PATCH}" \
    || echo "  Warning: string patching failed (non-fatal)"
rm -f "${_PATCH}"

# ── Apply icon branding ─────────────────────────────────────────────────────
echo "Applying icon..."
if [ "${OS}" = "Darwin" ]; then
    if [ -f branding/icons/lamia.icns ]; then
        # Overwrite the existing VSCodium icon AND add as the new canonical name
        cp branding/icons/lamia.icns "${RESOURCES_DIR}/VSCodium.icns"
        cp branding/icons/lamia.icns "${RESOURCES_DIR}/lamia.icns"
    fi
    # Patch Info.plist with our bundle name, identifier, and icon reference
    INFO_PLIST="${APP_BUNDLE}/Contents/Info.plist"
    if [ -f "${INFO_PLIST}" ]; then
        plutil -replace CFBundleName -string "${APP_NAME}" "${INFO_PLIST}"
        plutil -replace CFBundleDisplayName -string "${APP_NAME}" "${INFO_PLIST}"
        plutil -replace CFBundleIdentifier -string "${APP_NAME_BUNDLE_ID}" "${INFO_PLIST}"
        plutil -replace CFBundleIconFile -string "lamia" "${INFO_PLIST}"
    fi
    # Rename helper apps to match the new bundle name (Electron finds helpers by directory name)
    for suffix in "" " (GPU)" " (Plugin)" " (Renderer)"; do
        OLD_HELPER="${APP_BUNDLE}/Contents/Frameworks/VSCodium Helper${suffix}.app"
        NEW_HELPER="${APP_BUNDLE}/Contents/Frameworks/${APP_NAME} Helper${suffix}.app"
        if [ -d "${OLD_HELPER}" ]; then
            OLD_EXE="VSCodium Helper${suffix}"
            NEW_EXE="${APP_NAME} Helper${suffix}"
            [ -f "${OLD_HELPER}/Contents/MacOS/${OLD_EXE}" ] && \
                mv "${OLD_HELPER}/Contents/MacOS/${OLD_EXE}" "${OLD_HELPER}/Contents/MacOS/${NEW_EXE}"
            HELPER_PLIST="${OLD_HELPER}/Contents/Info.plist"
            if [ -f "${HELPER_PLIST}" ]; then
                plutil -replace CFBundleExecutable -string "${NEW_EXE}" "${HELPER_PLIST}"
                plutil -replace CFBundleName -string "${NEW_EXE}" "${HELPER_PLIST}"
            fi
            mv "${OLD_HELPER}" "${NEW_HELPER}"
        fi
    done
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

# ── Compile and bundle the Lamia extension ───────────────────────────────────
echo "Compiling extension..."
(cd extension && npm install --prefer-offline --silent && ./node_modules/.bin/tsc -p ./)
echo "Bundling Lamia extension..."
LAMIA_EXT_DIR="${EXTENSIONS_DIR}/lamia-language"
mkdir -p "${LAMIA_EXT_DIR}"
# Copy only the runtime files — skip src, node_modules, tsconfig
cp -R extension/out                    "${LAMIA_EXT_DIR}/out"
cp    extension/package.json           "${LAMIA_EXT_DIR}/package.json"
cp    extension/package-lock.json      "${LAMIA_EXT_DIR}/package-lock.json" 2>/dev/null || true
cp -R extension/syntaxes               "${LAMIA_EXT_DIR}/syntaxes"
cp -R extension/icons                  "${LAMIA_EXT_DIR}/icons"
cp    extension/lamia.code-snippets    "${LAMIA_EXT_DIR}/lamia.code-snippets"
cp    extension/language-configuration-lm.json  "${LAMIA_EXT_DIR}/language-configuration-lm.json"
cp    extension/language-configuration-hu.json  "${LAMIA_EXT_DIR}/language-configuration-hu.json"

# ── Apply in-app branding assets ─────────────────────────────────────────────
echo "Applying in-app branding..."
OUT_MEDIA="${RESOURCES_DIR}/app/out/media"
WELCOME_MEDIA="${RESOURCES_DIR}/app/out/vs/workbench/contrib/welcomeGettingStarted/common/media"

if [ -f branding/code-icon.svg ]; then
    cp branding/code-icon.svg "${OUT_MEDIA}/code-icon.svg"
fi
for variant in dark light hcDark hcLight; do
    [ -f "branding/letterpress-${variant}.svg" ] && \
        cp "branding/letterpress-${variant}.svg" "${OUT_MEDIA}/letterpress-${variant}.svg"
done
for variant in dark light dark-hc light-hc; do
    src="branding/welcome-${variant}.png"
    # map dark-hc → dark-hc, light-hc → light-hc (filenames match)
    [ -f "${src}" ] && cp "${src}" "${WELCOME_MEDIA}/${variant}.png"
done

# ── Apply default settings ───────────────────────────────────────────────────
if [ -f defaults/settings.json ]; then
    echo "Applying default settings..."
    if [ "${OS}" = "Darwin" ]; then
        DEFAULT_SETTINGS_DIR="${APP_BUNDLE}/Contents/Resources/app/out/vs/workbench"
    else
        DEFAULT_SETTINGS_DIR="${WORK_DIR}/resources/app/out/vs/workbench"
    fi
    mkdir -p "${DEFAULT_SETTINGS_DIR}"
    cp defaults/settings.json "${DEFAULT_SETTINGS_DIR}/defaultSettings.json"
fi

# ── Finalize app bundle (macOS) ──────────────────────────────────────────────
if [ "${OS}" = "Darwin" ]; then
    echo "Fixing code signature..."

    ENT_PARENT="${DIST_DIR}/ent-parent.plist"
    cat > "${ENT_PARENT}" << 'ENTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.automation.apple-events</key>
    <true/>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
</dict>
</plist>
ENTEOF

    ENT_CHILD="${DIST_DIR}/ent-child.plist"
    cat > "${ENT_CHILD}" << 'ENTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
ENTEOF

    # Sign inside-out, matching stock VSCodium's entitlement layout:
    # 1) All dylibs (no entitlements, no hardened runtime)
    find "${APP_BUNDLE}" -name "*.dylib" -exec codesign --force --sign - {} \; 2>/dev/null || true
    # 2) Frameworks with parent entitlements + hardened runtime
    find "${APP_BUNDLE}/Contents/Frameworks" -maxdepth 1 -type d -name "*.framework" \
        -exec codesign --force --options runtime --sign - --entitlements "${ENT_PARENT}" {} \; 2>/dev/null || true
    # 3) Helper apps with child entitlements + hardened runtime
    find "${APP_BUNDLE}/Contents/Frameworks" -maxdepth 1 -type d -name "*.app" \
        -exec codesign --force --options runtime --sign - --entitlements "${ENT_CHILD}" {} \; 2>/dev/null || true
    # 4) Main app with parent entitlements + hardened runtime
    codesign --force --options runtime --sign - --entitlements "${ENT_PARENT}" "${APP_BUNDLE}"

    xattr -cr "${APP_BUNDLE}" 2>/dev/null || true
    rm -f "${ENT_PARENT}" "${ENT_CHILD}"

    FINAL_BUNDLE="${WORK_DIR}/Lamia Studio.app"
    mv "${APP_BUNDLE}" "${FINAL_BUNDLE}"
fi

# ── Package deliverables ─────────────────────────────────────────────────────
OUT_DIR="${DIST_DIR}/out"
mkdir -p "${OUT_DIR}"

if [ "${OS}" = "Darwin" ]; then
    echo "Creating DMG..."
    DMG_PATH="${OUT_DIR}/${ARTIFACT_NAME}.dmg"
    rm -f "${DMG_PATH}"

    DMG_STAGING="${DIST_DIR}/dmg-staging"
    rm -rf "${DMG_STAGING}"
    mkdir -p "${DMG_STAGING}"
    cp -R "${FINAL_BUNDLE}" "${DMG_STAGING}/"
    ln -s /Applications "${DMG_STAGING}/Applications"

    hdiutil create -volname "${APP_NAME}" \
        -srcfolder "${DMG_STAGING}" \
        -ov -format UDZO \
        "${DMG_PATH}"
    rm -rf "${DMG_STAGING}"

    echo "  -> ${DMG_PATH}"

elif [ "${OS}" = "Windows" ]; then
    echo "Creating ZIP..."
    ZIP_PATH="${OUT_DIR}/${ARTIFACT_NAME}.zip"
    rm -f "${ZIP_PATH}"
    if command -v zip &>/dev/null; then
        (cd "${WORK_DIR}" && zip -qr - .) > "${ZIP_PATH}"
    elif command -v 7z &>/dev/null; then
        (cd "${WORK_DIR}" && 7z a -tzip -bso0 -bsp0 "$(cd .. && pwd)/out/${ARTIFACT_NAME}.zip" .)
    else
        echo "Error: neither zip nor 7z found" >&2; exit 1
    fi
    echo "  -> ${ZIP_PATH}"

else
    echo "Creating tar.gz..."
    TAR_PATH="${OUT_DIR}/${ARTIFACT_NAME}.tar.gz"
    rm -f "${TAR_PATH}"
    tar -czf "${TAR_PATH}" -C "${WORK_DIR}" .
    echo "  -> ${TAR_PATH}"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Done! ${APP_NAME} built successfully for ${PLATFORM}."
echo ""
echo "Deliverable:"
ls -lh "${OUT_DIR}/${ARTIFACT_NAME}"* 2>/dev/null || true
echo ""
if [ "${OS}" = "Darwin" ]; then
    echo "To test: open \"${FINAL_BUNDLE}\""
    echo ""
    echo "First launch: if macOS blocks the app (ad-hoc signed, not notarized),"
    echo "  right-click the .app in Finder → Open → click 'Open' in the dialog."
    echo "  This creates a permanent Gatekeeper exception."
elif [ "${OS}" = "Windows" ]; then
    echo "To test: run Code.exe from the extracted zip"
else
    echo "To test: extract the tar.gz and run bin/codium"
fi
