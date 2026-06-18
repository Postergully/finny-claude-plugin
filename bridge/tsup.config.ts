import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/mcp/tools/query.ts',
    'src/mcp/tools/taskStatus.ts',
    'src/mcp/tools/executeSuiteQL.ts',
    'src/mcp/tools/report.ts',
    'src/mcp/tools/continue.ts',
  ],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  bundle: true,
  splitting: true,
  minify: false,
  sourcemap: false,
  clean: true,
  dts: false,
  platform: 'node',
  external: ['better-sqlite3'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
});
