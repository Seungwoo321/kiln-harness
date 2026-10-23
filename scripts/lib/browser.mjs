// CDP와 루프백 서버. 프로필·포트는 증거에 포함하지 않는다.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve, relative, extname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { sha256 } from '../register.mjs';

export function findChrome(env = process.env) {
  if (env.KH_CHROME !== undefined) return existsSync(env.KH_CHROME) ? env.KH_CHROME : null;
  const paths = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : []), ...(env.PROGRAMFILES ? [join(env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')] : [])];
  for (const p of paths) if (existsSync(p)) return p;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch { /* 다음 위치 */ }
  }
  return null;
}

const inside = (root, file) => { const r = relative(root, file); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg' };
export async function serve(root) {
  root = realpathSync(root);
  const assets = new Map();
  const server = createServer((req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.split('/').some(p => p.startsWith('.'))) { res.writeHead(403).end(); return; }
      let file = resolve(root, `.${pathname}`);
      if (!inside(root, file)) { res.writeHead(403).end(); return; }
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      file = realpathSync(file);
      if (!inside(root, file)) { res.writeHead(403).end(); return; }
      const body = readFileSync(file);
      assets.set(relative(root, file).split('\\').join('/'), sha256(body));
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  return { url: `http://127.0.0.1:${server.address().port}`, assets, close: () => new Promise((yes) => { server.close(yes); server.closeAllConnections(); }) };
}

// 큰 레포를 복사하지 않고 요청한 자산만 등록 커밋에서 읽는다.
export async function serveGit(repo, commit) {
  if (!/^[a-f\d]{40,64}$/.test(commit)) throw new Error('정적 서버에는 고정 커밋이 필요함');
  const assets = new Map();
  const server = createServer((req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
      if (!path || path.endsWith('/')) path += 'index.html';
      if (path.includes('\0') || path.includes('\\') || path.split('/').some(p => p.startsWith('.'))) { res.writeHead(403).end(); return; }
      const body = execFileSync('git', ['-C', repo, 'show', `${commit}:${path}`], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      assets.set(path, sha256(body));
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  return { url: `http://127.0.0.1:${server.address().port}`, assets, close: () => new Promise(yes => { server.close(yes); server.closeAllConnections(); }) };
}

const delay = (ms) => new Promise((yes) => setTimeout(yes, ms));
export async function launchBrowser(chrome, scratch = tmpdir(), cleanup = () => {}) {
  const profile = mkdtempSync(join(scratch, 'chrome-'));
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-dev-shm-usage', '--lang=en-US', '--force-device-scale-factor=1', '--no-proxy-server', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; let spawnError;
  child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-4000); });
  child.on('error', (e) => { spawnError = e; });
  let ws; let seq = 0;
  const pending = new Map();
  const rejectAll = (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.no(new Error(`${p.method}: ${error.message}`)); } pending.clear(); };
  let closing;
  const close = () => closing ??= (async () => {
    process.removeListener('SIGTERM', terminated); process.removeListener('SIGINT', interrupted); process.removeListener('exit', exited);
    ws?.close(); rejectAll(new Error('Chrome 종료'));
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      const stopped = new Promise(yes => child.once('exit', yes));
      child.kill('SIGTERM');
      await Promise.race([stopped, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await stopped; }
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  })();
  const exited = () => { child.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); cleanup(); };
  const stop = async (code) => { try { await close(); } finally { cleanup(); process.exit(code); } };
  const terminated = () => { void stop(143); }; const interrupted = () => { void stop(130); };
  process.once('SIGTERM', terminated); process.once('SIGINT', interrupted); process.once('exit', exited);
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let n = 0; !existsSync(portFile); n++) {
      if (spawnError || child.exitCode !== null || n >= 200) throw new Error(`Chrome 시작 실패: ${spawnError?.message ?? stderr}`);
      await delay(50);
    }
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const base = `http://127.0.0.1:${port}`;
    const targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
    const target = targets.find((x) => x.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw new Error('Chrome CDP page target가 없음');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((yes, no) => { ws.addEventListener('open', yes, { once: true }); ws.addEventListener('error', no, { once: true }); });
    const events = new Map();
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id) {
        const p = pending.get(msg.id); if (!p) return;
        clearTimeout(p.timer); pending.delete(msg.id);
        if (msg.error) p.no(new Error(`${p.method}: ${msg.error.message}`)); else p.yes(msg.result);
      } else for (const f of events.get(msg.method) ?? []) f(msg.params);
    });
    ws.addEventListener('close', (event) => rejectAll(new Error(`CDP 연결 종료 (code=${event.code}, reason=${event.reason}, exit=${child.exitCode}, signal=${child.signalCode}): ${stderr}`)));
    const send = (method, params = {}) => new Promise((yes, no) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); no(new Error(`${method}: timeout (30s)`)); }, 30000);
      pending.set(id, { yes, no, timer, method }); ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`렌더 스크립트: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    await send('Page.enable'); await send('Network.enable');
    const version = (await send('Browser.getVersion')).product;
    return { send, evaluate, version, on: (name, f) => { const list = events.get(name) ?? []; list.push(f); events.set(name, list); return () => events.set(name, list.filter((x) => x !== f)); }, close };
  } catch (e) { await close(); throw e; }
}

export async function navigate(browser, url, { theme = null, width = 1440, height = 1000, localAssets = null } = {}) {
  if (!/^https?:\/\//.test(url)) throw new Error('렌더 URL은 http 또는 https여야 함');
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme ?? 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  const assets = new Map(); const failures = []; const requests = new Map();
  const offRequest = browser.on('Network.requestWillBeSent', ({ requestId, request }) => requests.set(requestId, request.url));
  const offFailed = browser.on('Network.loadingFailed', ({ requestId, canceled, errorText }) => {
    const failedUrl = requests.get(requestId) ?? requestId;
    if (!canceled && !failedUrl.endsWith('/favicon.ico')) failures.push(`${errorText} ${failedUrl}`);
  });
  const off = browser.on('Network.responseReceived', ({ requestId, response, type }) => {
    if (response.url.endsWith('/favicon.ico')) return;
    if (response.status >= 400) failures.push(`${response.status} ${response.url}`);
    if (['Document', 'Stylesheet', 'Script', 'Font', 'Image'].includes(type)) assets.set(requestId, { url: response.url, type, etag: response.headers.etag ?? response.headers.ETag ?? null });
  });
  try {
    const nav = await browser.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`렌더 탐색 실패: ${nav.errorText}`);
    for (let n = 0; n < 200; n++) {
      if (await browser.evaluate('document.readyState === "complete"')) break;
      if (n === 199) throw new Error('렌더 로드 timeout (10s)');
      await delay(50);
    }
    // SPA는 문서 load 뒤에 첫 DOM을 만들 수 있다. 빈 화면은 관찰값으로 남긴다.
    let contentReady = false;
    for (let n = 0; n < 100; n++) {
      contentReady = await browser.evaluate(`Boolean(document.body?.innerText.trim() || [...document.querySelectorAll('input,textarea,select,img,svg,canvas')].some(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0))`);
      if (contentReady) break;
      await delay(50);
    }
    await browser.evaluate(`(async () => { await document.fonts.ready; const images=[...document.images].filter(i=>i.getBoundingClientRect().width>0 && i.getBoundingClientRect().height>0 && getComputedStyle(i).visibility!=='hidden'); images.forEach(i=>i.loading='eager'); await Promise.all(images.map(i => i.decode().catch(() => {}))); const s=document.createElement('style'); s.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}'; document.head.append(s); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
    if (failures.length) throw new Error(`렌더 자산 로드 실패: ${failures.join(', ')}`);
    const origin = new URL(url).origin;
    // 큰 개발용 JS 응답을 CDP 프레임으로 복제하지 않는다. 자체 서버는 실제 서빙 바이트,
    // 라이브 자산은 HTTP 스트림으로 해시한다. ETag가 바뀌면 측정 중 입력 변경이다.
    const resources = await Promise.all([...assets.values()].filter(r => /^https?:/.test(r.url)).map(async resource => {
      const path = resource.url.startsWith(`${origin}/`) ? resource.url.slice(origin.length) : resource.url;
      const servedDigest = localAssets?.get(decodeURIComponent(new URL(resource.url).pathname).replace(/^\//, ''));
      if (servedDigest) return { path, digest: servedDigest };
      const response = await fetch(resource.url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`자산 해시 실패: ${response.status} ${resource.url}`);
      if (resource.etag && response.headers.get('etag') !== resource.etag) throw new Error(`측정 중 자산 변경: ${resource.url}`);
      const hash = createHash('sha256'); for await (const chunk of response.body) hash.update(chunk);
      return { path, digest: hash.digest('hex') };
    }));
    return { viewport: { width, height }, scale: 1, locale: 'en-US', theme, browser: browser.version, contentReady, assets: resources.sort((a, b) => a.path.localeCompare(b.path)) };
  } finally { off(); offRequest(); offFailed(); }
}
