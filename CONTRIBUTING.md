# Contributing to Lamia IDE

## Development Setup

1. Clone the repository (with the sibling `lamia` repo at `../lamia`)
2. Run `./build.sh` for the first full build
3. Run `./dev.sh` for fast iteration (re-compiles extension + launches)

## Version Compatibility

### Initial lamia version — `initial-lamia-version.txt`

This file controls two things:
- **First-time venv creation**: `lamiaInstaller.ts` reads it and installs this exact version from PyPI when no venv exists yet (e.g. the user's first launch after installing the IDE).
- **Dev loop**: `dev.sh` copies it to `~/.lamia/venv/.lamia-ide-version`.

**Update this file whenever a new `lamia-lang` is published to PyPI**, so that new IDE builds and fresh installs use the latest version.

### IDE API compatibility — `IDE_SUPPORTED_API_MAJOR`

Defined in `extension/src/updateChecker.ts` (currently `0`).

The update checker reads `ide_api` from `lamia --version --json` (defined as `IDE_API_VERSION` in `lamia/cli/cli.py`, currently `"0.1"`). Before offering an update it verifies the new version's `ide_api` major equals `IDE_SUPPORTED_API_MAJOR`.

- If `lamia` bumps `IDE_API_VERSION` **minor** (e.g. `"0.1"` → `"0.2"`): no change needed here. The update is allowed and users see a hint to update the IDE extension for new features.
- If `lamia` bumps `IDE_API_VERSION` **major** (e.g. `"0.1"` → `"1.0"`): update `IDE_SUPPORTED_API_MAJOR` to the new major, then release a new IDE extension version. Until that release, the update checker blocks users from installing the incompatible lamia version.

### Testing the update checker

After `./dev.sh`, the installed version equals `initial-lamia-version.txt`. To trigger the update prompt for testing:
```bash
echo "0.2.0" > ~/.lamia/venv/.lamia-ide-version
```
Then relaunch Lamia Studio. The checker will see `installed=0.2.0`, `latest=0.2.2` (from PyPI), and offer the update.
