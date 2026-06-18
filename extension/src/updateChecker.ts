import * as https from "https";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as vscode from "vscode";
import { execFile } from "child_process";

const LAMIA_HOME = path.join(os.homedir(), ".lamia");
const VENV_DIR = path.join(LAMIA_HOME, "venv");
const VENV_BIN = path.join(VENV_DIR, process.platform === "win32" ? "Scripts" : "bin");
const VENV_PIP = path.join(VENV_BIN, process.platform === "win32" ? "pip.exe" : "pip");
const VENV_LAMIA = path.join(VENV_BIN, process.platform === "win32" ? "lamia.exe" : "lamia");
const STAGING_DIR = path.join(LAMIA_HOME, "update-staging");
const STAGING_BIN = path.join(STAGING_DIR, process.platform === "win32" ? "Scripts" : "bin");
const STAGING_PIP = path.join(STAGING_BIN, process.platform === "win32" ? "pip.exe" : "pip");
const STAGING_LAMIA = path.join(STAGING_BIN, process.platform === "win32" ? "lamia.exe" : "lamia");
const PYPI_URL = "https://pypi.org/pypi/lamia-lang/json";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "lamia.updateCheck.lastTimestamp";
const SKIPPED_VERSION_KEY = "lamia.updateCheck.skippedVersion";

const IDE_SUPPORTED_API_MAJOR = 0;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function fetchLatestVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(PYPI_URL, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`PyPI returned ${res.statusCode}`));
        return;
      }
      let data = "";
      res.on("data", (chunk: Buffer | string) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.info.version as string);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("PyPI request timed out")); });
  });
}

function getInstalledVersion(): string | null {
  const versionFile = path.join(VENV_DIR, ".lamia-ide-version");
  try {
    return fs.readFileSync(versionFile, "utf8").trim();
  } catch {
    return null;
  }
}

function findPython(): string | null {
  for (const name of ["python3", "python"]) {
    try {
      const result = require("child_process").execFileSync(
        name, ["--version"], { timeout: 5000, encoding: "utf8" },
      );
      if (result.includes("3.")) return name;
    } catch { /* skip */ }
  }
  return null;
}

function createStagingVenv(): Promise<void> {
  const python = findPython();
  if (!python) return Promise.reject(new Error("Python not found"));
  if (fs.existsSync(STAGING_DIR)) {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  }
  return new Promise((resolve, reject) => {
    execFile(python, ["-m", "venv", STAGING_DIR], { timeout: 60000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function removeStagingVenv(): void {
  try {
    if (fs.existsSync(STAGING_DIR)) {
      fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

function installInStaging(version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      STAGING_PIP,
      ["install", `lamia-lang==${version}`],
      { timeout: 180000, maxBuffer: 5 * 1024 * 1024 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

function getStagingIdeApi(): Promise<{ major: number; minor: number } | null> {
  return new Promise((resolve) => {
    execFile(
      STAGING_LAMIA,
      ["--version", "--json"],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const data = JSON.parse(stdout.trim());
          const parts = (data.ide_api as string).split(".").map(Number);
          resolve({ major: parts[0] ?? 0, minor: parts[1] ?? 0 });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function getLiveIdeApi(): Promise<{ major: number; minor: number } | null> {
  return new Promise((resolve) => {
    execFile(
      VENV_LAMIA,
      ["--version", "--json"],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const data = JSON.parse(stdout.trim());
          const parts = (data.ide_api as string).split(".").map(Number);
          resolve({ major: parts[0] ?? 0, minor: parts[1] ?? 0 });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function promoteStaging(): void {
  if (fs.existsSync(VENV_DIR)) {
    fs.rmSync(VENV_DIR, { recursive: true, force: true });
  }
  fs.renameSync(STAGING_DIR, VENV_DIR);
}

export async function checkForUpdate(context: vscode.ExtensionContext): Promise<void> {
  const lastCheck = context.globalState.get<number>(LAST_CHECK_KEY, 0);
  if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return;

  const installed = getInstalledVersion();
  if (!installed) return;

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch {
    return;
  }

  await context.globalState.update(LAST_CHECK_KEY, Date.now());

  if (compareVersions(latest, installed) <= 0) return;

  // Don't re-ask about a version the user already skipped
  const skipped = context.globalState.get<string>(SKIPPED_VERSION_KEY, "");
  if (skipped === latest) return;

  const choice = await vscode.window.showInformationMessage(
    `A new version of Lamia is available: ${latest} (installed: ${installed}).`,
    "Update Now",
    "Later",
  );

  if (choice !== "Update Now") {
    await context.globalState.update(SKIPPED_VERSION_KEY, latest);
    return;
  }

  const currentApi = await getLiveIdeApi();

  // Install in isolated staging venv, verify compatibility, then swap
  let newApi: { major: number; minor: number } | null;

  try {
    newApi = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading Lamia ${latest}…`,
        cancellable: false,
      },
      async () => {
        await createStagingVenv();
        await installInStaging(latest);
        return getStagingIdeApi();
      },
    );
  } catch {
    removeStagingVenv();
    vscode.window.showErrorMessage(`Failed to download Lamia ${latest}.`);
    return;
  }

  // Unknown API version must be treated as incompatible for safety.
  if (!newApi) {
    removeStagingVenv();
    vscode.window.showWarningMessage(
      `Lamia ${latest} could not be validated for IDE compatibility. Update was not applied.`,
    );
    return;
  }

  // Check compatibility before touching the live environment
  if (newApi.major > IDE_SUPPORTED_API_MAJOR) {
    removeStagingVenv();
    vscode.window.showWarningMessage(
      `Lamia ${latest} requires a newer IDE version. Please update the Lamia IDE extension first.`,
    );
    // Don't ask again for this incompatible version
    await context.globalState.update(SKIPPED_VERSION_KEY, latest);
    return;
  }

  // Safe — swap staging into live
  promoteStaging();
  const versionFile = path.join(VENV_DIR, ".lamia-ide-version");
  fs.writeFileSync(versionFile, latest, "utf8");

  // Clear skipped version since we successfully updated
  await context.globalState.update(SKIPPED_VERSION_KEY, "");

  if (currentApi && newApi.minor > currentApi.minor) {
    vscode.window.showInformationMessage(
      `Lamia updated to ${latest}. Update the Lamia IDE extension for new features.`,
    );
  } else {
    vscode.window.showInformationMessage(`Lamia updated to ${latest}.`);
  }
}
