import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

const configs = [
  { ...shared, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...shared, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli.js', banner: { js: '#!/usr/bin/env node' } },
];

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
}

if (process.argv.includes('--tests')) {
  await esbuild.build({ ...shared, entryPoints: ['test/extension/runTest.ts'], outfile: 'dist/test/runTest.js', external: ['vscode', '@vscode/test-electron'] });
  await esbuild.build({ ...shared, entryPoints: ['test/extension/suite.ts'], outfile: 'dist/test/suite.js', external: ['vscode'] });
}
