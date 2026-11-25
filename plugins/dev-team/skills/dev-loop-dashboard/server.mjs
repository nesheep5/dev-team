#!/usr/bin/env node
// dev-loop ダッシュボードサーバー。依存ゼロ（Node 標準ライブラリのみ）。
// 使い方: `node <このファイル> [--ledger <path>] [--project <path>]... [--port N] [--open] [--demo]`
//   引数なし: 既定台帳 <状態ディレクトリ>/projects.json があれば全プロジェクト、無ければ cwd の 1 リポジトリ
//   状態ディレクトリは環境変数 DEV_TEAM_HOME、未設定なら ~/.claude/dev-team
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEvents, foldEvents, buildState, summarizeProjects } from './lib/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4649;
const GH_POLL_MS = 30_000;
const GH_TIMEOUT_MS = 20_000; // 1 つの gh のハングを他プロジェクトに波及させない上限
const HEARTBEAT_MS = 30_000;

// 既定台帳のパス。状態ディレクトリは manager と共有する（DEV_TEAM_HOME、未設定なら ~/.claude/dev-team）
export function defaultLedgerPath(env = process.env, home = os.homedir()) {
  const stateDir = env.DEV_TEAM_HOME || path.join(home, '.claude/dev-team');
  return path.join(stateDir, 'projects.json');
}

function runGh(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: GH_TIMEOUT_MS }, (err, stdout) =>
      err ? reject(err.killed ? new Error(`gh が ${GH_TIMEOUT_MS / 1000} 秒以内に応答しませんでした`) : err) : resolve(stdout),
    );
  });
}

// name は gh 状態のキー・UI の駅間移動キー・デモのパスに使うため、重複を許さない
export function assertUniqueNames(projects) {
  const seen = new Set();
  for (const p of projects) {
    if (!p.name) throw new Error('プロジェクト名が空です');
    if (seen.has(p.name)) throw new Error(`プロジェクト名が重複しています: ${p.name}（名前を台帳で分けるか、--project の代わりに --ledger を使ってください）`);
    seen.add(p.name);
  }
  return projects;
}

// events.jsonl の置き場はここだけで決める（.claude/dev-team/ へ移行するときはこの関数だけ変える）
function eventsPathFor(project, demo) {
  return demo
    ? path.join(HERE, 'demo', project.name, 'events.jsonl')
    : path.join(project.path, '.claude/dev-loop/events.jsonl');
}

// デモ用の gh フェイク: demo/<name>/gh.json を返す
function demoGh(args, project) {
  const snap = JSON.parse(fs.readFileSync(path.join(HERE, 'demo', project.name, 'gh.json'), 'utf8'));
  return Promise.resolve(JSON.stringify(args[0] === 'issue' ? snap.issues : snap.prs));
}

// demo/ 直下のディレクトリを台帳に見立てる
export function demoProjects() {
  return fs
    .readdirSync(path.join(HERE, 'demo'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, path: path.join(HERE, 'demo', d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createDashboard(opts = {}) {
  const demo = opts.demo ?? false;
  // 1 リポジトリモード（従来の呼び出し）は projects 1 件に包む
  let projects;
  if (Array.isArray(opts.projects) && opts.projects.length === 0) {
    throw new Error('プロジェクトが 0 件です（台帳が空か、--project の指定がありません）');
  }
  if (opts.projects?.length) {
    projects = opts.projects.map((p) => ({ name: p.name, path: p.path }));
  } else if (demo) {
    projects = demoProjects();
  } else {
    const repoRoot = opts.repoRoot ?? process.cwd();
    projects = [{ name: path.basename(repoRoot), path: repoRoot }];
  }
  assertUniqueNames(projects);
  const single = !opts.projects?.length && !demo;
  const gh = opts.gh ?? (demo ? demoGh : (args, project) => runGh(args, project.path));

  // プロジェクトごとの gh の状態（名前がキー）
  const ghState = new Map(projects.map((p) => [p.name, { snapshot: null, error: null, fetchedAt: null }]));
  let state = null;
  const clients = new Set();
  const timers = [];
  const watched = [];

  function buildProject(project) {
    const eventsPath = eventsPathFor(project, demo);
    let text = null;
    try {
      text = fs.readFileSync(eventsPath, 'utf8');
    } catch {
      // ファイルが無ければ GitHub のみの劣化表示にする
    }
    const parsed = parseEvents(text ?? '');
    const g = ghState.get(project.name);
    const built = buildState(foldEvents(parsed.events), g.snapshot, {
      badLines: parsed.badLines,
      eventsMissing: text === null,
      ghError: g.error,
      ghFetchedAt: g.fetchedAt,
    });
    return { name: project.name, path: project.path, ...built };
  }

  function refresh() {
    const built = projects.map(buildProject);
    state = { generatedAt: new Date().toISOString(), summary: summarizeProjects(built), projects: built };
    if (single) {
      // 後方互換: 1 リポジトリモードでは projects[0] の内容を最上位にも展開する
      const { name, path: _p, ...rest } = built[0];
      Object.assign(state, rest, { repo: name });
    }
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  async function pollOne(project) {
    const g = ghState.get(project.name);
    if (!demo && !fs.existsSync(project.path)) {
      g.error = `パス ${project.path} が存在しません`;
      return;
    }
    try {
      const rawIssues = JSON.parse(
        await gh(['issue', 'list', '--json', 'number,title,state,labels,body', '--state', 'all', '--limit', '200'], project),
      );
      const prs = JSON.parse(
        await gh(['pr', 'list', '--json', 'number,state,headRefName', '--state', 'all', '--limit', '200'], project),
      );
      g.snapshot = {
        issues: rawIssues.map((i) => ({ ...i, labels: i.labels.map((l) => l.name) })),
        prs,
      };
      g.error = null;
      g.fetchedAt = new Date().toISOString();
    } catch (e) {
      g.error = String(e?.message ?? e); // 最後に取れたスナップショットは保持し続ける
    }
  }

  let polling = false;
  async function pollGh() {
    if (polling) return; // 前回のポーリングが gh の遅延で終わっていなければ重ねない（古いスナップショットが後勝ちするのを防ぐ）
    polling = true;
    try {
      // 1 プロジェクトの失敗・遅延を他に波及させない: 終わったプロジェクトから順に配信し、全体の完了を待たない
      const results = await Promise.allSettled(projects.map((p) => pollOne(p).then(refresh)));
      for (const r of results) {
        if (r.status === 'rejected') console.error(`警告: ポーリング中に予期しないエラー: ${r.reason?.stack ?? r.reason}`);
      }
    } finally {
      polling = false;
    }
    refresh();
  }

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/') {
      try {
        const html = fs.readFileSync(path.join(HERE, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        // index.html が無い場合や読み込み失敗時は 500 で応答し、プロセスは生存
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end('index.html を読み込めません');
      }
    } else if (url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state));
    } else if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      clients.add(res);
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      req.on('close', () => clients.delete(res));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });

  async function start() {
    await pollGh(); // 初回は同期的に取ってから listen 側で使えるようにする
    for (const p of projects) {
      const ep = eventsPathFor(p, demo);
      fs.watchFile(ep, { interval: 1000 }, refresh);
      watched.push(ep);
    }
    timers.push(setInterval(pollGh, GH_POLL_MS));
    timers.push(
      setInterval(() => {
        for (const res of clients) res.write(': heartbeat\n\n');
      }, HEARTBEAT_MS),
    );
  }

  function stop() {
    timers.forEach(clearInterval);
    watched.forEach((ep) => fs.unwatchFile(ep));
    for (const res of clients) res.end();
    server.close();
  }

  return { server, start, stop, refresh, getState: () => state, projects };
}

// 空きポートを探しながら listen する（--port 指定時はフォールバックしない）
function listenWithFallback(server, port, fixed) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, remaining) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && !fixed && remaining > 0) tryPort(p + 1, remaining - 1);
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    tryPort(port, 20);
  });
}

// 台帳 JSON を読んで [{name, path}] にする。壊れていれば例外
export function readLedger(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw?.projects) ? raw.projects : null;
  if (!list) throw new Error(`台帳 ${file} に projects 配列がありません`);
  if (list.length === 0) throw new Error(`台帳 ${file} の projects が空です`);
  return assertUniqueNames(
    list.map((p) => {
      if (typeof p?.path !== 'string' || !p.path) throw new Error(`台帳 ${file} に path の無い項目があります`);
      return { name: p.name || path.basename(p.path), path: p.path };
    }),
  );
}

// CLI 引数から起動モードを決める。台帳ファイルに触るのはここだけ（createDashboard とテストは触らない）
export function resolveProjectsFromArgs(args, { ledgerDefault = defaultLedgerPath() } = {}) {
  const projectPaths = [];
  let ledger = null;
  const takeValue = (flag, i) => {
    const v = args[i + 1];
    if (v == null || v.startsWith('--')) throw new Error(`${flag} には値が必要です`);
    return v;
  };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--project') projectPaths.push(path.resolve(takeValue('--project', i++)));
    else if (args[i] === '--ledger') ledger = takeValue('--ledger', i++);
  }
  if (projectPaths.length) {
    // --project は台帳より優先。台帳なしでも動く。名前は basename、衝突したら親ディレクトリを添える
    const counts = new Map();
    for (const p of projectPaths) counts.set(path.basename(p), (counts.get(path.basename(p)) ?? 0) + 1);
    const projects = projectPaths.map((p) => {
      const base = path.basename(p);
      const name = counts.get(base) > 1 ? `${path.basename(path.dirname(p))}/${base}` : base;
      return { name, path: p };
    });
    return { mode: 'multi', projects: assertUniqueNames(projects) };
  }
  if (ledger) return { mode: 'multi', projects: readLedger(ledger) };
  if (fs.existsSync(ledgerDefault)) return { mode: 'multi', projects: readLedger(ledgerDefault) };
  return { mode: 'single', projects: null };
}

const isMain = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const openBrowser = args.includes('--open');
  const portIdx = args.indexOf('--port');
  let fixedPort = null;
  if (portIdx >= 0) {
    const raw = args[portIdx + 1];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      console.error(`エラー: --port の値が不正です（${raw ?? '未指定'}）。1〜65535 の整数で指定してください。`);
      process.exit(1);
    }
    fixedPort = n;
  }

  let resolved = { mode: 'single', projects: null };
  if (!demo) {
    try {
      resolved = resolveProjectsFromArgs(args);
    } catch (e) {
      console.error(`エラー: ${e.message}`);
      process.exit(1);
    }
    if (resolved.mode === 'single') {
      // 1 リポジトリモードだけは gh が使えなければ起動しない（複数モードは該当プロジェクトのエラー表示に降格）
      try {
        await runGh(['repo', 'view', '--json', 'name'], process.cwd());
      } catch {
        console.error('エラー: gh でリポジトリを参照できません。GitHub リポジトリのルートで、gh 認証済みの状態で起動してください。');
        process.exit(1);
      }
    }
  }

  let dash;
  try {
    dash = createDashboard({ demo, projects: resolved.projects ?? undefined });
  } catch (e) {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  }
  await dash.start();
  const port = await listenWithFallback(dash.server, fixedPort ?? DEFAULT_PORT, fixedPort != null);
  const url = `http://localhost:${port}/`;
  const names = dash.projects.map((p) => p.name).join(', ');
  console.log(`dev-loop dashboard: ${url}${demo ? '（デモモード）' : ''}（PID: ${process.pid}）`);
  console.log(`プロジェクト: ${names}`);
  for (const p of dash.getState().projects) {
    if (p.warnings.ghError) console.error(`警告: ${p.name}: ${p.warnings.ghError}`);
  }
  if (openBrowser) {
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
}
