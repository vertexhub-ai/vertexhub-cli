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
 *   vertexhub config   - Show/edit configuration
 *   vertexhub models   - List available models
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Config ---
const PROXY_DIR = resolve(join(__dirname, '..', '..', 'antigravity-proxy'));
const PROXY_PORT = process.env.VERTEXHUB_PORT || '8090';
const PROXY_URL = `http://localhost:${PROXY_PORT}`;
const CLAUDE_CONFIG_DIR = join(homedir(), '.claude');
const CLAUDE_SETTINGS_FILE = join(CLAUDE_CONFIG_DIR, 'settings.json');
const CLAUDE_JSON_FILE = join(homedir(), '.claude.json');

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

function log(msg) { console.log(`${c.cyan}[VertexHub]${c.reset} ${msg}`); }
function ok(msg) { console.log(`${c.green}✓${c.reset} ${msg}`); }
function warn(msg) { console.log(`${c.yellow}⚠${c.reset} ${msg}`); }
function err(msg) { console.error(`${c.red}✗${c.reset} ${msg}`); }

// --- Helpers ---

function getNvmNodePath() {
    const nvmDir = join(homedir(), '.nvm');
    try {
        const defaultAlias = readFileSync(join(nvmDir, 'alias', 'default'), 'utf-8').trim();
        const version = defaultAlias.startsWith('v') ? defaultAlias : `v${defaultAlias}`;

        // Find matching version directory
        const versionsDir = join(nvmDir, 'versions', 'node');
        if (existsSync(versionsDir)) {
            const dirs = readdirSync(versionsDir).filter(d => d.startsWith(version) || d.startsWith(`v${version}`));
            if (dirs.length > 0) {
                const nodeDir = join(versionsDir, dirs[dirs.length - 1], 'bin');
                if (existsSync(join(nodeDir, 'node'))) return nodeDir;
            }
        }
    } catch { }
    return null;
}

function getNodeBin() {
    // Try system node first
    try {
        execSync('which node', { stdio: 'pipe' });
        return 'node';
    } catch { }

    // Try NVM
    const nvmDir = join(homedir(), '.nvm');
    if (existsSync(nvmDir)) {
        try {
            const result = execSync(
                `bash -c 'export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && which node'`,
                { stdio: 'pipe', encoding: 'utf-8' }
            ).trim();
            if (result) return result;
        } catch { }
    }

    return null;
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
            fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()),
            fetch(`${PROXY_URL}/account-limits`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null),
        ]);
        return { health, limits };
    } catch {
        return null;
    }
}

async function getModels() {
    try {
        const response = await fetch(`${PROXY_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
        return response.json();
    } catch {
        return null;
    }
}

function configureClaudeSettings() {
    mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });

    let settings = {};
    if (existsSync(CLAUDE_SETTINGS_FILE)) {
        try {
            settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8'));
        } catch { }
    }

    settings.env = {
        ...settings.env,
        ANTHROPIC_AUTH_TOKEN: 'test',
        ANTHROPIC_BASE_URL: PROXY_URL,
        ANTHROPIC_MODEL: 'claude-opus-4-6-thinking',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6-thinking',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5-thinking',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-5',
        CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-4-5-thinking',
    };

    writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
    ok(`Claude Code settings configured → ${CLAUDE_SETTINGS_FILE}`);

    // Ensure hasCompletedOnboarding is set
    let claudeJson = {};
    if (existsSync(CLAUDE_JSON_FILE)) {
        try {
            claudeJson = JSON.parse(readFileSync(CLAUDE_JSON_FILE, 'utf-8'));
        } catch { }
    }
    if (!claudeJson.hasCompletedOnboarding) {
        claudeJson.hasCompletedOnboarding = true;
        writeFileSync(CLAUDE_JSON_FILE, JSON.stringify(claudeJson, null, 2));
        ok('Claude Code onboarding bypassed');
    }
}

function startProxy() {
    const nodeBin = getNodeBin();
    if (!nodeBin) {
        err('Node.js not found. Install Node.js 18+ first.');
        process.exit(1);
    }

    log(`Starting Antigravity proxy on port ${PROXY_PORT}...`);

    const env = { ...process.env, PORT: PROXY_PORT };
    const proxyProcess = spawn(nodeBin, [join(PROXY_DIR, 'src', 'index.js')], {
        env,
        cwd: PROXY_DIR,
        stdio: 'pipe',
        detached: true,
    });

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
        }
    });

    return proxyProcess;
}

// --- Commands ---

async function cmdLogin() {
    console.log(`
${c.bold}${c.cyan}╔══════════════════════════════════════╗
║       VertexHub — Google Login       ║
╚══════════════════════════════════════╝${c.reset}
`);

    // Check if proxy is running
    if (!(await isProxyRunning())) {
        log('Proxy not running, starting it first...');
        startProxy();
        // Wait for proxy to start
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await isProxyRunning()) break;
        }
    }

    if (!(await isProxyRunning())) {
        err('Could not start proxy. Start it manually with: vertexhub start');
        process.exit(1);
    }

    // Launch accounts manager
    const nodeBin = getNodeBin();
    const accountsProcess = spawn(nodeBin, [join(PROXY_DIR, 'src', 'cli', 'accounts.js'), 'add'], {
        env: { ...process.env, PORT: PROXY_PORT },
        cwd: PROXY_DIR,
        stdio: 'inherit',
    });

    accountsProcess.on('exit', (code) => {
        if (code === 0) {
            ok('Google account linked successfully!');
            configureClaudeSettings();
            log(`Run ${c.bold}vertexhub start${c.reset} to begin coding with Claude Code.`);
        }
    });
}

async function cmdStart() {
    console.log(`
${c.bold}${c.magenta}╔══════════════════════════════════════╗
║     VertexHub — Starting Session     ║
╚══════════════════════════════════════╝${c.reset}
`);

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
            err('Proxy failed to start. Check logs.');
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
            ANTHROPIC_AUTH_TOKEN: 'test',
        },
        stdio: 'inherit',
    });

    claudeProcess.on('error', (error) => {
        if (error.code === 'ENOENT') {
            err('Claude Code CLI not found. Install it first:');
            console.log(`  ${c.dim}npm install -g @anthropic-ai/claude-code${c.reset}`);
            console.log(`  ${c.dim}or: curl -fsSL https://claude.ai/install.sh | sh${c.reset}`);
        }
    });

    claudeProcess.on('exit', (code) => {
        log(`Session ended (code: ${code})`);
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
                const name = acc.email || acc.id || 'unknown';
                console.log(`    → ${name}: ${acc.status || 'active'}`);
            }
        }
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
            console.log(`  Claude Config: ${c.yellow}● Invalid${c.reset}`);
        }
    } else {
        console.log(`  Claude Config: ${c.red}● Not configured${c.reset}`);
        console.log(`    Run: ${c.dim}vertexhub start${c.reset} to auto-configure`);
    }

    // Claude Code installed?
    try {
        execSync('which claude', { stdio: 'pipe' });
        console.log(`  Claude Code: ${c.green}● Installed${c.reset}`);
    } catch {
        console.log(`  Claude Code: ${c.red}● Not found${c.reset}`);
    }

    console.log();
}

async function cmdAccounts() {
    if (!(await isProxyRunning())) {
        err('Proxy not running. Start it first: vertexhub start');
        process.exit(1);
    }

    const nodeBin = getNodeBin();
    spawn(nodeBin, [join(PROXY_DIR, 'src', 'cli', 'accounts.js'), ...(process.argv.slice(3))], {
        env: { ...process.env, PORT: PROXY_PORT },
        cwd: PROXY_DIR,
        stdio: 'inherit',
    });
}

async function cmdModels() {
    if (!(await isProxyRunning())) {
        err('Proxy not running. Start it first: vertexhub start');
        process.exit(1);
    }

    const models = await getModels();
    if (!models?.data) {
        err('Could not fetch models from proxy.');
        process.exit(1);
    }

    console.log(`\n${c.bold}Available Models:${c.reset}\n`);
    for (const model of models.data) {
        console.log(`  ${c.cyan}${model.id}${c.reset}`);
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
  VERTEXHUB_PORT   Proxy port (default: 8090)

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
        err(`Unknown command: ${command}`);
        cmdHelp();
        process.exit(1);
}
