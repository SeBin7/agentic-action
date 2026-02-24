import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const uiDir = path.join(repoRoot, 'ui');
const uiPackageJson = path.join(uiDir, 'package.json');

if (!existsSync(uiPackageJson)) {
  console.log('[ui:build] ui/package.json not found, skip build.');
  process.exit(0);
}

const hasLock = existsSync(path.join(uiDir, 'package-lock.json'));
const installCmd = hasLock ? ['ci'] : ['install'];
let result = spawnSync('npm', installCmd, {
  cwd: uiDir,
  stdio: 'inherit',
  shell: false
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

result = spawnSync('npm', ['run', 'build'], {
  cwd: uiDir,
  stdio: 'inherit',
  shell: false
});

process.exit(result.status ?? 1);
