// Google Antigravity CLI (`agy`): lets players use their Google account or
// Google AI Pro / Ultra subscription. Finds it on this PC, checks the sign-in,
// helps install it and sign in, and runs it via `agy acp --stdio` as a plain
// chat model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { acpUsage, killChild, pickFallbackEffort } from './acp.js';
import { macTerminal, spawnArgs, visibleConsole } from './claude-code.js';
import { openUrl as defaultOpenUrl } from './app/system.js';
import { pathDirs, shellQuote } from './codex.js';
import { err, t } from './i18n.js';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Base model slugs shown in the app window or mapped with an effort level.
export const ANTIGRAVITY_MODELS = {
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-4-neon': 'Gemini 4 Neon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
};

// Base models that publish effort-suffixed slugs (`-low`, `-medium`, `-high`).
const EFFORT_SUFFIX_MODELS = new Set(Object.keys(ANTIGRAVITY_MODELS));

// "gemini-4-hydrogen-low" -> "Gemini 4 Hydrogen", "gemini-pro-orchestrator-neon" -> "Orchestrator (Neon)".
export function prettyAntigravityModel(id) {
  const s = String(id || '').trim();
  if (!s || s === 'default') return null;
  if (s === 'gemini-pro-orchestrator') return 'Orchestrator';
  if (s === 'gemini-pro-orchestrator-g1-pro') return 'Orchestrator (Argon)';
  const orch = /^gemini-pro-orchestrator-([a-z0-9]+)$/i.exec(s);
  if (orch) return `Orchestrator (${orch[1][0].toUpperCase()}${orch[1].slice(1)})`;

  const base = s.replace(/-(?:low|medium|high|xhigh|max)$/i, '');
  if (ANTIGRAVITY_MODELS[base]) return ANTIGRAVITY_MODELS[base];

  const claude = /^claude-([a-z]+)-(\d+)-(\d+)/i.exec(base);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;

  const gemini = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)$/i.exec(base);
  if (gemini) return `Gemini ${gemini[1]} ${gemini[2][0].toUpperCase()}${gemini[2].slice(1)}`;

  return s;
}

// --- Finding Antigravity CLI ------------------------------------------------

export function antigravityCandidates(configured) {
  const out = [];
  if (configured && path.isAbsolute(configured)) out.push([configured, 'config']);
  const home = os.homedir();
  if (!isWin) {
    out.push([path.join(home, '.local', 'bin', 'agy'), 'native']);
    for (const d of pathDirs()) out.push([path.join(d, 'agy'), 'path']);
    if (isMac) {
      out.push(['/opt/homebrew/bin/agy', 'homebrew'], ['/usr/local/bin/agy', 'path']);
    }
    return out;
  }
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  out.push([path.join(local, 'agy', 'bin', 'agy.exe'), 'native']);
  for (const d of pathDirs()) {
    out.push([path.join(d, 'agy.exe'), 'path']);
    out.push([path.join(d, 'agy.cmd'), 'path']);
  }
  out.push([path.join(home, '.local', 'bin', 'agy.exe'), 'native']);
  out.push([path.join(home, 'scoop', 'shims', 'agy.exe'), 'scoop']);
  return out;
}

export function findAntigravity(configured) {
  const hit = antigravityCandidates(configured).find(([p]) => p && fs.existsSync(p));
  return hit ? { path: hit[0], source: hit[1] } : null;
}

// --- Sign-in status, install and login --------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const SKIP_MODEL_LINE = /^(?:fetching|error:|please sign in|usage:|available models)/i;

function parseModelsLines(text) {
  const out = [];
  for (const line of String(text || '').replace(ANSI_RE, '').split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (!trimmed || SKIP_MODEL_LINE.test(trimmed)) continue;
    const m = /^([a-z0-9][a-z0-9._:/-]+)(?:\t+|\s{2,})(\S.*)$/i.exec(trimmed)
      || /^([a-z0-9][a-z0-9._:/-]*[-/:.][a-z0-9._:/-]+)\s+(\S.*)$/i.exec(trimmed);
    if (m) out.push({ id: m[1], label: m[2].trim() });
  }
  return out;
}

function extractModelsFromJson(ev) {
  const list = ev?.command?.data?.models || ev?.models;
  if (Array.isArray(list)) {
    const items = list
      .filter((m) => m && typeof m.id === 'string' && m.id.trim())
      .map((m) => ({ id: m.id.trim(), label: String(m.label || m.name || m.id).trim() }));
    if (items.length) return items;
  }
  if (typeof ev?.response === 'string' && ev.response.trim()) {
    return parseModelsLines(ev.response);
  }
  return [];
}

// Parses `agy --output-format json models` or plain `agy models` output into [{ id, label }].
export function parseAntigravityModels(text) {
  const cleaned = String(text || '').replace(ANSI_RE, '').trim();
  if (!cleaned) return [];
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    try {
      const parsed = JSON.parse(cleaned);
      return extractModelsFromJson(Array.isArray(parsed) ? { models: parsed } : parsed);
    } catch { /* fall through to line-by-line JSON / text */ }
  }
  const fromJsonLines = [];
  for (const line of cleaned.split(/[\r\n]+/)) {
    const tline = line.trim();
    if (!tline.startsWith('{')) continue;
    try {
      fromJsonLines.push(...extractModelsFromJson(JSON.parse(tline)));
    } catch { /* ignore */ }
  }
  if (fromJsonLines.length) return fromJsonLines;
  return parseModelsLines(cleaned);
}

export function parseAntigravityAuthStatus(code, stdout, stderr) {
  const parsed = parseAntigravityModels(stdout);
  const models = parsed.length ? parsed : parseAntigravityModels(stderr);
  if (code === 0 && models.length > 0) return { loggedIn: true, models };
  const text = `${stdout || ''}\n${stderr || ''}`;
  if (/please sign in|authentication required|not (?:signed|logged) in|unauthori[sz]ed/i.test(text)) {
    return { loggedIn: false, models: [] };
  }
  return { loggedIn: false, models: [], error: t('antigravityStatusFailed') };
}

function execAntigravity(bin, args, timeout) {
  return new Promise((resolve) => {
    const { file, shell } = spawnArgs(bin);
    execFile(file, args, {
      shell,
      windowsHide: true,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

export async function antigravityAuthStatus(bin, timeout = 20000) {
  let res = await execAntigravity(bin, ['--output-format', 'json', 'models'], timeout);
  if (res.code !== 0 && /flags? provided but not defined:.*output-format|unknown flag.*output-format/i.test(`${res.stdout || ''}\n${res.stderr || ''}`)) {
    res = await execAntigravity(bin, ['models'], timeout);
  }
  return parseAntigravityAuthStatus(res.code, res.stdout, res.stderr);
}

export const ANTIGRAVITY_CODE_REDIRECT_URI = 'https://antigravity.google/oauth-callback';

// Validates a Google OAuth URL emitted by `agy acp` (loopback or oauth-callback code flow).
export function parseAntigravityAuthUrl(url, kind = 'code') {
  if (typeof url !== 'string' || !url || url.length > 16384 || /\s/.test(url)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.origin !== 'https://accounts.google.com') return null;
  if (u.pathname !== '/o/oauth2/auth' && u.pathname !== '/o/oauth2/v2/auth') return null;
  if (u.username !== '' || u.password !== '' || u.hash !== '') return null;
  const responseTypes = u.searchParams.getAll('response_type');
  if (responseTypes.length !== 1 || responseTypes[0] !== 'code') return null;
  const states = u.searchParams.getAll('state');
  const state = states.length === 1 ? states[0] : '';
  if (!state || state.length > 512 || /\s/.test(state)) return null;
  const redirects = u.searchParams.getAll('redirect_uri');
  const redirectUri = redirects.length === 1 ? redirects[0] : '';
  if (!redirectUri) return null;
  if (kind === 'code') {
    if (redirectUri !== ANTIGRAVITY_CODE_REDIRECT_URI) return null;
  } else if (kind === 'loopback') {
    const m = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})\/(?:oauth-callback)?$/.exec(redirectUri);
    const port = m ? Number(m[1]) : 0;
    if (!m || port < 1024 || port > 65535) return null;
  } else {
    return null;
  }
  return { authUrl: url, redirectUri, state };
}

// Validates the user-pasted code or full `antigravity.google/oauth-callback` URL.
export function parseAntigravityLoginCode(pending, input) {
  const value = String(input ?? '').trim();
  if (!value || value.length > 16384 || /\s|\0/.test(value)) return null;
  if (/^[A-Za-z0-9._/~+=-]{1,2048}$/.test(value)) return value;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (!pending || `${u.origin}${u.pathname}` !== pending.redirectUri) return null;
  if (u.username !== '' || u.password !== '') return null;
  const states = u.searchParams.getAll('state');
  const codes = u.searchParams.getAll('code');
  if (states.length !== 1 || states[0] !== pending.state) return null;
  if (codes.length !== 1 || !codes[0]) return null;
  return value;
}

export function friendlyAntigravityLoginError(message) {
  const m = String(message || '');
  if (/unknown (?:sub)?command|flag provided but not defined|unknown flag|usage of agy/i.test(m)) {
    return t('antigravityUpdateCli');
  }
  if (/SUBSCRIPTION_REQUIRED/i.test(m)) {
    return t('antigravitySubscriptionRequired');
  }
  if (/access_denied|denied access|cancelled|canceled/i.test(m)) {
    return t('antigravityLoginDenied');
  }
  if (/invalid_grant|malformed auth code|expired.*code|code.*expired|couldn't log in/i.test(m)) {
    return t('antigravityCodeRejected');
  }
  if (/timed out|timeout/i.test(m)) {
    return t('antigravityLoginTimeout');
  }
  return t('antigravityLoginFailed');
}

const IDLE_LOGIN_STATE = { phase: 'idle', mode: null, authUrl: null, error: null };
let loginState = { ...IDLE_LOGIN_STATE };
let activeLogin = null;
let nextSessionId = 0;

export function antigravityLoginState() {
  return { ...loginState };
}

function createLoginSession(mode, onLoggedIn) {
  const id = ++nextSessionId;
  const session = {
    id,
    mode,
    phase: 'starting',
    child: null,
    pending: null,
    authUrl: null,
    authTimer: null,
    startupTimer: null,
    cancelled: false,
    onLoggedIn,
    onCancel: null,
    clearTimers() {
      if (session.authTimer) { clearTimeout(session.authTimer); session.authTimer = null; }
      if (session.startupTimer) { clearTimeout(session.startupTimer); session.startupTimer = null; }
    },
  };
  activeLogin = session;
  return session;
}

const isCurrentSession = (session) => !session.cancelled && activeLogin === session && session.id === nextSessionId;

function spawnAntigravityChild(bin, args, cwd, env) {
  const { file, shell } = spawnArgs(bin);
  const finalArgs = shell ? shellQuote(args) : args;
  return spawn(file, finalArgs, {
    cwd: cwd || os.tmpdir(),
    shell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
}

export function cancelAntigravityLogin() {
  const session = activeLogin;
  activeLogin = null;
  nextSessionId++;
  loginState = { ...IDLE_LOGIN_STATE };
  if (!session) return Promise.resolve({ ...loginState });
  session.cancelled = true;
  session.clearTimers();
  try { session.onCancel?.(); } catch { /* ignore */ }
  try { session.child?.stdin?.end(); } catch { /* ignore */ }
  return killChild(session.child).then(() => ({ ...loginState }));
}

export const stopAntigravityLogin = cancelAntigravityLogin;

export function notifyAntigravityLoggedIn() {
  const session = activeLogin;
  if (session) {
    session.cancelled = true;
    session.clearTimers();
    activeLogin = null;
    nextSessionId++;
    try { session.onCancel?.(); } catch { /* ignore */ }
    try { session.child?.stdin?.end(); } catch { /* ignore */ }
    killChild(session.child).catch(() => {});
  }
  loginState = { ...IDLE_LOGIN_STATE };
}

export function openAntigravityInstall() {
  if (isMac) {
    macTerminal(t('consoleInstallAntigravity'), 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
    return;
  }
  visibleConsole(t('consoleInstallAntigravity'),
    `powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "irm https://antigravity.google/cli/install.ps1 | iex; Write-Host; Write-Host '${t('consoleDone')}'"`);
}

function appendBounded(buf, chunk, max = 16384) {
  const next = buf + chunk;
  return next.length > max ? next.slice(-max) : next;
}

function extractAuthUrlFromText(text, preferKind) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const m = /https:\/\/accounts\.google\.com\/\S+/.exec(rawLine.trim());
    if (!m) continue;
    const candidate = m[0];
    const parsed = preferKind === 'code'
      ? parseAntigravityAuthUrl(candidate, 'code')
      : (parseAntigravityAuthUrl(candidate, 'loopback') || parseAntigravityAuthUrl(candidate, 'code'));
    if (parsed) return parsed;
  }
  return null;
}

async function startCodeFlow(bin, workDir, {
  openUrl = defaultOpenUrl,
  onLoggedIn = () => {},
  authTimeoutMs = 300000,
  startupTimeoutMs = 30000,
  env = null,
} = {}) {
  const session = createLoginSession('code', onLoggedIn);
  loginState = { phase: 'starting', mode: 'code', authUrl: null, error: null };

  const childEnv = { ...(env || process.env), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  if (!isWin && !isMac) {
    delete childEnv.DISPLAY;
    delete childEnv.WAYLAND_DISPLAY;
  }

  let child;
  try {
    child = spawnAntigravityChild(bin, ['acp', '--login'], workDir, childEnv);
  } catch {
    if (activeLogin === session) activeLogin = null;
    loginState = { phase: 'failed', mode: 'code', authUrl: null, error: t('antigravityLoginStartFailed') };
    return { ...loginState };
  }
  session.child = child;
  child.stdin.on('error', () => {});

  let output = '';
  let stdoutTail = '';
  let stderrTail = '';
  let urlSettled = false;
  let resolveUrl;
  const urlPromise = new Promise((resolve) => { resolveUrl = resolve; });
  const finishUrl = (res) => {
    if (urlSettled) return;
    urlSettled = true;
    resolveUrl(res);
  };
  session.onCancel = () => finishUrl({ ok: false, cancelled: true });

  const handleChunk = (isOut, chunk) => {
    const s = String(chunk);
    output = appendBounded(output, s);
    const combined = (isOut ? stdoutTail : stderrTail) + s;
    const lines = combined.split(/\r?\n/);
    const tail = lines.pop() ?? '';
    if (isOut) stdoutTail = tail; else stderrTail = tail;
    if (!urlSettled && lines.length) {
      const parsed = extractAuthUrlFromText(lines.join('\n'), 'code');
      if (parsed) finishUrl({ ok: true, parsed });
    }
  };
  child.stdout.on('data', (d) => handleChunk(true, d));
  child.stderr.on('data', (d) => handleChunk(false, d));

  child.once('error', () => finishUrl({ ok: false, error: t('antigravityLoginStartFailed') }));
  child.once('close', () => {
    if (!urlSettled) {
      const parsed = extractAuthUrlFromText(`${stdoutTail}\n${stderrTail}`, 'code');
      if (parsed) finishUrl({ ok: true, parsed });
      else finishUrl({ ok: false, error: friendlyAntigravityLoginError(output) });
    }
    if (isCurrentSession(session) && session.phase === 'code') {
      session.clearTimers();
      activeLogin = null;
      loginState = { phase: 'failed', mode: 'code', authUrl: null, error: friendlyAntigravityLoginError(output) };
    }
  });

  session.startupTimer = setTimeout(() => {
    finishUrl({ ok: false, error: t('antigravityLoginTimeout') });
  }, startupTimeoutMs);
  session.startupTimer.unref?.();

  const urlRes = await urlPromise;
  session.clearTimers();
  if (!isCurrentSession(session)) {
    await killChild(child);
    return { ...loginState };
  }
  if (!urlRes.ok) {
    if (activeLogin === session) activeLogin = null;
    await killChild(child);
    loginState = { phase: 'failed', mode: 'code', authUrl: null, error: urlRes.error || t('antigravityLoginFailed') };
    return { ...loginState };
  }

  session.pending = urlRes.parsed;
  session.phase = 'code';
  session.authUrl = urlRes.parsed.authUrl;
  session.getOutput = () => output;
  loginState = { phase: 'code', mode: 'code', authUrl: urlRes.parsed.authUrl, error: null };

  try { openUrl(urlRes.parsed.authUrl); } catch { /* link also shown in UI */ }

  session.authTimer = setTimeout(() => {
    if (!isCurrentSession(session)) return;
    session.cancelled = true;
    session.clearTimers();
    activeLogin = null;
    loginState = { phase: 'failed', mode: 'code', authUrl: null, error: t('antigravityLoginTimeout') };
    try { child.stdin.end(); } catch { /* ignore */ }
    killChild(child).catch(() => {});
  }, authTimeoutMs);
  session.authTimer.unref?.();

  return { ...loginState };
}

async function startAcpFlow(bin, workDir, opts = {}) {
  const {
    onLoggedIn = () => {},
    authTimeoutMs = 300000,
    startupTimeoutMs = 30000,
    settleMs = 1200,
    env = null,
  } = opts;
  const session = createLoginSession('acp', onLoggedIn);
  loginState = { phase: 'starting', mode: 'acp', authUrl: null, error: null };

  const childEnv = { ...(env || process.env), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  let child;
  try {
    child = spawnAntigravityChild(bin, ['acp', '--stdio'], workDir, childEnv);
  } catch {
    if (activeLogin === session) activeLogin = null;
    loginState = { phase: 'failed', mode: 'acp', authUrl: null, error: t('antigravityLoginStartFailed') };
    return { ...loginState };
  }
  session.child = child;
  child.stdin.on('error', () => {});

  let stderrBuf = '';
  let stdoutNonJson = '';
  let stdoutTail = '';
  let stderrTail = '';
  let initSettled = false;
  let authSettled = false;
  let resolveInit;
  let resolveAuth;
  const initPromise = new Promise((resolve) => { resolveInit = resolve; });
  const authPromise = new Promise((resolve) => { resolveAuth = resolve; });
  const finishInit = (res) => {
    if (initSettled) return;
    initSettled = true;
    resolveInit(res);
  };
  const finishAuth = (res) => {
    if (authSettled) return;
    authSettled = true;
    resolveAuth(res);
  };
  session.onCancel = () => {
    finishInit({ ok: false, cancelled: true });
    finishAuth({ status: 'cancelled' });
  };

  const maybeCaptureUrl = (line) => {
    if (!/accounts\.google\.com/.test(line)) return;
    const parsed = extractAuthUrlFromText(line, 'loopback');
    if (parsed && isCurrentSession(session)) {
      session.authUrl = parsed.authUrl;
      if (loginState.phase === 'browser') {
        loginState = { ...loginState, authUrl: parsed.authUrl };
      }
    }
  };

  const handleStdoutLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    maybeCaptureUrl(trimmed);
    if (trimmed.startsWith('{')) {
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id === 1) finishInit({ ok: true, msg });
        else if (msg.id === 2) finishAuth({ status: 'rpc', msg });
        return;
      } catch { /* non-JSON line */ }
    }
    stdoutNonJson = appendBounded(stdoutNonJson, `${trimmed}\n`, 4096);
  };

  child.stdout.on('data', (d) => {
    const combined = stdoutTail + String(d);
    const lines = combined.split(/\r?\n/);
    stdoutTail = lines.pop() ?? '';
    for (const line of lines) handleStdoutLine(line);
  });
  child.stderr.on('data', (d) => {
    const s = String(d);
    stderrBuf = appendBounded(stderrBuf, s, 8192);
    const combined = stderrTail + s;
    const lines = combined.split(/\r?\n/);
    stderrTail = lines.pop() ?? '';
    for (const line of lines) maybeCaptureUrl(line);
  });

  child.once('error', () => {
    finishInit({ ok: false, error: t('antigravityLoginStartFailed') });
    finishAuth({ status: 'error', error: t('antigravityLoginStartFailed') });
  });
  child.once('close', () => {
    if (stdoutTail) handleStdoutLine(stdoutTail);
    if (stderrTail) maybeCaptureUrl(stderrTail);
    const errText = `${stderrBuf}\n${stdoutNonJson}`;
    finishInit({ ok: false, error: friendlyAntigravityLoginError(errText) });
    finishAuth({ status: 'closed', error: friendlyAntigravityLoginError(errText) });
  });

  session.startupTimer = setTimeout(() => {
    finishInit({ ok: false, error: t('antigravityLoginTimeout') });
  }, startupTimeoutMs);
  session.startupTimer.unref?.();

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'forever-ai-companion', version: opts.clientVersion || 'unknown' },
      },
    })}\n`);
  } catch {
    finishInit({ ok: false, error: t('antigravityLoginStartFailed') });
  }

  const initRes = await initPromise;
  session.clearTimers();
  if (!isCurrentSession(session)) {
    await killChild(child);
    return { ...loginState };
  }
  if (!initRes.ok) {
    if (activeLogin === session) activeLogin = null;
    await killChild(child);
    loginState = { phase: 'failed', mode: 'acp', authUrl: null, error: initRes.error || t('antigravityLoginFailed') };
    return { ...loginState };
  }
  if (initRes.msg?.error) {
    if (activeLogin === session) activeLogin = null;
    await killChild(child);
    loginState = {
      phase: 'failed',
      mode: 'acp',
      authUrl: null,
      error: friendlyAntigravityLoginError(initRes.msg.error.message || ''),
    };
    return { ...loginState };
  }

  const methods = initRes.msg?.result?.authMethods;
  if (Array.isArray(methods) && methods.length > 0 && !methods.some((m) => m?.id === 'oauth-personal')) {
    if (activeLogin === session) activeLogin = null;
    await killChild(child);
    return startCodeFlow(bin, workDir, opts);
  }

  session.phase = 'browser';
  loginState = { phase: 'browser', mode: 'acp', authUrl: session.authUrl, error: null };

  session.authTimer = setTimeout(() => {
    if (!isCurrentSession(session)) return;
    session.cancelled = true;
    session.clearTimers();
    activeLogin = null;
    loginState = { phase: 'failed', mode: 'acp', authUrl: null, error: t('antigravityLoginTimeout') };
    try { child.stdin.end(); } catch { /* ignore */ }
    killChild(child).catch(() => {});
    finishAuth({ status: 'timeout' });
  }, authTimeoutMs);
  session.authTimer.unref?.();

  let fallbackPromise = null;
  const outcomePromise = authPromise.then(async (res) => {
    if (!isCurrentSession(session)) return 'cancelled';
    session.clearTimers();
    if (activeLogin === session) activeLogin = null;
    try { child.stdin.end(); } catch { /* ignore */ }
    await killChild(child);
    if (session.cancelled) return 'cancelled';

    if (res.status === 'rpc' && !res.msg?.error) {
      loginState = { phase: 'succeeded', mode: 'acp', authUrl: null, error: null };
      try { await onLoggedIn(); } catch { /* status check handles */ }
      return 'succeeded';
    }
    const errMsg = res.status === 'rpc' ? String(res.msg?.error?.message || '') : '';
    const needsCodeFallback = res.status === 'rpc'
      && /no browser is available|sign-in redirect can't reach|cannot open browser|failed to open browser|localhost|loopback|bind|address already in use|eaddrinuse/i.test(errMsg);
    if (needsCodeFallback) {
      fallbackPromise = startCodeFlow(bin, workDir, opts).catch((e) => {
        loginState = { phase: 'failed', mode: 'code', authUrl: null, error: e?.message || t('antigravityLoginFailed') };
        return { ...loginState };
      });
      return 'fallback-code';
    }
    const message = res.status === 'rpc' ? friendlyAntigravityLoginError(errMsg) : (res.error || t('antigravityLoginFailed'));
    loginState = { phase: 'failed', mode: 'acp', authUrl: null, error: message };
    return 'failed';
  });

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'authenticate',
      params: { methodId: 'oauth-personal' },
    })}\n`);
  } catch {
    finishAuth({ status: 'error', error: t('antigravityLoginStartFailed') });
  }

  let settleTimer = null;
  const settled = await Promise.race([
    outcomePromise,
    new Promise((resolve) => {
      settleTimer = setTimeout(() => resolve('pending'), settleMs);
      settleTimer.unref?.();
    }),
  ]);
  if (settleTimer) clearTimeout(settleTimer);

  if (settled === 'fallback-code' && fallbackPromise) {
    return fallbackPromise;
  }
  return { ...loginState };
}

// Signs in with Google Account without opening a terminal window.
// Tier 1 (`auto`): `agy acp --stdio` -> `initialize` -> `authenticate(oauth-personal)`
// (automatically handles browser launch & localhost OAuth callback).
// Tier 2 (`code`, automatic fallback or user-requested): `agy acp --login` -> opens
// the Google URL in the default browser and accepts the pasted code in-app.
export async function startAntigravityLogin(bin, workDir, opts = {}) {
  await cancelAntigravityLogin();
  if (opts.mode === 'code') {
    return startCodeFlow(bin, workDir, opts);
  }
  return startAcpFlow(bin, workDir, opts);
}

export async function submitAntigravityLoginCode(rawCode, { exchangeTimeoutMs = 30000 } = {}) {
  const session = activeLogin;
  if (!session || session.cancelled || session.mode !== 'code' || session.phase !== 'code' || !session.pending) {
    throw err('antigravityNoActiveLogin');
  }
  const validated = parseAntigravityLoginCode(session.pending, rawCode);
  if (!validated) {
    throw err('antigravityInvalidCode');
  }

  session.phase = 'submitting';
  session.clearTimers();
  loginState = { phase: 'submitting', mode: 'code', authUrl: null, error: null };

  const child = session.child;
  const result = await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(res);
    };
    timer = setTimeout(() => finish({ ok: false, timedOut: true }), exchangeTimeoutMs);
    timer.unref?.();

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      finish({ ok: child?.exitCode === 0, timedOut: false });
      return;
    }
    child.once('close', (code) => finish({ ok: code === 0, timedOut: false }));
    child.once('error', () => finish({ ok: false, timedOut: false }));
    try {
      child.stdin.end(`${validated}\n`);
    } catch {
      finish({ ok: false, timedOut: false });
    }
  });

  if (session.cancelled) {
    await killChild(child);
    return { ok: false, login: { ...loginState } };
  }

  if (activeLogin === session) activeLogin = null;
  const output = session.getOutput ? session.getOutput() : '';
  await killChild(child);

  if (result.ok) {
    loginState = { phase: 'succeeded', mode: 'code', authUrl: null, error: null };
    try { await session.onLoggedIn(); } catch { /* status check handles */ }
    return { ok: true, login: { ...loginState } };
  }

  const message = result.timedOut ? t('antigravityLoginTimeout') : friendlyAntigravityLoginError(output);
  loginState = { phase: 'failed', mode: 'code', authUrl: null, error: message };
  throw new Error(message);
}

// --- Running chat turns via ACP ---------------------------------------------

// Chat-only guardrail: replaces coding-agent assumptions when talking to the player.
export const ANTIGRAVITY_NOTE = `## Tools
Do not run commands or read or write files: nothing on this PC helps answer. Answer directly from the character data, the guide and, if allowed above, a web search.`;

// Maps (model, effort) for Antigravity model slugs:
// Bare Gemini 4 / 3.8 Flash names take effort as a suffix when the ACP server
// only exposes variant slugs or uses legacy `session/set_model`; `default` keeps
// effort for `thought_level`; explicit variants and Orchestrators stay untouched.
export function resolveAntigravityModel(model, effort) {
  const m = String(model || '').trim();
  const e = String(effort || '').trim().toLowerCase();
  if (!m || m === 'default') return { model: null, effort: e || null };
  if (EFFORT_SUFFIX_MODELS.has(m)) return { model: e ? `${m}-${e}` : m, effort: null };
  return { model: m, effort: null };
}

// If `default` + effort/thought_level is rejected (e.g. Orchestrator or a model
// without `low`), returns the next effort string to retry with, `null` to skip
// setting effort, or `undefined` when the error is unrelated.
export function fallbackAntigravityEffort(errorText, currentEffort, available = null) {
  const text = String(errorText || '');
  if (/effort\s+(?:isn't|is not)\s+adjustable/i.test(text)) return null;
  if (/thinking level\s+["'`]?[a-z]+["'`]?\s+is not (?:offered|available)/i.test(text)) {
    const cur = String(currentEffort || '').trim().toLowerCase();
    const rest = (Array.isArray(available) ? available : [])
      .filter((v) => String(v || '').trim().toLowerCase() !== cur);
    return rest.length ? pickFallbackEffort(rest, cur) : null;
  }
  const m = /has no ["'`]?[a-z]+["'`]? effort\s*\(\s*available\s*:\s*([^)]+)\)/i.exec(text);
  if (!m) return undefined;
  const parsed = m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parsed.length ? pickFallbackEffort(parsed, currentEffort) : null;
}

export function antigravityAcpArgs(c = {}) {
  return ['acp', '--stdio', ...(c?.extraArgs || [])];
}

// Normalizes ACP PromptResponse usage or Antigravity CLI token stats into { input, cached, output }.
export function antigravityUsage(u) {
  return acpUsage(u);
}

const AUTH_ERROR_RE = /authentication required|please sign in|not (?:signed|logged) in|log ?in required|\b401\b|unauthori[sz]ed/i;

export function isAntigravityAuthError(error) {
  const msg = typeof error === 'string' ? error : String(error?.message || '');
  return (error?.code === -32000 && /auth|sign in|log ?in/i.test(msg)) || AUTH_ERROR_RE.test(msg);
}

export function friendlyAntigravityError(message) {
  const m = String(message || '');
  if (AUTH_ERROR_RE.test(m)) {
    return t('antigravitySignedOut');
  }
  if (/usage limit|rate limit|weekly.*limit|\b429\b|quota|out of credits|exhausted|spend[- ]?cap/i.test(m)) {
    return t('antigravityLimit');
  }
  if (/unknown model(?:\s+id)?|invalid model|not recognized as a known model|model.*(?:not (?:supported|available|found|recognized)|does not exist)|access to model|not included in your plan|\bmodel\b.*\bis unavailable\b|^["'`]?[a-z0-9][a-z0-9._:/-]+["'`]?\s+is unavailable\b/i.test(m)) {
    return t('antigravityModel');
  }
  return t('antigravityError', { error: m.slice(0, 300) });
}

export { shellQuote };
