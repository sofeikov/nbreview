import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotebook } from '../src/core/notebook.ts';
import { diffCells } from '../src/core/cellDiff.ts';
import { checkFile, checkNotebook, entropy, findLocalPaths, findSecrets, findingPlace, patchLines, withoutStylesAndScripts } from '../src/core/checks.ts';

// Keys are put together at run time, so the test file itself has nothing that looks like a key
// (GitHub's push protection would refuse it).
function random(n: number, seed: number, chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'): string {
  let s = '';
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    s += chars[(x >>> 16) % chars.length];
  }
  return s;
}
const GITHUB = ['ghp', random(36, 1)].join('_');
const AWS = 'AK' + 'IA' + random(16, 2, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
const OPENAI = ['sk', 'proj', random(40, 3)].join('-');
const HF = ['hf', random(34, 4)].join('_');

interface CellSpec {
  id: string;
  source: string;
  type?: 'code' | 'markdown';
  count?: number | null;
  outputs?: unknown[];
}

function nb(cells: CellSpec[]) {
  return parseNotebook(JSON.stringify({
    cells: cells.map(c => (c.type === 'markdown'
      ? { cell_type: 'markdown', id: c.id, metadata: {}, source: c.source }
      : { cell_type: 'code', id: c.id, metadata: {}, execution_count: c.count ?? null, outputs: c.outputs ?? [], source: c.source })),
    metadata: { kernelspec: { language: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 1));
}

const stream = (text: string) => ({ output_type: 'stream', name: 'stdout', text });
const check = (base: CellSpec[], head: CellSpec[]) => checkNotebook(diffCells(nb(base).cells, nb(head).cells));

test('the parser reads execution counts of code cells', () => {
  const n = nb([{ id: 'a', source: 'x = 1', count: 3 }, { id: 'b', source: 'y' }, { id: 'm', source: '# Title', type: 'markdown' }]);
  assert.equal(n.cells[0].executionCount, 3);
  assert.equal(n.cells[1].executionCount, null);
  assert.equal(n.cells[2].executionCount, undefined);
});

test('findSecrets finds keys with a known prefix and masks them', () => {
  const found = findSecrets(`token = "${GITHUB}"`);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'GitHub token');
  assert.equal(found[0].value, GITHUB);
  assert.equal(found[0].masked, 'ghp_… (40 characters)');
  assert.ok(!found[0].masked.includes(GITHUB.slice(4, 10)));
  assert.equal(findSecrets(`aws = ${AWS}`)[0].kind, 'AWS access key');
  assert.equal(findSecrets(`client = OpenAI(api_key="${OPENAI}")`)[0].kind, 'OpenAI API key');
  assert.equal(findSecrets(`login(${HF})`)[0].kind, 'Hugging Face token');
  assert.equal(findSecrets('-----BEGIN RSA PRIVATE KEY-----')[0].kind, 'private key');
});

test('findSecrets finds passwords in assignments, URLs and .env lines', () => {
  const pw = random(14, 5);
  assert.equal(findSecrets(`DB_PASSWORD = "${pw}"`)[0].kind, 'key or password');
  assert.equal(findSecrets(`DB_PASSWORD = "${pw}"`)[0].masked, `DB_PASSWORD = ${pw.slice(0, 2)}… (14 characters)`);
  assert.equal(findSecrets(`config = {"api_key": "${pw}"}`)[0].kind, 'key or password');
  assert.equal(findSecrets(`os.environ["API_KEY"] = '${pw}'`)[0].kind, 'key or password');
  assert.equal(findSecrets(`engine = create_engine("postgresql://analyst:${pw}@db:5432/shots")`)[0].kind, 'password in a URL');
  assert.equal(findSecrets(`engine = create_engine("postgresql://analyst:${pw}@db:5432/shots")`)[0].masked, `postgresql://analyst:${pw.slice(0, 2)}… (14 characters)`);
  assert.equal(findSecrets(`SERVICE_TOKEN=${pw}`)[0].kind, 'key or password');
  assert.equal(findSecrets(`requests.get("https://api.example.org/v1?api_key=${pw}")`)[0].kind, 'key in a URL');
});

test('findSecrets leaves out placeholders, environment reads and ordinary names', () => {
  const none = [
    'token = os.environ["GITHUB_TOKEN"]',
    'password = ""',
    'api_key = "YOUR_API_KEY_HERE"',
    'api_key = "<your key>"',
    'password = "xxxxxxxxxxxx"',
    'password = "********"',
    'url = f"postgresql://{user}:{password}@{host}/db"',
    'url = "postgresql://user:${PASSWORD}@db/shots"',
    'tokenizer = "bert-base-uncased-v2"',
    'model_name = "meta-llama/Llama-3-8b"',
    'secret_name = "prod-db-1234"',
    `token = "ghp_${'a'.repeat(36)}"`,
    'AWS key in the docs: AKIAIOSFODNN7EXAMPLE',
    'commit = "3b32208ec43599277978a1818fa18fec9f32036c"',
    'id = "123e4567-e89b-12d3-a456-426614174000"',
    'x = 1  # tokens are counted here',
  ];
  for (const line of none) {
    assert.deepEqual(findSecrets(line), [], line);
  }
});

test('findSecrets ignores inline base64 images', () => {
  const blob = random(4000, 6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/') + 'AKIA' + random(16, 7, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
  assert.deepEqual(findSecrets(`<img src="data:image/png;base64,${blob}">`), []);
});

test('entropy is higher for random text', () => {
  assert.equal(entropy('aaaa'), 0);
  assert.ok(entropy(random(32, 8)) > 4);
});

test('findLocalPaths finds home folders on Linux, macOS and Windows', () => {
  assert.deepEqual(findLocalPaths('df = pd.read_csv("/home/alice/data/shots.csv")'), ['/home/alice/']);
  assert.deepEqual(findLocalPaths("open('/Users/bob/Desktop/x.png')"), ['/Users/bob/']);
  assert.deepEqual(findLocalPaths('path = r"C:\\Users\\carol\\shots.csv"'), ['C:\\Users\\carol\\']);
  assert.deepEqual(findLocalPaths('"C:\\\\Users\\\\carol\\\\shots.csv"'), ['C:\\\\Users\\\\carol\\\\']);
  assert.deepEqual(findLocalPaths('ROOT = Path.home() / "data"'), []);
  assert.deepEqual(findLocalPaths('/Users/Shared/data and ./home/x/ and /srv/home2/x/'), []);
});

test('a key added to a notebook cell is reported on its line', () => {
  const findings = check(
    [{ id: 'a', source: 'import requests' }],
    [{ id: 'a', source: `import requests\nTOKEN = "${GITHUB}"` }],
  );
  assert.equal(findings.length, 1);
  const [f] = findings;
  assert.equal(f.rule, 'secret');
  assert.equal(f.severity, 'high');
  assert.equal(f.cellId, 'a');
  assert.equal(f.kind, 'source');
  assert.equal(f.line, 1);
  assert.equal(findingPlace(f), 'cell 1, line 2');
  assert.ok(!f.comment.includes(GITHUB) && !f.detail.includes(GITHUB) && !f.evidence!.includes(GITHUB));
});

test('a key that is already in the base notebook is not reported again', () => {
  const findings = check(
    [{ id: 'a', source: `TOKEN = "${GITHUB}"` }],
    [{ id: 'a', source: `TOKEN = "${GITHUB}"\nprint(TOKEN)` }, { id: 'b', source: `T2 = "${GITHUB}"` }],
  );
  assert.deepEqual(findings, []);
});

test('keys and local paths in new outputs are reported; old outputs and markdown paths are not', () => {
  const findings = check(
    [{ id: 'a', source: 'show()', count: 1, outputs: [stream('/home/old/x\n')] }, { id: 'm', type: 'markdown', source: 'Old' }],
    [
      { id: 'a', source: 'show()', count: 1, outputs: [stream('/home/old/x\n'), stream(`key: ${AWS}\nsaved to /home/alice/out.png\n`)] },
      { id: 'm', type: 'markdown', source: 'Data is in /home/alice/data' },
    ],
  );
  assert.deepEqual(findings.map(f => [f.rule, f.kind, f.outputIndex]), [['secret', 'output', 1], ['local-path', 'output', 1]]);
  assert.equal(findings[1].evidence, '/home/alice/');
});

test('an error output is reported, without also reporting the paths in its traceback', () => {
  const error = { output_type: 'error', ename: 'KeyError', evalue: "'body_part'", traceback: ['File /home/alice/.venv/lib/x.py', "KeyError: 'body_part'"] };
  const findings = check([{ id: 'a', source: 'x' }], [{ id: 'a', source: 'x', count: 1, outputs: [error] }]);
  assert.deepEqual(findings.map(f => f.rule), ['error-output']);
  assert.equal(findings[0].evidence, "KeyError: 'body_part'");
});

test('a large new output is reported', () => {
  const big = { output_type: 'display_data', data: { 'text/html': 'x'.repeat(1_200_000), 'text/plain': 'Figure' }, metadata: {} };
  const findings = check([{ id: 'a', source: 'fig' }], [{ id: 'a', source: 'fig', count: 1, outputs: [big] }]);
  assert.deepEqual(findings.map(f => f.rule), ['large-output']);
  assert.match(findings[0].title, /Large output \(1\.\d MB\)/);
});

test('changed code with the same execution count and outputs is reported as stale', () => {
  const out = [stream('0.81\n')];
  // Counts 3 and 4: not one clean run, so an unchanged count means the cell didn't run again.
  const stale = check(
    [{ id: 'a', source: 'auc(model)', count: 3, outputs: out }, { id: 'b', source: 'b', count: 4 }],
    [{ id: 'a', source: 'auc(model2)', count: 3, outputs: out }, { id: 'b', source: 'b', count: 4 }],
  );
  assert.deepEqual(stale.map(f => [f.rule, f.kind]), [['stale-output', 'cell']]);
  // Run again: a new count, even with the same output, is fine.
  assert.deepEqual(check(
    [{ id: 'a', source: 'auc(model)', count: 3, outputs: out }],
    [{ id: 'a', source: 'auc(model2)', count: 5, outputs: out }],
  ).filter(f => f.rule === 'stale-output'), []);
});

test('no stale outputs after one clean run, or when only whitespace changed', () => {
  const out = [stream('(10, 2)\n')];
  // "Restart and run all" gives 1, 2… again: the same count doesn't mean the cell didn't run.
  assert.deepEqual(check(
    [{ id: 'a', source: 'df.shape', count: 1, outputs: out }],
    [{ id: 'a', source: 'df.shape  # rows, cols', count: 1, outputs: out }],
  ), []);
  assert.deepEqual(check(
    [{ id: 'a', source: 'y=f( 1,2 )', count: 3, outputs: out }],
    [{ id: 'a', source: 'y = f(1, 2)', count: 3, outputs: out }],
  ).filter(f => f.rule === 'stale-output'), []);
});

test('a key in an error message is reported and masked, and never reaches the comment', () => {
  const key = random(24, 21);
  const error = { output_type: 'error', ename: 'HTTPError', evalue: `401 Client Error: Unauthorized for url: https://api.example.com/v1/data?api_key=${key}`, traceback: ['HTTPError: 401'] };
  const findings = check([{ id: 'a', source: 'x' }], [{ id: 'a', source: 'x', count: 1, outputs: [error] }]);
  assert.deepEqual(findings.map(f => f.rule), ['secret', 'error-output']);
  for (const f of findings) {
    for (const text of [f.title, f.detail, f.evidence ?? '', f.comment]) {
      assert.ok(!text.includes(key), text);
    }
  }
  assert.match(findings[1].evidence!, /\?api_key=\[hidden, 24 characters\]$/);
});

test('scikit-learn HTML outputs are not reported as keys', () => {
  const html = '<style>#sk-container-id-1 .sk-toggleable__label-arrow:before {content: "▸";} .sk-estimator-doc-link-fitted {}</style>'
    + '<div id="sk-container-id-1" class="sk-top-container"><div class="sk-text-repr-fallback"><pre>Pipeline(steps=[(&#x27;standardscaler&#x27;, StandardScaler())])</pre></div>'
    + '<label class="sk-toggleable__label-arrow-fitted-something-long">Pipeline</label></div>';
  const out = { output_type: 'execute_result', execution_count: 1, data: { 'text/html': html, 'text/plain': 'Pipeline(...)' }, metadata: {} };
  assert.deepEqual(check([{ id: 'a', source: 'pipe' }], [{ id: 'a', source: 'pipe', count: 1, outputs: [out] }]), []);
  assert.deepEqual(findSecrets('name = "sk-learn-regression-model-v2"'), []);
  assert.deepEqual(findSecrets('ticker = "sk-hynix-2023-quarterly-revenue"'), []);
});

test('file names, references, cursors and working folders are not keys', () => {
  const none = [
    'os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "keys/sa-key-2024.json"',
    'credentials = "gcp_creds_v2.json"',
    'pwd = "data/runs/2023-10-01"',
    '{"nextToken": "AQICAHhB3dfh2k3Lm9xQ"}',
    'cursor_token = "eyJsYXN0SWQiOjEyMzR9"',
    '    api_key=config.openai_key_v2',
    'API_KEY=config.openai_key_v2',
    'url = "https://www.google.com/search?key=sales_by_region_2023"',
    'last_checkpoint_token = "ckpt-2024-01-05_v3"',
    'ssh_private_key = "id_rsa_2023"',
  ];
  for (const line of none) {
    assert.deepEqual(findSecrets(line), [], line);
  }
});

test('more key formats: GitLab, Slack apps, bearer tokens, and unquoted values in config files', () => {
  assert.equal(findSecrets(['glpat', random(20, 22)].join('-'))[0].kind, 'GitLab token');
  assert.equal(findSecrets(['xapp', '1', random(30, 23)].join('-'))[0].kind, 'Slack token');
  assert.equal(findSecrets(`headers = {"Authorization": "Bearer ${random(32, 24)}"}`)[0].kind, 'bearer token');
  assert.deepEqual(findSecrets('headers = {"Authorization": f"Bearer {GITHUB_TOKEN}"}'), []);
  const pw = random(14, 25);
  assert.equal(checkFile('docker-compose.yml', [], [{ index: 0, text: `  POSTGRES_PASSWORD: ${pw}` }])[0].rule, 'secret');
  assert.equal(checkFile('setup.cfg', [], [{ index: 0, text: `aws_secret_access_key = ${random(40, 26)}` }])[0].rule, 'secret');
  assert.equal(checkFile('.env.local', [], [{ index: 0, text: `DB_PASSWORD: ${pw}` }])[0].rule, 'secret');
  // In code, a bare value after `=` is a name, not a key.
  assert.deepEqual(checkFile('src/x.py', [], [{ index: 0, text: `password = ${pw}` }]), []);
});

test('local paths already in the base are not reported again; jovyan is not a user', () => {
  const warn = '/home/alice/.venv/lib/python3.11/site-packages/sklearn/base.py:1: FutureWarning\n';
  assert.deepEqual(check(
    [{ id: 'a', source: 'fit()', count: 1, outputs: [stream(warn + 'loss 0.31\n')] }],
    [{ id: 'a', source: 'fit()', count: 1, outputs: [stream(warn + 'loss 0.29\n')] }],
  ), []);
  assert.deepEqual(check(
    [{ id: 'a', source: 'pd.read_csv("/home/alice/data.csv")' }],
    [{ id: 'a', source: 'pd.read_csv("/home/alice/data.csv", sep=";")' }],
  ), []);
  assert.deepEqual(findLocalPaths('/home/jovyan/work/data.csv'), []);
});

test('run order: out of order, gaps, and clean runs', () => {
  const base: CellSpec[] = [{ id: 'a', source: 'a' }, { id: 'b', source: 'b' }, { id: 'c', source: 'c' }];
  const run = (counts: (number | null)[]) => check(base, base.map((c, i) => ({ ...c, count: counts[i] })));
  const out = run([1, 3, 2]);
  assert.deepEqual(out.map(f => [f.rule, f.cellId, f.title]), [['run-order', 'c', 'Cells ran out of order']]);
  assert.deepEqual(run([2, 3, 4]).map(f => f.title), ['Not one clean run']);
  assert.deepEqual(run([1, 2, 5]).map(f => [f.title, f.cellId]), [['Not one clean run', 'c']]);
  assert.deepEqual(run([1, 2, 3]), []);
  // Cells that didn't run (empty, or cleared) are skipped.
  assert.deepEqual(run([1, null, 2]), []);
});

test('run order is not reported when the pull request ran nothing', () => {
  const cells: CellSpec[] = [{ id: 'a', source: 'a', count: 5 }, { id: 'b', source: 'b', count: 2 }];
  assert.deepEqual(check(cells, cells.map(c => (c.id === 'a' ? { ...c, source: 'a2' } : c))).filter(f => f.rule === 'run-order'), []);
});

test('checkFile reports keys and paths in added lines, and paths not in Markdown', () => {
  const pw = random(16, 9);
  const findings = checkFile('src/db.py', ['import os'], [{ index: 3, text: `PASSWORD = "${pw}"` }, { index: 4, text: 'ROOT = "/home/alice/xg"' }]);
  assert.deepEqual(findings.map(f => [f.rule, f.line, f.cellId]), [['secret', 3, 'file'], ['local-path', 4, 'file']]);
  assert.equal(findingPlace(findings[0]), 'line 4');
  assert.deepEqual(checkFile('README.md', [], [{ index: 0, text: 'Run `python /home/alice/x.py`' }]), []);
  // The same value anywhere in the old file was there before.
  assert.deepEqual(checkFile('src/db.py', [`OLD = "${pw}"`], [{ index: 0, text: `PASSWORD = "${pw}"` }]), []);
});

test('patchLines gives added lines with their head line index, and removed lines', () => {
  const patch = '@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -10,2 +11,2 @@\n x\n+y\n\\ No newline at end of file';
  const { added, removed } = patchLines(patch);
  assert.deepEqual(added, [{ index: 1, text: 'B' }, { index: 2, text: 'C' }, { index: 11, text: 'y' }]);
  assert.deepEqual(removed, ['b']);
});

test('withoutStylesAndScripts drops style and script elements, closed or not, quickly', () => {
  assert.equal(withoutStylesAndScripts('a<style>.sk-x{}</style>b<SCRIPT src=x>run()</script>c'), 'a >b >c');
  assert.equal(withoutStylesAndScripts('a<script>never closed'), 'a ');
  const start = performance.now();
  withoutStylesAndScripts('<script'.repeat(50_000));
  withoutStylesAndScripts('<style>x'.repeat(50_000));
  assert.ok(performance.now() - start < 200);
});
