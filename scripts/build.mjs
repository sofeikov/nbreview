// Bundles the extension and the visual review page, and copies the page's assets into dist/.
import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/katex/fonts', { recursive: true });
await mkdir('dist/codicons', { recursive: true });

const common = { bundle: true, minify: true, logLevel: 'warning', mainFields: ['module', 'main'] };
await Promise.all([
  build({ ...common, entryPoints: ['src/extension.ts'], platform: 'node', format: 'cjs', external: ['vscode'], outfile: 'dist/extension.js' }),
  build({ ...common, entryPoints: ['src/webview/main.ts'], platform: 'browser', format: 'iife', target: 'es2022', outfile: 'dist/webview.js' }),
]);

await cp('media/webview.css', 'dist/webview.css');
// The page loads the woff2 fonts only, so the woff and ttf references are dropped from the CSS.
const katexCss = (await readFile('node_modules/katex/dist/katex.min.css', 'utf8')).replace(/,url\([^)]+\.(woff|ttf)\) format\("(woff|truetype)"\)/g, '');
await writeFile('dist/katex/katex.min.css', katexCss);
for (const f of await readdir('node_modules/katex/dist/fonts')) {
  if (f.endsWith('.woff2')) {
    await cp(`node_modules/katex/dist/fonts/${f}`, `dist/katex/fonts/${f}`);
  }
}
await cp('node_modules/@vscode/codicons/dist/codicon.css', 'dist/codicons/codicon.css');
await cp('node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/codicons/codicon.ttf');
console.log('built dist/');
