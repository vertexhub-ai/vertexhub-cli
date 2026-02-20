#!/usr/bin/env node

/**
 * VertexHub CLI
 * Orchestrates Antigravity Proxy + Claude Code CLI
 *
 * Commands:
 *   vertexhub login    - Login with Google OAuth via Antigravity
 *   vertexhub start    - Start proxy + launch Claude Code
 *   vertexhub status   - Check proxy health and account status
 *   vertexhub accounts - List linked Google accounts
 *   vertexhub models   - List available models
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Config ---
const PROXY_DIR = resolve(join(__dirname, '..', '..', 'antigravity-proxy'));
const DEFAULT_PORT = '8090';
const PROXY_PORT = sanitizePort(process.env.VERTEXHUB_PORT) || DEFAULT_PORT;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const CLAUDE_CONFIG_DIR = join(homedir(), '.claude');
const CLAUDE_SETTINGS_FILE = join(CLAUDE_CONFIG_DIR, 'settings.json');
const CLAUDE_JSON_FILE = join(homedir(), '.claude.json');

// Track child processes for cleanup
const childProcesses = [];

// --- Security Helpers ---

/**
 * Sanitize port value to prevent injection.
 * Only allows numeric strings in valid port range.
 */
function sanitizePort(port) {
    if (!port) return null;
    const num = parseInt(port, 10);
    if (isNaN(num) || num < 1 || num > 65535 || String(num) !== port.trim()) {
        return null;
    }
    return String(num);
}

/**
 * Write a file with restricted permissions (owner-only read/write).
 * Prevents other users from reading sensitive config like auth tokens.
 */
function writeFileSecure(filePath, content) {
    writeFileSync(filePath, content, { mode: 0o600 });
    // Ensure permissions even if file existed with different perms
    try { chmodSync(filePath, 0o600); } catch { /* ignore if chmod fails */ }
}

/**
 * Validate that PROXY_DIR exists and contains expected files.
 * Prevents spawning processes from unintended directories.
 */
function validateProxyDir() {
    if (!existsSync(PROXY_DIR)) {
        err(`Proxy directory not found: ${PROXY_DIR}`);
        err('Clone the antigravity-proxy repo next to this project.');
        process.exit(1);
    }
    const indexPath = join(PROXY_DIR, 'src', 'index.js');
    if (!existsSync(indexPath)) {
        err(`Proxy entry point not found: ${indexPath}`);
        err('The antigravity-proxy directory appears corrupted.');
        process.exit(1);
    }
}

// --- Colors ---
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};

/**
 * Strip control characters from a string to prevent terminal escape injection.
 * Preserves printable ASCII + extended Unicode but removes ESC, BEL, etc.
 */
function sanitizeForTerminal(str) {
    return String(str).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function log(msg) { console.log(`${c.cyan}[VertexHub]${c.reset} ${msg}`); }
function ok(msg) { console.log(`${c.green}✓${c.reset} ${msg}`); }
function warn(msg) { console.log(`${c.yellow}⚠${c.reset} ${msg}`); }
function err(msg) { console.error(`${c.red}✗${c.reset} ${msg}`); }

// --- Helpers ---

/**
 * Find node binary. Tries system PATH first, then NVM.
 * Returns absolute path or 'node' if available on PATH.
 */
function getNodeBin() {
    // Try system node first
    try {
        const result = execSync('which node', { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
        if (result) return result;
    } catch { /* not on PATH */ }

    // Try NVM
    const nvmDir = join(homedir(), '.nvm');
    if (existsSync(nvmDir)) {
        try {
            const result = execSync(
                `bash -c 'export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && which node'`,
                { stdio: 'pipe', encoding: 'utf-8', timeout: 10000 }
            ).trim();
            if (result && existsSync(result)) return result;
        } catch { /* NVM not available */ }
    }

    return null;
}

/**
 * Resolve and validate node binary.
 * Exits with error if node is not found.
 */
function requireNodeBin() {
    const nodeBin = getNodeBin();
    if (!nodeBin) {
        err('Node.js not found. Install Node.js 18+ first.');
        err('  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash');
        process.exit(1);
    }
    return nodeBin;
}

async function isProxyRunning() {
    try {
        const response = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(2000) });
        return response.ok;
    } catch {
        return false;
    }
}

async function getProxyStatus() {
    try {
        const [health, limits] = await Promise.all([
            fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(3000) })
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
            fetch(`${PROXY_URL}/account-limits`, { signal: AbortSignal.timeout(3000) })
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                .catch(() => null),
        ]);
        return { health, limits };
    } catch {
        return null;
    }
}

async function getModels() {
    try {
        const response = await fetch(`${PROXY_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) {
            warn(`Models endpoint returned HTTP ${response.status}`);
            return null;
        }
        return await response.json();
    } catch {
        return null;
    }
}

function configureClaudeSettings() {
    mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });

    let settings = {};
    if (existsSync(CLAUDE_SETTINGS_FILE)) {
        try {
            settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8'));
        } catch (e) {
            warn(`Could not parse existing ${CLAUDE_SETTINGS_FILE}: ${e.message}`);
            warn('Creating new settings file.');
        }
    }

    // Ensure settings is a plain object (defense against prototype pollution)
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        settings = {};
    }

    settings.env = {
        ...(settings.env || {}),
        ANTHROPIC_AUTH_TOKEN: 'vertexhub-proxy',
        ANTHROPIC_BASE_URL: PROXY_URL,
        ANTHROPIC_MODEL: 'claude-opus-4-6-thinking',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6-thinking',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5-thinking',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-5',
        CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-4-5-thinking',
    };

    writeFileSecure(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
    ok(`Claude Code settings configured → ${CLAUDE_SETTINGS_FILE}`);

    // Ensure hasCompletedOnboarding is set
    let claudeJson = {};
    if (existsSync(CLAUDE_JSON_FILE)) {
        try {
            claudeJson = JSON.parse(readFileSync(CLAUDE_JSON_FILE, 'utf-8'));
        } catch (e) {
            warn(`Could not parse existing ${CLAUDE_JSON_FILE}: ${e.message}`);
        }
    }

    if (typeof claudeJson !== 'object' || claudeJson === null || Array.isArray(claudeJson)) {
        claudeJson = {};
    }

    if (!claudeJson.hasCompletedOnboarding) {
        claudeJson.hasCompletedOnboarding = true;
        writeFileSecure(CLAUDE_JSON_FILE, JSON.stringify(claudeJson, null, 2));
        ok('Claude Code onboarding bypassed');
    }
}

function startProxy() {
    validateProxyDir();
    const nodeBin = requireNodeBin();

    log(`Starting Antigravity proxy on port ${PROXY_PORT}...`);

    const env = { ...process.env, PORT: PROXY_PORT, HOST: '127.0.0.1' };
    const proxyProcess = spawn(nodeBin, [join(PROXY_DIR, 'src', 'index.js')], {
        env,
        cwd: PROXY_DIR,
        stdio: 'pipe',
        detached: true,
    });

    childProcesses.push(proxyProcess);
    proxyProcess.unref();

    proxyProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line.includes('Server started successfully')) {
            ok(`Proxy running at ${PROXY_URL}`);
        }
    });

    proxyProcess.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line.includes('EADDRINUSE')) {
            warn(`Port ${PROXY_PORT} already in use — proxy may already be running`);
        } else if (line.length > 0) {
            // Log unexpected stderr for debugging
            log(`[proxy:stderr] ${line.substring(0, 200)}`);
        }
    });

    proxyProcess.on('error', (error) => {
        err(`Failed to start proxy: ${error.message}`);
    });

    return proxyProcess;
}

// --- Cleanup ---

function cleanup() {
    for (const child of childProcesses) {
        try {
            if (child.pid && !child.killed) {
                process.kill(-child.pid, 'SIGTERM');
            }
        } catch { /* process may have already exited */ }
    }
}

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

// --- Commands ---

/**
 * Detect if we're running on a remote/headless server (SSH session, no display).
 */
function isRemoteSession() {
    return !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY || !process.env.DISPLAY);
}

/**
 * Stop the proxy server if it's running.
 * Required before managing accounts (accounts.js enforces this).
 */
async function stopProxy() {
    // Kill processes on both default port (8080) and configured port
    const portsToFree = [...new Set(['8080', PROXY_PORT])];
    for (const port of portsToFree) {
        try {
            execSync(`fuser -k ${port}/tcp 2>/dev/null`, { stdio: 'pipe', timeout: 5000 });
        } catch { /* port may already be free */ }
    }
    // Wait for ports to fully release
    await new Promise(r => setTimeout(r, 2000));
}

async function cmdLogin() {
    const isRemote = isRemoteSession();

    console.log(`
${c.bold}${c.cyan}╔══════════════════════════════════════╗
║       VertexHub — Google Login       ║
╚══════════════════════════════════════╝${c.reset}
`);

    validateProxyDir();

    // Accounts manager requires the proxy to be STOPPED
    if (await isProxyRunning()) {
        log('Stopping proxy (required to manage accounts)...');
        await stopProxy();
        if (await isProxyRunning()) {
            err('Could not stop proxy. Stop it manually (Ctrl+C) and try again.');
            process.exit(1);
        }
        ok('Proxy stopped.');
    }

    // Show instructions for remote servers
    if (isRemote) {
        console.log(`${c.bold}${c.yellow}  ⚠ Remote/headless server detected${c.reset}`);
        console.log(`
  The OAuth login will generate a Google URL.
  After signing in, Google redirects to ${c.bold}localhost${c.reset} which won't
  work from your local browser because the server is remote.

  ${c.bold}How to complete the login:${c.reset}

  ${c.cyan}Option A — Copy the redirect URL${c.reset}
    1. Open the Google auth URL in your browser
    2. Sign in and click "Allow"
    3. You'll see "${c.red}localhost refused to connect${c.reset}" — ${c.green}this is normal!${c.reset}
    4. Copy the ${c.bold}FULL URL${c.reset} from your browser's address bar
       (it looks like: http://localhost:XXXXX/oauth-callback?code=4/0A...)
    5. Paste it when prompted below

  ${c.cyan}Option B — SSH tunnel (recommended for reliability)${c.reset}
    On your local machine, open a NEW terminal and run:
    ${c.dim}ssh -L 51121:localhost:51121 ${process.env.USER || 'user'}@${process.env.HOSTNAME || 'your-server'}${c.reset}
    Then open the Google URL — the redirect will work automatically.
`);
    }

    // Launch accounts manager in no-browser mode on remote servers
    const nodeBin = requireNodeBin();
    const accountsScript = join(PROXY_DIR, 'src', 'cli', 'accounts.js');
    if (!existsSync(accountsScript)) {
        err(`Accounts script not found: ${accountsScript}`);
        process.exit(1);
    }

    const args = [accountsScript, 'add'];
    if (isRemote) args.push('--no-browser');

    const accountsProcess = spawn(nodeBin, args, {
        env: { ...process.env, PORT: PROXY_PORT },
        cwd: PROXY_DIR,
        stdio: 'inherit',
    });

    await new Promise((resolve) => {
        accountsProcess.on('exit', (code) => {
            if (code === 0) {
                ok('Google account linked successfully!');
                configureClaudeSettings();
                console.log(`
${c.green}✓ Login complete!${c.reset} Next steps:
  ${c.dim}vertexhub start${c.reset}     Start proxy + Claude Code
  ${c.dim}vertexhub status${c.reset}    Verify everything is working
`);
            } else {
                err(`Account linking failed (exit code: ${code})`);
            }
            resolve();
        });

        accountsProcess.on('error', (error) => {
            err(`Failed to launch accounts manager: ${error.message}`);
            resolve();
        });
    });
}

async function cmdStart() {
    console.log(`
${c.bold}${c.magenta}╔══════════════════════════════════════╗
║     VertexHub — Starting Session     ║
╚══════════════════════════════════════╝${c.reset}
`);

    validateProxyDir();

    // 1. Configure Claude Code settings
    configureClaudeSettings();

    // 2. Start proxy if not running
    if (await isProxyRunning()) {
        ok(`Proxy already running at ${PROXY_URL}`);
    } else {
        startProxy();
        // Wait for proxy
        let started = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await isProxyRunning()) {
                started = true;
                break;
            }
            process.stdout.write('.');
        }
        console.log();
        if (!started) {
            err('Proxy failed to start within 15 seconds.');
            err(`Check: ${c.dim}VERTEXHUB_PORT=${PROXY_PORT} node ${PROXY_DIR}/src/index.js${c.reset}`);
            process.exit(1);
        }
        ok(`Proxy started at ${PROXY_URL}`);
    }

    // 3. Launch Claude Code
    log('Launching Claude Code CLI...');
    const claudeProcess = spawn('claude', [], {
        env: {
            ...process.env,
            ANTHROPIC_BASE_URL: PROXY_URL,
            ANTHROPIC_AUTH_TOKEN: 'vertexhub-proxy',
        },
        stdio: 'inherit',
    });

    await new Promise((resolve) => {
        claudeProcess.on('error', (error) => {
            if (error.code === 'ENOENT') {
                err('Claude Code CLI not found. Install it first:');
                console.log(`  ${c.dim}npm install -g @anthropic-ai/claude-code${c.reset}`);
                console.log(`  ${c.dim}or: curl -fsSL https://claude.ai/install.sh | sh${c.reset}`);
            } else {
                err(`Failed to launch Claude Code: ${error.message}`);
            }
            resolve();
        });

        claudeProcess.on('exit', (code) => {
            log(`Session ended (code: ${code})`);
            resolve();
        });
    });
}

async function cmdStatus() {
    console.log(`
${c.bold}${c.blue}╔══════════════════════════════════════╗
║       VertexHub — Status Check       ║
╚══════════════════════════════════════╝${c.reset}
`);

    // Proxy status
    const running = await isProxyRunning();
    console.log(`  Proxy: ${running ? `${c.green}● Running${c.reset} at ${PROXY_URL}` : `${c.red}● Stopped${c.reset}`}`);

    if (running) {
        const status = await getProxyStatus();
        if (status?.health) {
            console.log(`  Version: ${status.health.version || 'unknown'}`);
            console.log(`  Strategy: ${status.health.strategy || 'unknown'}`);
        }
        if (status?.limits) {
            const accounts = Array.isArray(status.limits) ? status.limits : [status.limits];
            console.log(`  Accounts: ${accounts.length}`);
            for (const acc of accounts) {
                const name = String(acc.email || acc.id || 'unknown').substring(0, 50);
                console.log(`    → ${name}: ${acc.status || 'active'}`);
            }
        }
    }

    // Proxy dir check
    if (existsSync(PROXY_DIR)) {
        console.log(`  Proxy Dir: ${c.green}● Found${c.reset} (${PROXY_DIR})`);
    } else {
        console.log(`  Proxy Dir: ${c.red}● Missing${c.reset} (${PROXY_DIR})`);
    }

    // Claude Code config
    const configured = existsSync(CLAUDE_SETTINGS_FILE);
    if (configured) {
        try {
            const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8'));
            const baseUrl = settings?.env?.ANTHROPIC_BASE_URL;
            const model = settings?.env?.ANTHROPIC_MODEL;
            console.log(`  Claude Config: ${c.green}● Configured${c.reset}`);
            console.log(`    Base URL: ${baseUrl || 'not set'}`);
            console.log(`    Model: ${model || 'not set'}`);
        } catch {
            console.log(`  Claude Config: ${c.yellow}● Invalid JSON${c.reset}`);
        }
    } else {
        console.log(`  Claude Config: ${c.red}● Not configured${c.reset}`);
        console.log(`    Run: ${c.dim}vertexhub start${c.reset} to auto-configure`);
    }

    // Claude Code installed?
    try {
        execSync('which claude', { stdio: 'pipe', timeout: 5000 });
        console.log(`  Claude Code: ${c.green}● Installed${c.reset}`);
    } catch {
        console.log(`  Claude Code: ${c.red}● Not found${c.reset}`);
    }

    // Node.js
    const nodeBin = getNodeBin();
    console.log(`  Node.js: ${nodeBin ? `${c.green}● ${nodeBin}${c.reset}` : `${c.red}● Not found${c.reset}`}`);

    console.log();
}

async function cmdAccounts() {
    if (!(await isProxyRunning())) {
        err('Proxy not running. Start it first: vertexhub start');
        process.exit(1);
    }

    validateProxyDir();
    const nodeBin = requireNodeBin();
    const accountsScript = join(PROXY_DIR, 'src', 'cli', 'accounts.js');

    if (!existsSync(accountsScript)) {
        err(`Accounts script not found: ${accountsScript}`);
        process.exit(1);
    }

    // Only pass known safe subcommands
    const allowedSubcommands = ['add', 'list', 'remove', 'verify'];
    const subArgs = process.argv.slice(3).filter(arg => allowedSubcommands.includes(arg));

    const accountsProcess = spawn(nodeBin, [accountsScript, ...subArgs], {
        env: { ...process.env, PORT: PROXY_PORT },
        cwd: PROXY_DIR,
        stdio: 'inherit',
    });

    await new Promise((resolve) => {
        accountsProcess.on('exit', resolve);
        accountsProcess.on('error', (error) => {
            err(`Failed to launch accounts manager: ${error.message}`);
            resolve();
        });
    });
}

async function cmdModels() {
    if (!(await isProxyRunning())) {
        err('Proxy not running. Start it first: vertexhub start');
        process.exit(1);
    }

    const models = await getModels();
    if (!models?.data || !Array.isArray(models.data)) {
        err('Could not fetch models from proxy.');
        process.exit(1);
    }

    console.log(`\n${c.bold}Available Models:${c.reset}\n`);
    for (const model of models.data) {
        // Sanitize model id for display (prevent terminal escape injection)
        const id = String(model.id || '').replace(/[\x00-\x1f\x7f]/g, '');
        console.log(`  ${c.cyan}${id}${c.reset}`);
    }
    console.log(`\n  Total: ${models.data.length} models\n`);
}

function cmdHelp() {
    console.log(`
${c.bold}${c.magenta}VertexHub CLI${c.reset} — Claude Code + Google Antigravity

${c.bold}Usage:${c.reset}
  vertexhub <command>

${c.bold}Commands:${c.reset}
  ${c.cyan}login${c.reset}      Link a Google account via OAuth
  ${c.cyan}start${c.reset}      Start proxy + launch Claude Code
  ${c.cyan}status${c.reset}     Check proxy health and config
  ${c.cyan}accounts${c.reset}   Manage linked Google accounts
  ${c.cyan}models${c.reset}     List available models
  ${c.cyan}help${c.reset}       Show this help

${c.bold}Environment:${c.reset}
  VERTEXHUB_PORT   Proxy port (default: ${DEFAULT_PORT})

${c.bold}First time?${c.reset}
  1. ${c.dim}vertexhub login${c.reset}     # Link your Google account
  2. ${c.dim}vertexhub start${c.reset}     # Start coding!
`);
}

// --- Main ---
const command = process.argv[2] || 'help';

switch (command) {
    case 'login': await cmdLogin(); break;
    case 'start': await cmdStart(); break;
    case 'status': await cmdStatus(); break;
    case 'accounts': await cmdAccounts(); break;
    case 'models': await cmdModels(); break;
    case 'help':
    case '--help':
    case '-h': cmdHelp(); break;
    default:
        err(`Unknown command: ${sanitizeForTerminal(command)}`);
        cmdHelp();
        process.exit(1);
}
