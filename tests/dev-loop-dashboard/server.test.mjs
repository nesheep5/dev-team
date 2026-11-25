import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard, defaultLedgerPath, readLedger, resolveProjectsFromArgs } from '../../plugins/dev-team/skills/dev-loop-dashboard/server.mjs';

// 一時リポジトリにイベントのフィクスチャを用意する
function makeRepo(eventsLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devloop-dash-'));
  if (eventsLines !== null) {
    fs.mkdirSync(path.join(dir, '.claude/dev-loop'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude/dev-loop/events.jsonl'), eventsLines.join('\n') + '\n');
  }
  return dir;
}

const fakeGh = (issues, prs) => async (args) =>
  JSON.stringify(args[0] === 'issue' ? issues : prs);

test('GET /api/state が統合済みの状態を返す', async () => {
  const repo = makeRepo([
    JSON.stringify({ ts: '2026-08-14T10:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } }),
    JSON.stringify({ ts: '2026-08-14T10:05:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'implementing' }),
  ]);
  const gh = fakeGh(
    [{ number: 29, title: '配色改善', state: 'OPEN', labels: [{ name: 'status:in-progress' }], body: '' }],
    [],
  );
  const dash = createDashboard({ repoRoot: repo, gh });
  await dash.start();
  await new Promise((resolve) => dash.server.listen(0, resolve));
  const port = dash.server.address().port;
  after(() => dash.stop());

  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.loop.running, true);
  const t = state.tickets.find((x) => x.number === 29);
  assert.equal(t.station, 'implementing');
  assert.equal(t.title, '配色改善');
});

test('GET /events は SSE で初期状態を即送る', async () => {
  const repo = makeRepo(null); // イベントファイル無し → 劣化モード
  const dash = createDashboard({ repoRoot: repo, gh: fakeGh([], []) });
  await dash.start();
  await new Promise((resolve) => dash.server.listen(0, resolve));
  const port = dash.server.address().port;
  after(() => dash.stop());

  const res = await fetch(`http://127.0.0.1:${port}/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /^data: /);
  const state = JSON.parse(chunk.replace(/^data: /, '').trim());
  assert.equal(state.warnings.eventsMissing, true);
  await reader.cancel();
});

test('gh が失敗してもサーバーは落ちず ghError を載せる', async () => {
  const repo = makeRepo([]);
  const dash = createDashboard({ repoRoot: repo, gh: async () => { throw new Error('gh 認証切れ'); } });
  await dash.start();
  const state = dash.getState();
  assert.match(state.warnings.ghError, /gh 認証切れ/);
  dash.stop();
});

// --- 複数プロジェクトモード ---

// project.path で分岐するフェイク gh。map に無いパスは throw する
const fakeGhByPath = (map) => async (args, project) => {
  const entry = map[project.path];
  if (!entry) throw new Error(`gh 失敗: ${project.path}`);
  if (entry instanceof Error) throw entry;
  return JSON.stringify(args[0] === 'issue' ? entry.issues : entry.prs);
};

const loopStart = (ts) => JSON.stringify({ ts, agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } });
const stage = (ts, ticket, s) => JSON.stringify({ ts, agent: 'main', ticket, event: 'stage', stage: s });

test('複数プロジェクト: /api/state が projects でネストした形と横断サマリを返す', async () => {
  const a = makeRepo([loopStart('2026-09-06T10:00:00+09:00'), stage('2026-09-06T10:01:00+09:00', 1, 'implementing')]);
  const b = makeRepo([stage('2026-09-06T10:02:00+09:00', 1, 'verifying')]);
  const gh = fakeGhByPath({
    [a]: { issues: [{ number: 1, title: 'A の 1', state: 'OPEN', labels: [{ name: 'status:in-progress' }], body: '' }], prs: [] },
    [b]: { issues: [{ number: 1, title: 'B の 1', state: 'OPEN', labels: [{ name: 'status:in-progress' }], body: '' }], prs: [] },
  });
  const dash = createDashboard({ projects: [{ name: 'alpha', path: a }, { name: 'beta', path: b }], gh });
  await dash.start();
  await new Promise((resolve) => dash.server.listen(0, resolve));
  const port = dash.server.address().port;
  after(() => dash.stop());

  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.ok(state.generatedAt);
  assert.deepEqual(Object.keys(state).sort(), ['generatedAt', 'projects', 'summary']);
  assert.equal(state.projects.length, 2);
  for (const key of ['name', 'path', 'loop', 'tickets', 'mergedThisLoop', 'log', 'dag', 'warnings']) {
    assert.ok(key in state.projects[0], `projects[0] に ${key} が無い`);
  }
  // 同じ Issue 番号がプロジェクトごとに別カードになり、混ざらない
  const alpha = state.projects.find((p) => p.name === 'alpha');
  const beta = state.projects.find((p) => p.name === 'beta');
  assert.equal(alpha.tickets[0].title, 'A の 1');
  assert.equal(alpha.tickets[0].station, 'implementing');
  assert.equal(beta.tickets[0].title, 'B の 1');
  assert.equal(beta.tickets[0].station, 'verifying');
  assert.equal(state.summary.projectCount, 2);
  assert.equal(state.summary.runningLoops, 1); // alpha だけ loop start がある
});

test('複数プロジェクト (A): 片方の gh が throw しても他方の tickets が揃い、ghError は失敗側だけに載る', async () => {
  const a = makeRepo([]);
  const b = makeRepo([]);
  const gh = fakeGhByPath({
    [a]: { issues: [{ number: 7, title: '生きている方', state: 'OPEN', labels: [{ name: 'status:ready' }], body: '' }], prs: [] },
    [b]: new Error('gh 認証切れ'),
  });
  const dash = createDashboard({ projects: [{ name: 'ok', path: a }, { name: 'ng', path: b }], gh });
  await dash.start();
  await new Promise((resolve) => dash.server.listen(0, resolve));
  const port = dash.server.address().port;
  after(() => dash.stop());

  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  const ok = state.projects.find((p) => p.name === 'ok');
  const ng = state.projects.find((p) => p.name === 'ng');
  assert.equal(ok.tickets.length, 1);
  assert.equal(ok.tickets[0].number, 7);
  assert.equal(ok.warnings.ghError, null);
  assert.match(ng.warnings.ghError, /gh 認証切れ/);
  assert.equal(state.summary.errors, 1);
});

test('複数プロジェクト (B): 片方の path が存在しなくても start() が成功し、その項目だけ eventsMissing と ghError を持つ', async () => {
  const a = makeRepo([loopStart('2026-09-06T10:00:00+09:00')]);
  const missing = path.join(os.tmpdir(), 'devloop-dash-not-exist-' + process.pid);
  const gh = fakeGhByPath({
    [a]: { issues: [], prs: [] },
    [missing]: { issues: [], prs: [] }, // gh が答えられたとしても path 不在は先に検知される
  });
  const dash = createDashboard({ projects: [{ name: 'alive', path: a }, { name: 'gone', path: missing }], gh });
  await dash.start();
  after(() => dash.stop());
  const state = dash.getState();
  const alive = state.projects.find((p) => p.name === 'alive');
  const gone = state.projects.find((p) => p.name === 'gone');
  assert.equal(alive.warnings.eventsMissing, false);
  assert.equal(alive.warnings.ghError, null);
  assert.equal(alive.loop.running, true);
  assert.equal(gone.warnings.eventsMissing, true);
  assert.match(gone.warnings.ghError, /存在しません/);
});

test('複数プロジェクト: 片方の events.jsonl への追記はそのプロジェクトだけを更新する', async () => {
  const a = makeRepo([loopStart('2026-09-06T10:00:00+09:00')]);
  const b = makeRepo([loopStart('2026-09-06T10:00:00+09:00')]);
  const gh = fakeGhByPath({ [a]: { issues: [], prs: [] }, [b]: { issues: [], prs: [] } });
  const dash = createDashboard({ projects: [{ name: 'alpha', path: a }, { name: 'beta', path: b }], gh });
  await dash.start();
  after(() => dash.stop());
  fs.appendFileSync(path.join(a, '.claude/dev-loop/events.jsonl'), stage('2026-09-06T10:05:00+09:00', 3, 'implementing') + '\n');
  dash.refresh(); // watchFile の遅延を待たずに読み直す
  const state = dash.getState();
  const alpha = state.projects.find((p) => p.name === 'alpha');
  const beta = state.projects.find((p) => p.name === 'beta');
  assert.equal(alpha.tickets.length, 1);
  assert.equal(alpha.tickets[0].number, 3);
  assert.equal(beta.tickets.length, 0);
});

test('1 リポジトリモード: 最上位は projects 形だが後方互換で projects[0] の内容も最上位に展開する', async () => {
  const repo = makeRepo([loopStart('2026-09-06T10:00:00+09:00')]);
  const dash = createDashboard({ repoRoot: repo, gh: fakeGh([], []) });
  await dash.start();
  after(() => dash.stop());
  const state = dash.getState();
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].name, path.basename(repo));
  assert.equal(state.repo, path.basename(repo));
  assert.equal(state.loop.running, true);
  assert.equal(state.summary.runningLoops, 1);
});

// --- レビュー指摘の回帰テスト ---

test('複数プロジェクト: 同名のプロジェクトは createDashboard が拒否する（gh 状態が混ざるのを防ぐ）', () => {
  const a = makeRepo([]);
  const b = makeRepo([]);
  assert.throws(
    () => createDashboard({ projects: [{ name: 'api', path: a }, { name: 'api', path: b }], gh: fakeGh([], []) }),
    /プロジェクト名が重複/,
  );
});

test('複数プロジェクト: projects が空配列なら明示的に失敗し、cwd の 1 リポジトリに黙って落ちない', () => {
  assert.throws(() => createDashboard({ projects: [], gh: fakeGh([], []) }), /0 件/);
});

test('複数プロジェクト: /events の SSE も projects でネストした同じ形を送る', async () => {
  const a = makeRepo([loopStart('2026-09-06T10:00:00+09:00')]);
  const b = makeRepo(null);
  const gh = fakeGhByPath({ [a]: { issues: [], prs: [] }, [b]: { issues: [], prs: [] } });
  const dash = createDashboard({ projects: [{ name: 'alpha', path: a }, { name: 'beta', path: b }], gh });
  await dash.start();
  await new Promise((resolve) => dash.server.listen(0, resolve));
  const port = dash.server.address().port;
  after(() => dash.stop());
  const res = await fetch(`http://127.0.0.1:${port}/events`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const state = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '').trim());
  assert.deepEqual(Object.keys(state).sort(), ['generatedAt', 'projects', 'summary']);
  assert.equal(state.projects.find((p) => p.name === 'beta').warnings.eventsMissing, true);
  await reader.cancel();
});

test('複数プロジェクト: 片方の gh が遅くても、他方は完了した時点で先に配信される', async () => {
  const a = makeRepo([]);
  const b = makeRepo([]);
  let releaseB;
  const slow = new Promise((r) => (releaseB = r));
  const gh = async (args, project) => {
    if (project.path === b) await slow;
    return JSON.stringify(args[0] === 'issue' ? [{ number: 1, title: 't', state: 'OPEN', labels: [{ name: 'status:ready' }], body: '' }] : []);
  };
  const dash = createDashboard({ projects: [{ name: 'fast', path: a }, { name: 'slow', path: b }], gh });
  const started = dash.start();
  // fast 側の配信を待つ（refresh は pollOne 完了ごとに走る）
  for (let i = 0; i < 50 && !dash.getState()?.projects.find((p) => p.name === 'fast').tickets.length; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const mid = dash.getState();
  assert.equal(mid.projects.find((p) => p.name === 'fast').tickets.length, 1);
  assert.equal(mid.projects.find((p) => p.name === 'slow').tickets.length, 0);
  releaseB();
  await started;
  after(() => dash.stop());
  assert.equal(dash.getState().projects.find((p) => p.name === 'slow').tickets.length, 1);
});

test('readLedger: 台帳の name 重複・空・path 欠落は例外にする', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devloop-ledger-'));
  const write = (name, obj) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  assert.throws(() => readLedger(write('dup.json', { projects: [{ name: 'x', path: '/a' }, { name: 'x', path: '/b' }] })), /重複/);
  assert.throws(() => readLedger(write('empty.json', { projects: [] })), /空/);
  assert.throws(() => readLedger(write('nopath.json', { projects: [{ name: 'x' }] })), /path/);
  assert.throws(() => readLedger(write('notarray.json', { projects: 'x' })), /projects 配列/);
  const ok = readLedger(write('ok.json', { projects: [{ path: '/tmp/one' }, { name: 'two', path: '/tmp/two' }] }));
  assert.deepEqual(ok, [{ name: 'one', path: '/tmp/one' }, { name: 'two', path: '/tmp/two' }]);
});

test('resolveProjectsFromArgs: --project は台帳より優先し、basename が衝突すれば親ディレクトリで区別し、値の無いフラグは例外', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devloop-args-'));
  const ledger = path.join(dir, 'projects.json');
  fs.writeFileSync(ledger, JSON.stringify({ projects: [{ name: 'from-ledger', path: '/tmp/x' }] }));
  const none = path.join(dir, 'no-such-ledger.json');

  const r1 = resolveProjectsFromArgs(['--project', '/w/api', '--project', '/o/api', '--ledger', ledger], { ledgerDefault: none });
  assert.equal(r1.mode, 'multi');
  assert.deepEqual(r1.projects.map((p) => p.name), ['w/api', 'o/api']);

  const r2 = resolveProjectsFromArgs(['--ledger', ledger], { ledgerDefault: none });
  assert.deepEqual(r2.projects.map((p) => p.name), ['from-ledger']);

  const r3 = resolveProjectsFromArgs([], { ledgerDefault: ledger });
  assert.deepEqual(r3.projects.map((p) => p.name), ['from-ledger']);

  const r4 = resolveProjectsFromArgs([], { ledgerDefault: none });
  assert.deepEqual(r4, { mode: 'single', projects: null });

  assert.throws(() => resolveProjectsFromArgs(['--project'], { ledgerDefault: none }), /値が必要/);
  assert.throws(() => resolveProjectsFromArgs(['--project', '--port', '5000'], { ledgerDefault: none }), /値が必要/);
  assert.throws(() => resolveProjectsFromArgs(['--ledger'], { ledgerDefault: none }), /値が必要/);
});

test('既定台帳は DEV_TEAM_HOME の下、未設定か空なら ~/.claude/dev-team の下', () => {
  assert.equal(defaultLedgerPath({ DEV_TEAM_HOME: '/srv/state' }, '/home/u'), path.join('/srv/state', 'projects.json'));
  assert.equal(defaultLedgerPath({}, '/home/u'), path.join('/home/u', '.claude/dev-team', 'projects.json'));
  assert.equal(defaultLedgerPath({ DEV_TEAM_HOME: '' }, '/home/u'), path.join('/home/u', '.claude/dev-team', 'projects.json'));
});
