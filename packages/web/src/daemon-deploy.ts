import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";

export interface DeployTarget {
  sshHost: string;
  sshUser: string;
  sshPort: number;
  sshKeyFile?: string;
  daemonPort?: number;
  mysqlHost: string;
}

export interface DeployOpts extends DeployTarget {
  timeoutMs: number;
  onOutput?: (chunk: string) => void;
}

export interface DeployResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface BatchTarget {
  host: string;
  daemonPort?: number;
}

const FORWARD_KEYS = [
  "WORK_DB_DRIVER",
  "WORK_DB_PORT",
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

export function buildEnvBlock(env: Map<string, string>, target: DeployTarget): string {
  const lines: string[] = [];
  const localIP = detectLocalIP();
  for (const k of FORWARD_KEYS) {
    const v = env.get(k);
    if (v === undefined) continue;
    if (k === "OPENCODE_BINARY") continue;
    let val = v;
    if (k === "GITEA_URL" && localIP && (val.includes("127.0.0.1") || val.includes("localhost"))) {
      val = val.replace(/127\.0\.0\.1|localhost/g, localIP);
    }
    lines.push(`${k}=${val}`);
  }
  const mysqlHost = String(target.mysqlHost).replace(/:\d+$/, "");
  lines.push(`WORK_DB_HOST=${mysqlHost}`);
  lines.push(`DAEMON_PORT=${String(target.daemonPort ?? 3101)}`);
  lines.push(`DAEMON_HOST=0.0.0.0`);
  lines.push(`DAEMON_ENV=production`);
  return lines.join("\n");
}

function detectLocalIP(): string | null {
  try {
    const { networkInterfaces } = require("node:os");
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) {
          return net.address;
        }
      }
    }
  } catch {
    // Network detection best-effort
  }
  return null;
}

function buildSetupScript(envBlock: string, daemonPort: number, mysqlHostRaw: string, mysqlPort: string): string {
  const mysqlHost = mysqlHostRaw.replace(/:\d+$/, "");
  return [
    "set -e",
    `command -v npm >/dev/null 2>&1 || { curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -; sudo apt-get install -y nodejs; }`,
    `command -v bun >/dev/null 2>&1 || { curl -fsSL https://bun.sh/install | bash; }`,
    `export BUN_INSTALL="$HOME/.bun"`,
    `export PATH="$HOME/.local/lib/bin:$BUN_INSTALL/bin:$PATH"`,
    `mkdir -p "$HOME/.local/lib"`,
    `npm config set prefix "$HOME/.local/lib"`,
    `grep -q '.local/lib/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.local/lib/bin:$HOME/.bun/bin:$PATH"' >> "$HOME/.bashrc"`,
    `echo "[1/5] checking MySQL connectivity to ${mysqlHost}:${mysqlPort}..."`,
    `timeout 5 bash -c "echo > /dev/tcp/${mysqlHost}/${mysqlPort}" 2>/dev/null && echo "MySQL port reachable" || { echo "MySQL UNREACHABLE at ${mysqlHost}:${mysqlPort} — daemon will fail to connect"; exit 1; }`,
    `echo "[2/5] installing ework-aio..."`,
    `npm install -g ework-aio`,
    `echo "[2.5/5] ensuring opencode is available..."`,
    `command -v opencode >/dev/null 2>&1 || { echo "installing opencode..."; curl -fsSL https://opencode.ai/install | bash; }`,
    `mkdir -p ~/.local/share/ework-aio/opencode-workdir`,
    `echo "[3/5] writing daemon config..."`,
    `mkdir -p ~/.local/share/ework-aio/ework-daemon`,
    `REMOTE_IP=$(hostname -I 2>/dev/null | awk '{print $1}')`,
    `DAEMON_ENDPOINT_LINE=""`,
    `if [ -n "$REMOTE_IP" ]; then DAEMON_ENDPOINT_LINE="DAEMON_ENDPOINT=$REMOTE_IP:${String(daemonPort)}"; fi`,
    `{ cat <<'EWORK_DAEMON_ENV_EOF'`,
    envBlock,
    `EWORK_DAEMON_ENV_EOF`,
    `echo "$DAEMON_ENDPOINT_LINE"; } > ~/.local/share/ework-aio/ework-daemon/.env`,
    `echo "[4/5] starting daemon..."`,
    `ework-aio stop daemon 2>/dev/null || true`,
    `kill $(lsof -ti:${String(daemonPort)} 2>/dev/null) 2>/dev/null || true`,
    `pkill -f ework-daemon-server 2>/dev/null || true`,
    `sleep 2`,
    `ework-aio start daemon`,
    `echo "[5/5] verifying daemon is alive + on MySQL..."`,
    `sleep 3`,
    `STATUS=$(curl -sf --max-time 5 http://127.0.0.1:${String(daemonPort)}/api/status 2>/dev/null) || { echo "DAEMON_FAILED: status check failed"; echo "=== daemon log (last 20 lines) ==="; tail -20 ~/.local/share/ework-aio/run/daemon.log 2>/dev/null || echo "(no log)"; exit 1; }`,
    `echo "$STATUS"`,
    `echo "$STATUS" | grep -Eq '"driver" *: *"mysql"' || { echo "DAEMON_FAILED: daemon is NOT on MySQL (still SQLite?)"; tail -20 ~/.local/share/ework-aio/run/daemon.log 2>/dev/null; exit 1; }`,
    `echo "=== hostname: $(hostname) ==="`,
    `echo DAEMON_STARTED`,
  ].join("\n");
}

export async function deployRemoteDaemon(opts: DeployOpts): Promise<DeployResult> {
  const envPath = resolveDaemonEnvPath();
  if (!envPath) {
    return {
      ok: false,
      output: "",
      error: "找不到本地 daemon .env",
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
  const script = buildSetupScript(envBlock, opts.daemonPort ?? 3101, opts.mysqlHost, String(env.get("WORK_DB_PORT") ?? "3306"));

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
  }, opts.timeoutMs);

  let output = "";
  let exitCode: number | null = null;
  let timedOut = false;

  const decoder = new TextDecoder();
  const readStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        output += chunk;
        opts.onOutput?.(chunk);
      }
    } catch { /* stream closed */ }
  };

  try {
    ac.signal.addEventListener("abort", () => { timedOut = true; });
    await Promise.all([
      readStream(proc.stdout as ReadableStream<Uint8Array>),
      readStream(proc.stderr as ReadableStream<Uint8Array>),
    ]);
    exitCode = await proc.exited;
  } catch (e) {
    return {
      ok: false,
      output,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    return {
      ok: false,
      output,
      error: `SSH 部署超时（${String(Math.trunc(opts.timeoutMs / 1000))}s）`,
    };
  }
  return {
    ok: exitCode === 0,
    output,
    error: exitCode === 0 ? undefined : `ssh 退出码 ${String(exitCode)}`,
  };
}

export async function deployBatch(
  targets: DeployTarget[],
  timeoutMs: number,
  onOutput: (target: string, chunk: string) => void,
): Promise<Map<string, DeployResult>> {
  const results = new Map<string, DeployResult>();
  await Promise.all(
    targets.map(async (t) => {
      const label = `${t.sshUser}@${t.sshHost}:${String(t.sshPort)}`;
      onOutput(label, `▶ 开始部署到 ${label}\n`);
      const r = await deployRemoteDaemon({
        ...t,
        timeoutMs,
        onOutput: (chunk) => onOutput(label, chunk),
      });
      results.set(label, r);
      onOutput(label, r.ok ? `✓ ${label} 部署成功\n` : `✗ ${label} ${r.error ?? "失败"}\n`);
    }),
  );
  return results;
}
