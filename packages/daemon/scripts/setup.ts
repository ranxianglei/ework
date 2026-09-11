/**
 * ework-daemon setup script — `bun run setup`
 *
 * Checks prerequisites, creates data directory, configures tea logins,
 * and generates .env from .env.example.
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as readline from "node:readline";

// ── helpers ──────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function ok(msg: string) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg: string) { console.log(`${RED}✗${RESET} ${msg}`); }
function warn(msg: string) { console.log(`${YELLOW}!${RESET} ${msg}`); }
function heading(msg: string) { console.log(`\n${BOLD}${msg}${RESET}`); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((res) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      res(answer.trim() || defaultValue || "");
    });
  });
}

function exec(cmd: string): { success: boolean; stdout: string } {
  try {
    const proc = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    return { success: proc.exitCode === 0, stdout: proc.stdout.toString().trim() };
  } catch {
    return { success: false, stdout: "" };
  }
}

function which(name: string): string | null {
  const r = exec(`which ${name} 2>/dev/null`);
  return r.success ? r.stdout : null;
}

// ── steps ────────────────────────────────────────────────────────

async function checkPrerequisites() {
  heading("1. Checking prerequisites");

  const deps = [
    { name: "bun", hint: "https://bun.sh/" },
    { name: "git", hint: "apt install git" },
    { name: "opencode", hint: "https://github.com/opencode-ai/opencode" },
    { name: "tea", hint: "https://gitea.com/gitea/tea — download from releases" },
  ];

  let allOk = true;
  for (const dep of deps) {
    const path = which(dep.name);
    if (path) {
      const ver = exec(`${dep.name} --version 2>/dev/null || echo ""`).stdout;
      ok(`${dep.name}${ver ? ` (${ver})` : ""} → ${path}`);
    } else {
      fail(`${dep.name} not found — ${dep.hint}`);
      allOk = false;
    }
  }

  if (!allOk) {
    fail("Missing dependencies. Install them and re-run setup.");
    process.exit(1);
  }
}

async function createDataDir() {
  heading("2. Creating data directory");

  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dataDir = join(base, "ework-daemon");

  if (existsSync(dataDir)) {
    ok(`Data directory exists: ${dataDir}`);
  } else {
    mkdirSync(dataDir, { recursive: true });
    ok(`Created: ${dataDir}`);
  }
}

async function configureTea() {
  heading("3. Configuring tea logins");

  const giteaUrl = await prompt("Gitea URL (ework-web or real Gitea)", "http://localhost:3002");
  const adminToken = await prompt("Admin API token");
  const botUsername = await prompt("Bot username", "ework-daemon");
  const botToken = await prompt("Bot token");

  const logins = exec("tea logins -o csv 2>/dev/null || tea logins 2>/dev/null").stdout;

  const hasDefault = logins.includes("default");
  if (hasDefault) {
    ok("tea login 'default' already exists");
  } else if (adminToken) {
    const r = exec(`tea login add --name default --url "${giteaUrl}" --token "${adminToken}" 2>&1`);
    if (r.success || r.stdout.includes("successfully")) {
      ok("Added tea login 'default' (admin)");
    } else {
      warn(`Could not add default login: ${r.stdout}`);
    }
  } else {
    warn("Skipped default login (no admin token provided)");
  }

  const hasBot = logins.includes(botUsername);
  if (hasBot) {
    ok(`tea login '${botUsername}' already exists`);
  } else if (botToken) {
    const r = exec(`tea login add --name ${botUsername} --url "${giteaUrl}" --token "${botToken}" 2>&1`);
    if (r.success || r.stdout.includes("successfully")) {
      ok(`Added tea login '${botUsername}' (bot)`);
    } else {
      warn(`tea login add failed (token may lack scopes). Writing config manually.`);
      writeTeaConfig(giteaUrl, botUsername, botToken);
    }
  } else {
    warn(`Skipped bot login (no bot token provided)`);
  }
}

function writeTeaConfig(url: string, name: string, token: string) {
  const configPath = join(homedir(), ".config", "tea", "config.yml");

  let existing = "";
  if (existsSync(configPath)) {
    existing = readFileSync(configPath, "utf-8");
  }

  if (existing.includes(`name: ${name}`)) return;

  const entry = `
- name: "${name}"
  url: "${url}"
  token: "${token}"
  active: false
`;
  if (existing.includes(`name: "${name}"`)) return;
  writeFileSync(configPath, existing + entry);
  ok(`Wrote '${name}' login to ${configPath}`);
}

async function createEnvFile() {
  heading("4. Creating .env file");

  const envPath = resolve(".env");
  const examplePath = resolve(".env.example");

  if (existsSync(envPath)) {
    ok(`.env already exists — leaving untouched`);
    return;
  }

  if (existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    ok(`Created .env from .env.example → ${envPath}`);
    warn("Edit .env and fill in your tokens before starting the daemon.");
  } else {
    warn("No .env.example found. Create .env manually with required env vars.");
  }
}

async function installDeps() {
  heading("5. Installing dependencies");

  if (existsSync(resolve("node_modules"))) {
    ok("node_modules exists — skipping bun install");
  } else {
    const r = exec("bun install 2>&1");
    if (r.success) {
      ok("bun install completed");
    } else {
      warn(`bun install: ${r.stdout}`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}ework-daemon setup${RESET}\n`);

  await checkPrerequisites();
  await createDataDir();
  await configureTea();
  await createEnvFile();
  await installDeps();

  heading("Done!");
  console.log(`
  Next steps:
    1. Edit .env with your tokens
    2. bun start
`);
}

main().catch((err) => {
  fail(`Setup failed: ${err.message}`);
  process.exit(1);
});
