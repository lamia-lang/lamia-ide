import * as https from "https";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as vscode from "vscode";
import { execFile } from "child_process";

const LAMIA_HOME = path.join(os.homedir(), ".lamia");
const VENV_DIR = path.join(LAMIA_HOME, "venv");
const VENV_BIN = path.join(VENV_DIR, process.platform === "win32" ? "Scripts" : "bin");
const VENV_LAMIA = path.join(VENV_BIN, process.platform === "win32" ? "lamia.exe" : "lamia");
const LOCAL_EDITABLE_MARKER = path.join(VENV_DIR, ".lamia-ide-local-editable");
const STAGING_DIR = path.join(LAMIA_HOME, "update-staging");
const STAGING_BIN = path.join(STAGING_DIR, process.platform === "win32" ? "Scripts" : "bin");
const STAGING_PIP = path.join(STAGING_BIN, process.platform === "win32" ? "pip.exe" : "pip");
const STAGING_LAMIA = path.join(STAGING_BIN, process.platform === "win32" ? "lamia.exe" : "lamia");
const PYPI_URL = "https://pypi.org/pypi/lamia-lang/json";

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

function pipInstall(pip: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      pip,
      ["install", `lamia-lang==${version}`],
      { timeout: 180000, maxBuffer: 5 * 1024 * 1024 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

/** Extract the last JSON object line from output (ignores stray pip/Python warnings). */
function lastJsonLine(out: string): string {
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"))
    .pop();
  return line ?? out.trim();
}

function getIdeApi(lamiaBin: string): Promise<{ major: number; minor: number } | null> {
  return new Promise((resolve) => {
    execFile(
      lamiaBin,
      ["--version", "--json"],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const data = JSON.parse(lastJsonLine(stdout));
          const parts = (data.ide_api as string).split(".").map(Number);
          resolve({ major: parts[0] ?? 0, minor: parts[1] ?? 0 });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** After renaming staging → venv, fix hardcoded interpreter paths in scripts. */
function fixShebangs(): void {
  try {
    const files = fs.readdirSync(VENV_BIN);
    for (const file of files) {
      const filePath = path.join(VENV_BIN, file);
      if (!fs.statSync(filePath).isFile()) continue;
      try {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.startsWith("#!") && content.includes(STAGING_DIR)) {
          fs.writeFileSync(filePath, content.split(STAGING_DIR).join(VENV_DIR), "utf8");
        }
      } catch { /* skip binary files */ }
    }
  } catch { /* best effort */ }
}

function promoteStaging(): void {
  if (fs.existsSync(VENV_DIR)) {
    fs.rmSync(VENV_DIR, { recursive: true, force: true });
  }
  fs.renameSync(STAGING_DIR, VENV_DIR);
  fixShebangs();
}

export async function checkForUpdate(_context: vscode.ExtensionContext): Promise<void> {
  if (fs.existsSync(LOCAL_EDITABLE_MARKER)) return;

  const installed = getInstalledVersion();
  if (!installed) return;

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch {
    return;
  }

  if (compareVersions(latest, installed) <= 0) return;

  // Silently create a staging venv, install, and validate IDE compatibility.
  const currentApi = await getIdeApi(VENV_LAMIA);
  let newApi: { major: number; minor: number } | null;

  try {
    await createStagingVenv();
    await pipInstall(STAGING_PIP, latest);
    newApi = await getIdeApi(STAGING_LAMIA);
  } catch {
    removeStagingVenv();
    return;
  }

  if (!newApi) {
    removeStagingVenv();
    return;
  }

  if (newApi.major > IDE_SUPPORTED_API_MAJOR) {
    removeStagingVenv();
    vscode.window.showWarningMessage(
      `Lamia ${latest} requires a newer IDE version. Please update the Lamia IDE extension first.`,
    );
    return;
  }

  // Compatible — ask the user.
  const choice = await vscode.window.showInformationMessage(
    `Lamia ${latest} is ready to install (current: ${installed}).`,
    { modal: true },
    "Update Now",
  );

  if (choice !== "Update Now") {
    removeStagingVenv();
    return;
  }

  // Swap staging venv into live position and fix interpreter paths.
  promoteStaging();
  const versionFile = path.join(VENV_DIR, ".lamia-ide-version");
  fs.writeFileSync(versionFile, latest, "utf8");

  if (currentApi && newApi.minor > currentApi.minor) {
    vscode.window.showInformationMessage(
      `Lamia updated to ${latest}. Update the Lamia IDE extension for new features.`,
    );
  } else {
    vscode.window.showInformationMessage(`Lamia updated to ${latest}.`);
  }
}
