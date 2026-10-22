// Bundles the extension and the visual review page, and copies the page's assets into dist/.
import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/katex/fonts', { recursive: true });

const common = { bundle: true, minify: true, logLevel: 'warning', mainFields: ['module', 'main'] };

// The page uses a handful of VS Code's codicons; their SVGs are built into the page script rather
// than shipping the whole icon font (461 icons).
const iconNames = JSON.parse(await readFile('src/webview/icons.json', 'utf8'));
const icons = Object.fromEntries(await Promise.all(iconNames.map(async name =>
  [name, (await readFile(`node_modules/@vscode/codicons/src/icons/${name}.svg`, 'utf8')).trim()])));
await Promise.all([
  build({ ...common, entryPoints: ['src/extension.ts'], platform: 'node', format: 'cjs', external: ['vscode'], outfile: 'dist/extension.js' }),
  build({ ...common, entryPoints: ['src/webview/main.ts'], platform: 'browser', format: 'iife', target: 'es2022', outfile: 'dist/webview.js', define: { __ICONS__: JSON.stringify(icons) } }),
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
console.log('built dist/');
