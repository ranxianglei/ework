// Path resolution for ework-aio. All file system paths used by install
// flow through here so tests can override via env vars.
//
// Hierarchy:
//   DATA_DIR (default: $XDG_DATA_HOME/ework-aio or ~/.local/share/ework-aio)
//   ├── ework-web/                  (web service data)
//   │   ├── .env                    (web env file)
//   │   ├── ework.db                (web SQLite DB)
//   │   └── attachments/            (uploaded files)
//   ├── ework-daemon/               (daemon service data)
//   │   ├── .env                    (daemon env file)
//   │   └── ework-daemon.db         (daemon SQLite DB)
//   ├── run/                        (PID files + logs for PID-file mode)
//   │   ├── web.{pid,log}
//   │   └── daemon.{pid,log}
//   ├── bot-token                   (persisted bot PAT)
//   └── opencode-workdir/           (opencode working directory base)

import path from "node:path";
import os from "node:os";

export interface PathConfig {
  dataDir: string;
  webDataDir: string;
  daemonDataDir: string;
  webEnvFile: string;
  daemonEnvFile: string;
  runDir: string;
  botTokenFile: string;
  opencodeWorkdir: string;
  opencodeConfigFile: string;
  webDbPath: string;
  daemonDbPath: string;
  webAttachmentRoot: string;
  webPidFile: string;
  daemonPidFile: string;
  webLogFile: string;
  daemonLogFile: string;
  webUnitFile: string | null;    // null when not using systemd
  daemonUnitFile: string | null;
}

export interface ResolvePathsOptions {
  dataDir?: string;            // override via --data-dir
  configHome?: string;         // override XDG_CONFIG_HOME for tests
  scope: "user" | "system";    // systemd scope (affects unit file location)
  useSystemd: boolean;         // if false, webUnitFile/daemonUnitFile are null
}

export function resolvePaths(opts: ResolvePathsOptions): PathConfig {
  const home = os.homedir();
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || opts.configHome || path.join(home, ".config");

  const dataDir = opts.dataDir || path.join(xdgDataHome, "ework-aio");
  const webDataDir = path.join(dataDir, "ework-web");
  const daemonDataDir = path.join(dataDir, "ework-daemon");
  const runDir = path.join(dataDir, "run");

  // Unit file location depends on scope and whether systemd is opted-in
  let unitDir: string | null = null;
  if (opts.useSystemd) {
    unitDir = opts.scope === "system"
      ? "/etc/systemd/system"
      : path.join(xdgConfigHome, "systemd", "user");
  }

  return {
    dataDir,
    webDataDir,
    daemonDataDir,
    webEnvFile: path.join(webDataDir, ".env"),
    daemonEnvFile: path.join(daemonDataDir, ".env"),
    runDir,
    botTokenFile: path.join(dataDir, "bot-token"),
    opencodeWorkdir: path.join(dataDir, "opencode-workdir"),
    opencodeConfigFile: path.join(xdgConfigHome, "opencode", "opencode.json"),
    webDbPath: path.join(webDataDir, "ework.db"),
    daemonDbPath: path.join(daemonDataDir, "ework-daemon.db"),
    webAttachmentRoot: path.join(webDataDir, "attachments"),
    webPidFile: path.join(runDir, "web.pid"),
    daemonPidFile: path.join(runDir, "daemon.pid"),
    webLogFile: path.join(runDir, "web.log"),
    daemonLogFile: path.join(runDir, "daemon.log"),
    webUnitFile: unitDir ? path.join(unitDir, "ework-web.service") : null,
    daemonUnitFile: unitDir ? path.join(unitDir, "ework-daemon.service") : null,
  };
}
