import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvents, foldEvents, parseDepends, buildDag, buildState, summarizeProjects } from '../../plugins/dev-team/skills/dev-loop-dashboard/lib/state.mjs';

const line = (obj) => JSON.stringify(obj);

test('parseEvents: 正常行を配列にし、壊れた行は数える', () => {
  const text = [
    line({ ts: '2026-08-14T10:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } }),
    '{ こわれた json',
    line({ ts: '2026-08-14T10:01:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'selected' }),
    '',
  ].join('\n');
  const { events, badLines } = parseEvents(text);
  assert.equal(events.length, 2);
  assert.equal(badLines, 1);
});

test('parseEvents: ts か event が無い行は壊れた行として数える', () => {
  const { events, badLines } = parseEvents(line({ foo: 1 }));
  assert.equal(events.length, 0);
  assert.equal(badLines, 1);
});

test('foldEvents: 工程遷移を畳み込み、チケットごとの最新状態を返す', () => {
  const { events } = parseEvents([
    line({ ts: '2026-08-14T10:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } }),
    line({ ts: '2026-08-14T10:01:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'selected' }),
    line({ ts: '2026-08-14T10:02:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'implementing' }),
    line({ ts: '2026-08-14T10:10:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'pr-created', detail: { pr: 41 } }),
    line({ ts: '2026-08-14T10:11:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'review', detail: { iteration: 1, reviewers: ['code-reviewer', 'pr-test-analyzer', 'silent-failure-hunter'] } }),
  ].join('\n'));
  const s = foldEvents(events);
  assert.equal(s.loop.running, true);
  assert.equal(s.loop.startedTs, '2026-08-14T10:00:00+09:00');
  assert.equal(s.tickets[29].stage, 'review');
  assert.equal(s.tickets[29].agent, 'main');
  assert.equal(s.tickets[29].prNumber, 41);
  assert.equal(s.tickets[29].reviewIteration, 1);
  assert.equal(s.tickets[29].reviewers.length, 3);
});

test('foldEvents: blocked は stage を上書きせずフラグにする（最後の駅に留まる）', () => {
  const { events } = parseEvents([
    line({ ts: '2026-08-14T10:01:00+09:00', agent: 'main', ticket: 10, event: 'stage', stage: 'review', detail: { iteration: 3 } }),
    line({ ts: '2026-08-14T10:05:00+09:00', agent: 'main', ticket: 10, event: 'stage', stage: 'blocked', detail: { reason: 'レビュー3回超過' } }),
  ].join('\n'));
  const t = foldEvents(events).tickets[10];
  assert.equal(t.stage, 'review');
  assert.equal(t.blocked, true);
  assert.equal(t.blockedReason, 'レビュー3回超過');
});

test('foldEvents: 最新の loop start より前のイベントは今回ループに含めない', () => {
  const { events } = parseEvents([
    line({ ts: '2026-08-13T10:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } }),
    line({ ts: '2026-08-13T11:00:00+09:00', agent: 'main', ticket: 8, event: 'stage', stage: 'merged' }),
    line({ ts: '2026-08-14T10:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } }),
    line({ ts: '2026-08-14T11:00:00+09:00', agent: 'main', ticket: 9, event: 'stage', stage: 'merged' }),
  ].join('\n'));
  const s = foldEvents(events);
  assert.deepEqual(s.mergedThisLoop, [9]);
  assert.equal(s.tickets[8], undefined);
});

test('foldEvents: loop end で running が false になる', () => {
  const { events } = parseEvents([
    line({ ts: '2026-08-14T10:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } }),
    line({ ts: '2026-08-14T12:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'end' } }),
  ].join('\n'));
  assert.equal(foldEvents(events).loop.running, false);
});

test('foldEvents: log はイベントを新しい順に積む', () => {
  const { events } = parseEvents([
    line({ ts: '2026-08-14T10:01:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'selected' }),
    line({ ts: '2026-08-14T10:02:00+09:00', agent: 'main', ticket: 29, event: 'log', detail: { text: 'コミット: 型定義を追加' } }),
  ].join('\n'));
  const log = foldEvents(events).log;
  assert.equal(log[0].text, 'コミット: 型定義を追加');
  assert.equal(log[1].ticket, 29);
});

test('parseDepends: 本文から依存 Issue 番号を抽出する', () => {
  assert.deepEqual(parseDepends('## 補足\ndepends: #10, #13'), [10, 13]);
  assert.deepEqual(parseDepends('depends: #15'), [15]);
  assert.deepEqual(parseDepends('依存なしの本文'), []);
  assert.deepEqual(parseDepends(null), []);
});

// DAG 用のチケットを簡便に作るヘルパ
const dagT = (number, { blocked = false, waitingOn = [], dependsOn = [] } = {}) => ({ number, blocked, waitingOn, dependsOn });

test('buildDag: 依存の無いチケットはノードに含めない', () => {
  const dag = buildDag([dagT(1), dagT(2)]);
  assert.deepEqual(dag.nodes, []);
  assert.deepEqual(dag.edges, []);
});

test('buildDag: エッジは依存元 → 依存先チケットの向きで張る', () => {
  const dag = buildDag([dagT(15, { dependsOn: [10], waitingOn: [10] }), dagT(10)]);
  assert.deepEqual(dag.nodes.sort(), [10, 15]);
  assert.deepEqual(dag.edges, [{ from: 10, to: 15 }]);
});

test('buildDag: ボトルネックは「詰まっているノードのうち上流に詰まりが無いもの」', () => {
  // #10 が blocked、#15 は #10 待ち、#16 は #15 待ち → ボトルネックは #10 だけ
  const tickets = [
    dagT(10, { blocked: true }),
    dagT(15, { dependsOn: [10], waitingOn: [10] }),
    dagT(16, { dependsOn: [15], waitingOn: [15] }),
  ];
  assert.deepEqual(buildDag(tickets).bottlenecks, [10]);
});

test('buildDag: 誰も待たせていない blocked はボトルネックにしない', () => {
  const tickets = [dagT(40, { blocked: true, dependsOn: [39], waitingOn: [] }), dagT(39)];
  assert.deepEqual(buildDag(tickets).bottlenecks, []);
});

// buildState 用ヘルパ
const issue = (number, { title = `Issue ${number}`, state = 'OPEN', labels = [], body = '' } = {}) => ({ number, title, state, labels, body });
const fold = (text) => foldEvents(parseEvents(text).events);
const emptyFold = () => fold('');

test('buildState: ラベルから駅を決める（イベント無しの劣化モード）', () => {
  const gh = {
    issues: [
      issue(39, { labels: ['status:ready'] }),
      issue(29, { labels: ['status:in-progress', 'priority:high'] }),
      issue(3, { state: 'CLOSED' }),
    ],
    prs: [],
  };
  const s = buildState(emptyFold(), gh, { eventsMissing: true });
  const t39 = s.tickets.find((t) => t.number === 39);
  const t29 = s.tickets.find((t) => t.number === 29);
  assert.equal(t39.station, 'waiting');
  assert.equal(t29.station, 'implementing'); // 細部不明なので実装駅に置く
  assert.equal(t29.priority, true);
  assert.equal(s.tickets.find((t) => t.number === 3), undefined); // 過去の closed は出さない
  assert.equal(s.warnings.eventsMissing, true);
});

test('buildState: イベントがあれば細かい駅とエージェントを載せる', () => {
  const gh = { issues: [issue(29, { labels: ['status:in-progress'] })], prs: [] };
  const folded = fold(
    [
      JSON.stringify({ ts: '2026-08-14T10:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } }),
      JSON.stringify({ ts: '2026-08-14T10:05:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'review', detail: { iteration: 2, reviewers: ['code-reviewer'] } }),
    ].join('\n'),
  );
  const t = buildState(folded, gh, {}).tickets.find((x) => x.number === 29);
  assert.equal(t.station, 'review');
  assert.equal(t.agent, 'main');
  assert.equal(t.reviewIteration, 2);
});

test('buildState: イベントが merged でも Issue が open なら GitHub に倒しドリフト警告', () => {
  const gh = { issues: [issue(29, { labels: ['status:in-progress'] })], prs: [] };
  const folded = fold(JSON.stringify({ ts: '2026-08-14T10:05:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'merged' }));
  const s = buildState(folded, gh, {});
  const t = s.tickets.find((x) => x.number === 29);
  assert.notEqual(t.station, 'merged');
  assert.equal(t.drift, true);
  assert.equal(s.warnings.drift.length, 1);
});

test('buildState: 今回ループでマージ済みのチケットは closed でも merged 駅に出す', () => {
  const gh = { issues: [issue(9, { state: 'CLOSED' })], prs: [] };
  const folded = fold(
    [
      JSON.stringify({ ts: '2026-08-14T10:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } }),
      JSON.stringify({ ts: '2026-08-14T10:30:00+09:00', agent: 'main', ticket: 9, event: 'stage', stage: 'merged' }),
    ].join('\n'),
  );
  const s = buildState(folded, gh, {});
  assert.equal(s.tickets.find((t) => t.number === 9).station, 'merged');
  assert.deepEqual(s.mergedThisLoop, [9]);
});

test('buildState: 依存が open のチケットは waitingOn に依存先を持つ', () => {
  const gh = {
    issues: [issue(15, { labels: ['status:ready'], body: 'depends: #10' }), issue(10, { labels: ['status:in-progress'] })],
    prs: [],
  };
  const t = buildState(emptyFold(), gh, {}).tickets.find((x) => x.number === 15);
  assert.deepEqual(t.waitingOn, [10]);
});

test('buildState: gh が無い場合はイベントだけで組み立てる', () => {
  const folded = fold(JSON.stringify({ ts: '2026-08-14T10:05:00+09:00', agent: 'ticket-10', ticket: 10, event: 'stage', stage: 'verifying' }));
  const s = buildState(folded, null, { ghError: 'gh: コマンド失敗' });
  assert.equal(s.tickets.find((t) => t.number === 10).station, 'verifying');
  assert.equal(s.warnings.ghError, 'gh: コマンド失敗');
});

test('buildState: ready ラベルなのにイベントが実装中を示すならドリフト警告', () => {
  const gh = { issues: [issue(50, { labels: ['status:ready'] })], prs: [] };
  const folded = fold(JSON.stringify({ ts: '2026-08-14T10:05:00+09:00', agent: 'main', ticket: 50, event: 'stage', stage: 'implementing' }));
  const s = buildState(folded, gh, {});
  const t = s.tickets.find((x) => x.number === 50);
  assert.equal(t.station, 'waiting');
  assert.equal(t.drift, true);
  assert.equal(s.warnings.drift.length, 1);
});

test('buildState: gh が無い場合に merged イベントは誤ドリフトにせず merged 駅に出す', () => {
  const folded = fold(
    [
      JSON.stringify({ ts: '2026-08-14T10:00:00+09:00', agent: 'main', ticket: null, event: 'loop', detail: { action: 'start' } }),
      JSON.stringify({ ts: '2026-08-14T10:05:00+09:00', agent: 'main', ticket: 29, event: 'stage', stage: 'merged' }),
    ].join('\n'),
  );
  const s = buildState(folded, null, {});
  const t = s.tickets.find((x) => x.number === 29);
  assert.equal(t.station, 'merged');
  assert.equal(s.warnings.drift.length, 0);
  assert.deepEqual(s.mergedThisLoop, [29]);
});

test('buildState: PR 番号はイベントに無ければブランチ名 ticket/<N>- から補完する', () => {
  const gh = {
    issues: [issue(10, { labels: ['status:in-progress'] })],
    prs: [{ number: 33, state: 'OPEN', headRefName: 'ticket/10-keymap' }],
  };
  const t = buildState(emptyFold(), gh, {}).tickets.find((x) => x.number === 10);
  assert.equal(t.prNumber, 33);
});

test('summarizeProjects: 稼働ループ数・blocked 合計・ドリフト合計・エラーのプロジェクト数を横断集計する', () => {
  const proj = (name, over = {}) => ({
    name,
    path: `/tmp/${name}`,
    loop: { running: false, startedTs: null },
    tickets: [],
    mergedThisLoop: [],
    log: [],
    dag: { nodes: [], edges: [], bottlenecks: [] },
    warnings: { badLines: 0, eventsMissing: false, ghError: null, ghFetchedAt: null, drift: [] },
    ...over,
  });
  const projects = [
    proj('a', {
      loop: { running: true, startedTs: '2026-09-06T10:00:00+09:00' },
      tickets: [{ number: 1, blocked: true }, { number: 2, blocked: false }],
      warnings: { badLines: 0, eventsMissing: false, ghError: null, ghFetchedAt: null, drift: [{ ticket: 2, msg: 'x' }] },
    }),
    proj('b', {
      tickets: [{ number: 1, blocked: true }],
      warnings: { badLines: 0, eventsMissing: false, ghError: 'gh 認証切れ', ghFetchedAt: null, drift: [] },
    }),
    proj('c', {
      warnings: { badLines: 0, eventsMissing: true, ghError: null, ghFetchedAt: null, drift: [{ ticket: 5, msg: 'y' }, { ticket: 6, msg: 'z' }] },
    }),
  ];
  const sum = summarizeProjects(projects);
  assert.equal(sum.projectCount, 3);
  assert.equal(sum.runningLoops, 1);
  assert.equal(sum.blocked, 2); // a の #1 と b の #1。番号が同じでも別プロジェクトなので別カウント
  assert.equal(sum.drift, 3);
  assert.equal(sum.errors, 2); // b は ghError、c は eventsMissing
});

test('summarizeProjects: 空配列ならすべて 0', () => {
  assert.deepEqual(summarizeProjects([]), { projectCount: 0, runningLoops: 0, blocked: 0, drift: 0, errors: 0 });
});
