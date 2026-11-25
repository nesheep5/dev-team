// dev-loop ダッシュボードの状態算出。純粋関数のみで I/O を持たない。
// 用語: stage = イベントが報告する細かい工程、station = UI 上の駅（5列）

export const STAGE_TO_STATION = {
  selected: 'implementing',
  implementing: 'implementing',
  verifying: 'verifying',
  'pr-created': 'review',
  review: 'review',
  fixing: 'review',
  merging: 'review',
  merged: 'merged',
  skipped: 'waiting',
};

const STAGE_LABEL = {
  selected: '着手',
  implementing: '実装開始',
  verifying: '検証',
  'pr-created': 'PR 作成',
  review: 'レビュー',
  fixing: '指摘修正',
  merging: 'マージ処理',
  merged: 'マージ完了',
  blocked: 'blocked',
  skipped: 'スキップ',
};

export function parseEvents(text) {
  const events = [];
  let badLines = 0;
  for (const raw of (text ?? '').split('\n')) {
    const lineText = raw.trim();
    if (!lineText) continue;
    try {
      const e = JSON.parse(lineText);
      if (typeof e.ts !== 'string' || typeof e.event !== 'string') throw new Error('必須フィールド欠落');
      events.push(e);
    } catch {
      badLines += 1;
    }
  }
  return { events, badLines };
}

function logText(e) {
  if (e.event === 'log') return e.detail?.text ?? '';
  if (e.event === 'stage') {
    let s = STAGE_LABEL[e.stage] ?? e.stage;
    if (e.stage === 'review' && e.detail?.iteration) s += ` 反復${e.detail.iteration}`;
    if (e.stage === 'pr-created' && e.detail?.pr) s += ` #${e.detail.pr}`;
    if ((e.stage === 'blocked' || e.stage === 'skipped') && e.detail?.reason) s += `（${e.detail.reason}）`;
    return s;
  }
  return e.event;
}

export function foldEvents(events) {
  // 最新の loop start を区切りに「今回ループ」だけを畳み込む
  let startIdx = -1;
  events.forEach((e, i) => {
    if (e.event === 'loop' && e.detail?.action === 'start') startIdx = i;
  });
  const current = startIdx >= 0 ? events.slice(startIdx) : events;

  const state = {
    loop: { running: startIdx >= 0, startedTs: startIdx >= 0 ? events[startIdx].ts : null },
    tickets: {},
    mergedThisLoop: [],
    log: [],
  };

  for (const e of current) {
    if (e.event === 'loop') {
      if (e.detail?.action === 'end') state.loop.running = false;
      continue;
    }
    if (e.ticket == null) continue;
    const t = (state.tickets[e.ticket] ??= {
      stage: null,
      agent: null,
      blocked: false,
      blockedReason: null,
      prNumber: null,
      reviewIteration: null,
      reviewers: [],
      lastTs: null,
    });
    if (e.agent) t.agent = e.agent;
    t.lastTs = e.ts;
    if (e.event === 'stage') {
      if (e.stage === 'blocked') {
        // blocked は駅を動かさない（最後にいた駅で止まった表現にする）
        t.blocked = true;
        t.blockedReason = e.detail?.reason ?? null;
      } else {
        t.blocked = false;
        t.stage = e.stage;
        if (e.stage === 'pr-created' && e.detail?.pr) t.prNumber = e.detail.pr;
        if (e.stage === 'review') {
          if (e.detail?.iteration) t.reviewIteration = e.detail.iteration;
          if (e.detail?.reviewers) t.reviewers = e.detail.reviewers;
        }
        if (e.stage === 'merged') state.mergedThisLoop.push(e.ticket);
      }
    }
    state.log.push({ ts: e.ts, ticket: e.ticket, agent: e.agent ?? null, text: logText(e) });
  }
  state.log.reverse();
  state.log = state.log.slice(0, 100);
  return state;
}

export function parseDepends(body) {
  const m = /depends:\s*((?:#\d+[,\s]*)+)/i.exec(body ?? '');
  if (!m) return [];
  return [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
}

export function buildDag(tickets) {
  const byNum = new Map(tickets.map((t) => [t.number, t]));
  const edges = [];
  for (const t of tickets) {
    for (const dep of t.dependsOn ?? []) {
      if (byNum.has(dep)) edges.push({ from: dep, to: t.number });
    }
  }
  const nodeSet = new Set(edges.flatMap((e) => [e.from, e.to]));
  // 詰まっている = blocked または依存待ち
  const stuck = new Set(
    [...nodeSet].filter((n) => {
      const t = byNum.get(n);
      return t.blocked || (t.waitingOn ?? []).length > 0;
    }),
  );
  // ボトルネック = 詰まっているノードのうち、上流に詰まりが無く、下流の詰まりを生んでいるもの
  const bottlenecks = [...stuck].filter((n) => {
    const t = byNum.get(n);
    const upstreamStuck = (t.waitingOn ?? []).some((d) => stuck.has(d));
    const blocksSomeone = edges.some((e) => e.from === n && stuck.has(e.to));
    return !upstreamStuck && blocksSomeone;
  });
  return { nodes: [...nodeSet], edges, bottlenecks };
}

function prFromBranch(prs, num) {
  const pr = (prs ?? []).find((p) => p.headRefName?.startsWith(`ticket/${num}-`));
  return pr ? pr.number : null;
}

function markDrift(warnings, t, msg) {
  t.drift = true;
  warnings.drift.push({ ticket: t.number, msg });
}

export function buildState(folded, gh, opts = {}) {
  const warnings = {
    badLines: opts.badLines ?? 0,
    eventsMissing: opts.eventsMissing ?? false,
    ghError: opts.ghError ?? null,
    ghFetchedAt: opts.ghFetchedAt ?? null,
    drift: [],
  };
  const issues = gh?.issues ?? [];
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  // 表示対象 = status ラベル付き Issue ∪ 今回ループのイベントに現れたチケット
  const nums = new Set([
    ...issues.filter((i) => i.labels.some((l) => l.startsWith('status:'))).map((i) => i.number),
    ...Object.keys(folded.tickets).map(Number),
    ...folded.mergedThisLoop,
  ]);

  const tickets = [];
  for (const num of [...nums].sort((a, b) => a - b)) {
    const issue = byNumber.get(num);
    const ev = folded.tickets[num];
    const labels = issue?.labels ?? [];
    const t = {
      number: num,
      title: issue?.title ?? '',
      agent: ev?.agent ?? null,
      priority: labels.includes('priority:high'),
      blocked: labels.includes('status:blocked') || (ev?.blocked ?? false),
      blockedReason: ev?.blockedReason ?? null,
      prNumber: ev?.prNumber ?? prFromBranch(gh?.prs, num),
      reviewIteration: ev?.reviewIteration ?? null,
      reviewers: ev?.reviewers ?? [],
      dependsOn: parseDepends(issue?.body),
      waitingOn: [],
      station: null,
      drift: false,
    };
    t.waitingOn = t.dependsOn.filter((d) => (byNumber.get(d)?.state ?? 'CLOSED') !== 'CLOSED');
    // 駅の決定。粗い真実（open/closed・ラベル）は GitHub、細部はイベント
    const evStation = ev ? (STAGE_TO_STATION[ev.stage] ?? null) : null;
    if (issue?.state === 'CLOSED') {
      if (!folded.mergedThisLoop.includes(num)) continue; // 過去の完了分は表示しない
      t.station = 'merged';
    } else if (gh != null && ev?.stage === 'merged') {
      t.station = evStation && evStation !== 'merged' ? evStation : 'review';
      markDrift(warnings, t, `イベントは merged だが Issue #${num} は open`);
    } else if (labels.includes('status:ready') && !ev) {
      t.station = 'waiting';
    } else if (labels.includes('status:ready') && evStation && evStation !== 'waiting') {
      t.station = 'waiting';
      markDrift(warnings, t, `イベントは ${ev.stage} だが Issue #${num} のラベルは ready`);
    } else {
      t.station = evStation ?? (labels.includes('status:ready') ? 'waiting' : 'implementing');
    }
    tickets.push(t);
  }

  return {
    loop: folded.loop,
    tickets,
    mergedThisLoop: folded.mergedThisLoop,
    log: folded.log,
    dag: buildDag(tickets),
    warnings,
  };
}

// 複数プロジェクトの横断集計。引数は buildState() の出力に name / path を添えた配列
export function summarizeProjects(projects) {
  const sum = { projectCount: 0, runningLoops: 0, blocked: 0, drift: 0, errors: 0 };
  for (const p of projects ?? []) {
    sum.projectCount += 1;
    if (p.loop?.running) sum.runningLoops += 1;
    sum.blocked += (p.tickets ?? []).filter((t) => t.blocked).length;
    sum.drift += (p.warnings?.drift ?? []).length;
    if (p.warnings?.ghError || p.warnings?.eventsMissing) sum.errors += 1;
  }
  return sum;
}
