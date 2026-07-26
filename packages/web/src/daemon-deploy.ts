import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";

export interface DeployOpts {
  sshHost: string;
  sshUser: string;
  sshPort: number;
  sshKeyFile?: string;
  daemonPort?: number;
  mysqlHost: string;
}

export interface DeployResult {
  ok: boolean;
  output: string;
  error?: string;
}

// Keys forwarded from the local daemon .env to the remote one. Secrets are
// never logged — only written to the remote .env over SSH.
const FORWARD_KEYS = [
  "WORK_DB_DRIVER",
  "WORK_DB_USER",
  "WORK_DB_PASSWORD",
  "WORK_DB_NAME",
  "WORK_DB_PREFIX",
  "GITEA_URL",
  "GITEA_TOKEN",
  "BOT_TOKEN",
  "BOT_USERNAME",
  "GITEA_WEBHOOK_SECRET",
  "OPENCODE_BASE_WORKDIR",
  "OPENCODE_BINARY",
] as const;

function resolveDaemonEnvPath(): string | null {
  const dataDir = process.env.WORK_DAEMON_DATA_DIR;
  if (dataDir) {
    const p = join(dataDir, ".env");
    return existsSync(p) ? p : null;
  }
  const candidates = [
    join(homedir(), ".local", "share", "ework-aio", "ework-daemon", ".env"),
    join(homedir(), ".local", "share", "ework-daemon", ".env"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function parseEnvFile(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key.startsWith("#")) continue;
    const val = line.slice(eq + 1).replace(/^["']|["']$/g, "");
    out.set(key, val);
  }
  return out;
}

function buildEnvBlock(env: Map<string, string>, opts: DeployOpts): string {
  const lines: string[] = [];
  for (const k of FORWARD_KEYS) {
    const v = env.get(k);
    if (v === undefined) continue;
    lines.push(`${k}=${v}`);
  }
  lines.push(`WORK_DB_HOST=${opts.mysqlHost}`);
  lines.push(`DAEMON_PORT=${String(opts.daemonPort ?? 3101)}`);
  lines.push(`DAEMON_HOST=0.0.0.0`);
  lines.push(`DAEMON_ENV=production`);
  return lines.join("\n");
}

function buildSetupScript(envBlock: string): string {
  return [
    "set -e",
    `command -v npm >/dev/null 2>&1 || { curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -; sudo apt-get install -y nodejs; }`,
    `command -v bun >/dev/null 2>&1 || { curl -fsSL https://bun.sh/install | bash; export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"; }`,
    `npm install -g ework-aio`,
    `mkdir -p ~/.local/share/ework-aio/ework-daemon`,
    `cat > ~/.local/share/ework-aio/ework-daemon/.env <<'EWORK_DAEMON_ENV_EOF'`,
    envBlock,
    `EWORK_DAEMON_ENV_EOF`,
    `ework-aio start daemon`,
    `echo DAEMON_STARTED`,
  ].join("\n");
}

export async function deployRemoteDaemon(opts: DeployOpts): Promise<DeployResult> {
  const envPath = resolveDaemonEnvPath();
  if (!envPath) {
    return {
      ok: false,
      output: "",
      error: "找不到本地 daemon .env（设置 WORK_DAEMON_DATA_DIR 或将 .env 放到 ~/.local/share/ework-aio/ework-daemon/.env）",
    };
  }
  let envContent: string;
  try {
    envContent = readFileSync(envPath, "utf8");
  } catch (e) {
    return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
  }
  const env = parseEnvFile(envContent);
  const envBlock = buildEnvBlock(env, opts);
  const script = buildSetupScript(envBlock);

  const args = [
    "ssh",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", String(opts.sshPort),
    "-i", opts.sshKeyFile ?? "~/.ssh/id_rsa",
    `${opts.sshUser}@${opts.sshHost}`,
    "bash -s",
  ];

  let proc;
  try {
    proc = Bun.spawn(args, {
      stdin: new TextEncoder().encode(script),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
    try { proc.kill(); } catch { /* already dead */ }
  }, 60_000);

  let stdoutText = "";
  let stderrText = "";
  let exitCode: number | null = null;
  let timedOut = false;
  try {
    ac.signal.addEventListener("abort", () => { timedOut = true; });
    [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (e) {
    return {
      ok: false,
      output: stdoutText + stderrText,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    return {
      ok: false,
      output: stdoutText + stderrText,
      error: "SSH 部署超时（60s）",
    };
  }
  const combined = stdoutText + (stderrText ? "\n--- stderr ---\n" + stderrText : "");
  return {
    ok: exitCode === 0,
    output: combined,
    error: exitCode === 0 ? undefined : `ssh 退出码 ${String(exitCode)}`,
  };
}
