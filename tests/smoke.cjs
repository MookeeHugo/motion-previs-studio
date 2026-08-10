// Kept for older tooling that still invokes tests/smoke.cjs directly.
require('node:child_process').execFileSync('node', ['scripts/smoke.js'], {
  cwd: require('node:path').resolve(__dirname, '..'),
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
