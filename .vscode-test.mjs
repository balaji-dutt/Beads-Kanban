import { defineConfig } from '@vscode/test-cli';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// VS Code opens its IPC socket inside --user-data-dir, which otherwise lands in
// <project>/.vscode-test. macOS caps Unix socket paths at 103 characters, and a
// linked worktree's path leaves no room for one. The hash keys the directory to
// this checkout, so runs from two worktrees do not share a socket.
const projectRoot = dirname(fileURLToPath(import.meta.url));
const userDataDir = join(
  tmpdir(),
  `vsct-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 8)}`
);

export default defineConfig({
  tests: [
    {
      label: 'Extension Tests',
      files: 'out/test/suite/**/*.test.js',
      workspaceFolder: '.',
      launchArgs: ['--disable-extensions', `--user-data-dir=${userDataDir}`],
      mocha: {
        ui: 'tdd',
        timeout: 20000,
        color: true
      }
    }
  ]
});
