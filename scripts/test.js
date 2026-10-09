const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

async function main() {
    const root = path.resolve(__dirname, '..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'juryportal-cleanup-'));
    const list = path.join(directory, 'fixtures.jsonl');
    const tests = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js')).map(name => path.join(root, 'test', name));
    const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...tests], {
        cwd: root, stdio: 'inherit', env: { ...process.env, JURY_TEST_CLEANUP_LIST: list }
    });
    const paths = fs.existsSync(list) ? fs.readFileSync(list, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    for (const target of [...new Set(paths), directory]) {
        const resolved = path.resolve(target);
        if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('juryportal-')) throw new Error('Unsafe test cleanup target.');
        await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
