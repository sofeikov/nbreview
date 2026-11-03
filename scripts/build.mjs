// Bundles the extension, the review page and the Overview page, and copies their assets into dist/.
import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/katex/fonts', { recursive: true });

const common = { bundle: true, minify: true, logLevel: 'warning', mainFields: ['module', 'main'] };

// The pages use a handful of VS Code's codicons each; their SVGs are built into the page scripts
// rather than shipping the whole icon font (461 icons).
const icons = async list => Object.fromEntries(await Promise.all(JSON.parse(await readFile(list, 'utf8')).map(async name =>
  [name, (await readFile(`node_modules/@vscode/codicons/src/icons/${name}.svg`, 'utf8')).trim()])));
await Promise.all([
  build({ ...common, entryPoints: ['src/extension.ts'], platform: 'node', format: 'cjs', external: ['vscode'], outfile: 'dist/extension.js' }),
  build({ ...common, entryPoints: ['src/webview/main.ts'], platform: 'browser', format: 'iife', target: 'es2022', outfile: 'dist/webview.js', define: { __ICONS__: JSON.stringify(await icons('src/webview/icons.json')) } }),
  build({ ...common, entryPoints: ['src/webview/overview.ts'], platform: 'browser', format: 'iife', target: 'es2022', outfile: 'dist/overview.js', define: { __ICONS__: JSON.stringify(await icons('src/webview/overviewIcons.json')) } }),
]);

await cp('media/webview.css', 'dist/webview.css');
await cp('media/overview.css', 'dist/overview.css');
// The page loads the woff2 fonts only, so the woff and ttf references are dropped from the CSS.
const katexCss = (await readFile('node_modules/katex/dist/katex.min.css', 'utf8')).replace(/,url\([^)]+\.(woff|ttf)\) format\("(woff|truetype)"\)/g, '');
await writeFile('dist/katex/katex.min.css', katexCss);
for (const f of await readdir('node_modules/katex/dist/fonts')) {
  if (f.endsWith('.woff2')) {
    await cp(`node_modules/katex/dist/fonts/${f}`, `dist/katex/fonts/${f}`);
  }
}
console.log('built dist/');
