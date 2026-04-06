import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { execFile, execFileSync } from "child_process";

const LAMIA_HOME = path.join(os.homedir(), ".lamia");
const VENV_DIR = path.join(LAMIA_HOME, "venv");
const VENV_BIN = path.join(VENV_DIR, process.platform === "win32" ? "Scripts" : "bin");
const VENV_LAMIA = path.join(VENV_BIN, process.platform === "win32" ? "lamia.exe" : "lamia");
const VERSION_FILE = path.join(VENV_DIR, ".lamia-ide-version");

let _installPromise: Promise<string> | null = null;
let _pythonAvailable: boolean | null = null;

function bundledVersionFile(): string {
  return path.join(__dirname, "..", "lamia-version.txt");
}

function readPinnedVersion(): string {
  return fs.readFileSync(bundledVersionFile(), "utf8").trim();
}

function readInstalledVersion(): string | null {
  try {
    return fs.readFileSync(VERSION_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

function findPython(): string | null {
  const candidates = process.platform === "win32"
    ? ["python", "python3"]
    : ["python3", "python"];

  for (const cmd of candidates) {
    try {
      const out = execFileSync(cmd, ["--version"], { encoding: "utf8", timeout: 5000 });
      if (out.includes("Python 3.")) return cmd;
    } catch {
      continue;
    }
  }
  return null;
}

function bundledWheelsDir(): string {
  return path.join(__dirname, "..", "lamia-wheels");
}

async function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export function isPythonAvailable(): boolean {
  if (_pythonAvailable !== null) return _pythonAvailable;
  _pythonAvailable = findPython() !== null;
  return _pythonAvailable;
}

export function isLamiaReady(): boolean {
  const pinnedVersion = readPinnedVersion();
  const installedVersion = readInstalledVersion();
  return fs.existsSync(VENV_LAMIA) && installedVersion === pinnedVersion;
}

const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";

export function showNoPythonWarning(): void {
  const installHint = process.platform === "darwin"
    ? 'Install via "brew install python3" or download from python.org.'
    : process.platform === "win32"
      ? "Download from python.org or install via the Microsoft Store."
      : 'Install via your package manager (e.g. "sudo apt install python3").';

  vscode.window.showWarningMessage(
    `Python 3.10+ not found. The IDE works fine for editing, but running Lamia code and the chat require Python. ${installHint}`,
    "Download Python"
  ).then((choice) => {
    if (choice === "Download Python") {
      vscode.env.openExternal(vscode.Uri.parse(PYTHON_DOWNLOAD_URL));
    }
  });
}

export function ensureLamia(): Promise<string> {
  if (_installPromise) return _installPromise;
  _installPromise = _doInstall();
  return _installPromise;
}

async function _doInstall(): Promise<string> {
  const pinnedVersion = readPinnedVersion();
  const installedVersion = readInstalledVersion();

  if (fs.existsSync(VENV_LAMIA) && installedVersion === pinnedVersion) {
    return VENV_LAMIA;
  }

  const python = findPython();
  if (!python) {
    _pythonAvailable = false;
    throw new NoPythonError();
  }
  _pythonAvailable = true;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Setting up Lamia runtime…",
      cancellable: false,
    },
    async () => {
      if (!fs.existsSync(VENV_DIR)) {
        await runCommand(python, ["-m", "venv", VENV_DIR]);
      }

      const pip = path.join(VENV_BIN, process.platform === "win32" ? "pip.exe" : "pip");
      await runCommand(pip, [
        "install", "--no-index",
        "--find-links", bundledWheelsDir(),
        `lamia-lang==${pinnedVersion}`,
      ]);

      fs.writeFileSync(VERSION_FILE, pinnedVersion, "utf8");
    }
  );

  showPathHint();
  return VENV_LAMIA;
}

export class NoPythonError extends Error {
  constructor() {
    super("Python 3.10+ is required to run Lamia code and use the chat.");
    this.name = "NoPythonError";
  }
}

let _pathHintShown = false;

function showPathHint(): void {
  if (_pathHintShown) return;
  _pathHintShown = true;

  const shellLine = `export PATH="$HOME/.lamia/venv/bin:$PATH"`;
  vscode.window.showInformationMessage(
    `Lamia runtime ready. To use "lamia" from your terminal, add to your shell profile:\n${shellLine}`,
    "Copy to Clipboard"
  ).then((choice) => {
    if (choice === "Copy to Clipboard") {
      vscode.env.clipboard.writeText(shellLine);
    }
  });
}

export function writeIdePath(): void {
  const appPath = process.execPath;
  let idePath: string;

  if (process.platform === "darwin") {
    const appMatch = appPath.match(/^(.+\.app)\//);
    idePath = appMatch ? appMatch[1] : appPath;
  } else {
    idePath = appPath;
  }

  fs.mkdirSync(LAMIA_HOME, { recursive: true });
  fs.writeFileSync(path.join(LAMIA_HOME, "ide-path.txt"), idePath, "utf8");
}
