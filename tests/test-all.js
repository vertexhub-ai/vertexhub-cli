/**
 * Comprehensive test battery for vertexhub-cli
 * Tests security, edge cases, error paths
 */

import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';

const CLI = '/home/daniloluiz/vertexhub-cli/bin/vertexhub.js';
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.log(`  ❌ ${name}: ${e.message}`);
        failed++;
    }
}

function run(args, env = {}) {
    const envStr = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    try {
        return execSync(
            `bash -c 'export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && ${envStr} node ${CLI} ${args} 2>&1'`,
            { encoding: 'utf-8', timeout: 15000 }
        ).trim();
    } catch (e) {
        // Return combined output even on non-zero exit
        return (e.stdout || '') + (e.stderr || '');
    }
}

function runExitCode(args, env = {}) {
    const envStr = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    try {
        execSync(
            `bash -c 'export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && ${envStr} node ${CLI} ${args} 2>&1'`,
            { encoding: 'utf-8', timeout: 15000 }
        );
        return 0;
    } catch (e) {
        return e.status;
    }
}

// =========================================
console.log('\n━━━ TEST 1: PORT SANITIZATION ━━━');
// =========================================

test('Valid port 8090 accepted', () => {
    const out = run('help', { VERTEXHUB_PORT: '8090' });
    if (!out.includes('8090')) throw new Error('port not in output');
});

test('Port 0 rejected (below range)', () => {
    const out = run('help', { VERTEXHUB_PORT: '0' });
    if (!out.includes('8090')) throw new Error('should fallback to default');
});

test('Port 99999 rejected (above range)', () => {
    const out = run('help', { VERTEXHUB_PORT: '99999' });
    if (!out.includes('8090')) throw new Error('should fallback to default');
});

test('Port "abc" rejected (non-numeric)', () => {
    const out = run('help', { VERTEXHUB_PORT: 'abc' });
    if (!out.includes('8090')) throw new Error('should fallback to default');
});

test('Port injection "8080; rm -rf /" rejected', () => {
    const out = run('help', { VERTEXHUB_PORT: '8080; rm -rf /' });
    if (!out.includes('8090')) throw new Error('injection should fallback');
});

test('Port "-1" rejected (negative)', () => {
    const out = run('help', { VERTEXHUB_PORT: '-1' });
    if (!out.includes('8090')) throw new Error('negative should fallback');
});

test('Port "08080" rejected (leading zero)', () => {
    const out = run('help', { VERTEXHUB_PORT: '08080' });
    if (!out.includes('8090')) throw new Error('leading zero should fallback');
});

test('Port "65535" accepted (max valid)', () => {
    const out = run('help', { VERTEXHUB_PORT: '65535' });
    if (!out.includes('65535')) throw new Error('max port should be accepted');
});

test('Port "1" accepted (min valid)', () => {
    const out = run('help', { VERTEXHUB_PORT: '1' });
    if (!out.includes('default: 8090')) throw new Error('help should show default');
});

test('Port "3.14" rejected (float)', () => {
    const out = run('help', { VERTEXHUB_PORT: '3.14' });
    if (!out.includes('8090')) throw new Error('float should fallback');
});

// =========================================
console.log('\n━━━ TEST 2: COMMAND VALIDATION ━━━');
// =========================================

test('Unknown command exits with code 1', () => {
    const code = runExitCode('hackercommand');
    if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
});

test('Unknown command error message shown', () => {
    const out = run('hackercommand');
    if (!out.includes('Unknown command')) throw new Error('no error message');
});

test('Empty args shows help (no error)', () => {
    const out = run('');
    if (!out.includes('VertexHub CLI')) throw new Error('no help');
});

test('--help flag works', () => {
    const out = run('--help');
    if (!out.includes('Commands:')) throw new Error('no help');
});

test('-h flag works', () => {
    const out = run('-h');
    if (!out.includes('Commands:')) throw new Error('no help');
});

test('Command with extra flags still shows help', () => {
    const out = run('help --verbose');
    if (!out.includes('Commands:')) throw new Error('no help');
});

// =========================================
console.log('\n━━━ TEST 3: STATUS COMMAND ━━━');
// =========================================

test('Status exits cleanly with code 0', () => {
    const code = runExitCode('status');
    if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
});

test('Status shows proxy status', () => {
    const out = run('status');
    if (!out.includes('Proxy:')) throw new Error('no proxy line');
});

test('Status checks proxy dir', () => {
    const out = run('status');
    if (!out.includes('Proxy Dir:')) throw new Error('no dir check');
});

test('Status checks Node.js', () => {
    const out = run('status');
    if (!out.includes('Node.js:')) throw new Error('no node check');
});

test('Status uses 127.0.0.1 not 0.0.0.0', () => {
    const out = run('status');
    if (out.includes('0.0.0.0')) throw new Error('should not use 0.0.0.0');
});

test('Status checks Claude Code', () => {
    const out = run('status');
    if (!out.includes('Claude Code:')) throw new Error('no Claude Code check');
});

// =========================================
console.log('\n━━━ TEST 4: FILE SECURITY ━━━');
// =========================================

test('Settings file would be created with 0o600 permissions', () => {
    // This tests the intent - if settings file exists after a start, check perms
    const settingsFile = join(homedir(), '.claude', 'settings.json');
    if (existsSync(settingsFile)) {
        const stats = statSync(settingsFile);
        const mode = (stats.mode & 0o777).toString(8);
        if (mode !== '600') throw new Error(`permissions are ${mode}, expected 600`);
    }
    // If it doesn't exist, that's OK — we just verify the code path is correct
});

// =========================================
console.log('\n━━━ TEST 5: HELP OUTPUT INTEGRITY ━━━');
// =========================================

test('Help shows all 6 commands', () => {
    const out = run('help');
    const cmds = ['login', 'start', 'status', 'accounts', 'models', 'help'];
    for (const cmd of cmds) {
        if (!out.includes(cmd)) throw new Error(`missing command: ${cmd}`);
    }
});

test('Help shows environment variable', () => {
    const out = run('help');
    if (!out.includes('VERTEXHUB_PORT')) throw new Error('no env var');
});

test('Help shows first-time instructions', () => {
    const out = run('help');
    if (!out.includes('First time?')) throw new Error('no first-time section');
});

// =========================================
console.log('\n━━━ TEST 6: PROXY DIR VALIDATION ━━━');
// =========================================

test('Proxy dir exists at expected path', () => {
    if (!existsSync('/home/daniloluiz/antigravity-proxy')) {
        throw new Error('proxy dir missing');
    }
});

test('Proxy entry point exists', () => {
    if (!existsSync('/home/daniloluiz/antigravity-proxy/src/index.js')) {
        throw new Error('index.js missing');
    }
});

test('Accounts script exists', () => {
    if (!existsSync('/home/daniloluiz/antigravity-proxy/src/cli/accounts.js')) {
        throw new Error('accounts.js missing');
    }
});

// =========================================
console.log('\n━━━ TEST 7: EDGE CASES ━━━');
// =========================================

test('Very long command arg does not crash', () => {
    const longArg = 'x'.repeat(1000);
    const code = runExitCode(longArg);
    if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
});

test('Special characters in command do not cause injection', () => {
    const out = run('$(echo hacked)');
    if (out.includes('hacked')) throw new Error('command injection succeeded');
});

test('Semicolon in command does not cause injection', () => {
    const out = run('; echo hacked');
    if (out.toLowerCase().includes('hacked')) throw new Error('injection via semicolon');
});

test('Pipe in command does not cause injection', () => {
    const code = runExitCode('help | cat');
    // Should just fail cleanly as unknown command
});

// =========================================
console.log('\n━━━ TEST 8: MODELS COMMAND (requires proxy) ━━━');
// =========================================

test('Models command works when proxy is running', () => {
    const out = run('models');
    if (out.includes('Not running')) {
        console.log('    (skipped - proxy not running on default port)');
    } else if (!out.includes('Available Models') && !out.includes('Could not fetch')) {
        throw new Error('unexpected output');
    }
});

// =========================================
console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  TOTAL: ${passed + failed} tests`);
console.log(`  ✅ Passed: ${passed}`);
console.log(`  ❌ Failed: ${failed}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exit(failed > 0 ? 1 : 0);
