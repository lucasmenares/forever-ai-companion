// Generic Agent Client Protocol (ACP) client over stdio JSON-RPC 2.0.
// Used to run CLI-backed AI subscriptions as plain chat models with no local
// file, command, or MCP access (and optional web lookup gated per request).
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { spawnArgs } from './claude-code.js';
import { shellQuote } from './codex.js';
import { err } from './i18n.js';

const isWin = process.platform === 'win32';
const EFFORT_SUFFIX_RE = /^(.+)-(low|medium|high|xhigh|max)$/i;

function appendBounded(buf, chunk, max) {
  const next = buf + chunk;
  return next.length > max ? next.slice(-max) : next;
}

function killProcessTree(pid) {
  if (!isWin || !pid) return Promise.resolve();
  return new Promise((resolve) => {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve());
  });
}

// Terminates a spawned CLI child process (and its process tree on Windows).
export function killChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  if (isWin) return killProcessTree(child.pid);
  return new Promise((resolve) => {
    let done = false;
    let killTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (killTimer) clearTimeout(killTimer);
      resolve();
    };
    child.once('close', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish();
    }, 1500);
    killTimer.unref?.();
  });
}

// Closes stdin so an ACP stdio server can exit cleanly, escalating to killChild after graceMs.
export function closeChild(child, graceMs = 150) {
  if (!child) return Promise.resolve();
  try { child.stdin?.end(); } catch { /* ignore */ }
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const onClose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off('close', onClose);
      killChild(child).then(resolve, resolve);
    }, graceMs);
    timer.unref?.();
    child.once('close', onClose);
  });
}

// Normalizes ACP PromptResponse usage (camelCase) or legacy CLI usage (snake_case)
// into { input, cached, output }.
export function acpUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const hasRaw = [
    'inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'thoughtTokens',
    'input_tokens', 'output_tokens', 'total_tokens', 'cache_read_tokens', 'thinking_tokens',
  ].some((k) => u[k] !== undefined && u[k] !== null);
  if (!hasRaw) {
    if (u.input !== undefined || u.output !== undefined || u.cached !== undefined) {
      return { input: n(u.input), cached: n(u.cached), output: n(u.output) };
    }
    return null;
  }
  const rawInput = n(u.inputTokens ?? u.input_tokens);
  const cached = n(u.cachedReadTokens ?? u.cache_read_tokens);
  const cachedWrite = n(u.cachedWriteTokens ?? u.cache_write_tokens);
  // Some providers report inputTokens inclusive of cachedReadTokens; others report uncached input only.
  const input = cached > rawInput ? rawInput + cached + cachedWrite : rawInput;
  const output = Math.max(n(u.outputTokens ?? u.output_tokens), n(u.thoughtTokens ?? u.thinking_tokens));
  return { input, cached, output };
}

// Flattens flat or grouped ACP SessionConfigSelectOptions into [{ value, name, ... }].
export function flattenConfigOptions(options) {
  if (!Array.isArray(options)) return [];
  const out = [];
  for (const item of options) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.options)) {
      out.push(...flattenConfigOptions(item.options));
    } else if (typeof item.value === 'string' && item.value.trim()) {
      out.push(item);
    }
  }
  return out;
}

// Finds a SessionConfigOption by semantic category, falling back to conventional IDs.
export function findConfigOption(configOptions, category) {
  if (!Array.isArray(configOptions)) return null;
  const byCategory = configOptions.find((o) => o && o.category === category);
  if (byCategory) return byCategory;
  if (category === 'model') {
    return configOptions.find((o) => o && o.id === 'model') || null;
  }
  if (category === 'thought_level') {
    return configOptions.find((o) => o && typeof o.id === 'string' && /^(?:thought_level|thinking_level|reasoning_effort|effort)$/i.test(o.id)) || null;
  }
  return configOptions.find((o) => o && o.id === category) || null;
}

export function pickFallbackEffort(available, currentEffort) {
  const list = (Array.isArray(available) ? available : [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return null;
  if (String(currentEffort || '').toLowerCase() === 'low' && list.includes('medium')) return 'medium';
  if (list.includes('low')) return 'low';
  if (list.includes('medium')) return 'medium';
  return list[0];
}

function isPrivateIpv4Parts(a, b) {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const nums = ipv4.slice(1).map(Number);
    if (nums.some((n) => n < 0 || n > 255)) return true;
    return isPrivateIpv4Parts(nums[0], nums[1]);
  }

  // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10) / IPv4-mapped.
  if (host === '::' || host === '::1') return true;
  if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
  const v4MappedDotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(host);
  if (v4MappedDotted) {
    const nums = v4MappedDotted.slice(1).map(Number);
    return isPrivateIpv4Parts(nums[0], nums[1]);
  }
  const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16);
    return isPrivateIpv4Parts((hi >> 8) & 0xff, hi & 0xff);
  }
  return false;
}

// Rejects non-HTTP(S) schemes and loopback / private / link-local hosts to prevent SSRF.
export function isPublicHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  let u;
  try { u = new URL(raw.trim()); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!u.hostname || isPrivateHost(u.hostname)) return false;
  return true;
}

const DISALLOWED_TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'execute', 'switch_mode']);
const DANGEROUS_NAME_RE = /browser|execute_url|command|bash|shell|terminal|read_file|write_file|edit_file|delete|patch|grep|glob|find|list_dir|mcp|subagent|skill|notebook|computer_use/i;
const DANGEROUS_TITLE_RE = /\b(?:open\s+browser|browser\s+subagent|execute_url|run\s+command|bash|shell|terminal|read\s+file|write\s+file|edit\s+file|delete\s+file|grep|files?\s+named|list\s+dir|mcp\s+tool|subagent|notebook)\b/i;
const DANGEROUS_INPUT_KEY_RE = /^(?:path|filepath|file_path|targetfile|target_file|directory|directorypath|directory_path|searchpath|search_path|searchdirectory|search_directory|cwd|workdir|command|commandline|command_line|cmd|script|code|content|patch|diff)$/i;
const URL_KEY_RE = /^(?:(?:target_?)?url|uri|href|urls)$/i;
const URL_IN_TITLE_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const WEB_LOOKUP_TOOL_NAMES = new Set([
  'search_web', 'web_search', 'websearch',
  'read_url', 'read_url_content', 'read_url_web_content',
  'fetch_url', 'fetch_web_page', 'web_fetch', 'webfetch',
]);

function extractUrlsFromInput(rawInput) {
  const urls = [];
  for (const [k, v] of Object.entries(rawInput)) {
    if (!URL_KEY_RE.test(k)) continue;
    if (typeof v === 'string' && v.trim()) urls.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim()) urls.push(item);
      }
    }
  }
  return urls;
}

// Fail-closed check: only permits read-only web search and public HTTP(S) URL fetching.
export function isWebLookupTool(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return false;
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind.trim().toLowerCase() : '';
  if (DISALLOWED_TOOL_KINDS.has(kind)) return false;
  if (Array.isArray(toolCall.locations) && toolCall.locations.length > 0) return false;

  const rawName = String(toolCall.name || '').replace(/^[a-z0-9_.-]+:/i, '').trim().toLowerCase();
  const title = String(toolCall.title || '').trim();
  if (DANGEROUS_NAME_RE.test(rawName) || DANGEROUS_TITLE_RE.test(title)) return false;

  const rawInput = toolCall.rawInput && typeof toolCall.rawInput === 'object' && !Array.isArray(toolCall.rawInput)
    ? toolCall.rawInput
    : null;
  if (rawInput) {
    for (const k of Object.keys(rawInput)) {
      if (DANGEROUS_INPUT_KEY_RE.test(k)) return false;
    }
    for (const u of extractUrlsFromInput(rawInput)) {
      if (!isPublicHttpUrl(u)) return false;
    }
  }
  const titleUrls = title.match(URL_IN_TITLE_RE) || [];
  for (const u of titleUrls) {
    if (!isPublicHttpUrl(u)) return false;
  }

  if (WEB_LOOKUP_TOOL_NAMES.has(rawName)) return true;
  if (kind === 'fetch') return true;
  if (kind === 'search') {
    if (/\b(?:web\s*search|search(?:ing)?\s+(?:the\s+)?web)\b/i.test(title)) return true;
    const query = rawInput && (typeof rawInput.query === 'string' ? rawInput.query : typeof rawInput.Query === 'string' ? rawInput.Query : '');
    const hasLocalSearchKey = rawInput && Object.keys(rawInput).some((k) => /^(?:pattern|glob|includes)$/i.test(k));
    if (query.trim() && !hasLocalSearchKey && !/\b(?:grep|files?|codebase|workspace|directory|folder|symbol|definition)\b/i.test(title)) {
      return true;
    }
    return false;
  }
  if (!kind || kind === 'other') {
    return /^(?:read\s+url|fetch\s+url|fetch\s+web|web\s*search|search(?:ing)?\s+(?:the\s+)?web)\b/i.test(title);
  }
  return false;
}

// Builds a RequestPermissionResponse selecting allow_once or reject_once safely.
export function acpPermissionResponse(params, { allowWeb = false, allowTool = null } = {}) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const permitted = typeof allowTool === 'function'
    ? Boolean(allowTool(params?.toolCall))
    : (allowWeb && isWebLookupTool(params?.toolCall));

  const pick = (primaryKind, secondaryKind, idPattern) => (
    options.find((o) => o && o.kind === primaryKind && typeof o.optionId === 'string')
    || options.find((o) => o && o.kind === secondaryKind && typeof o.optionId === 'string')
    || options.find((o) => o && typeof o.optionId === 'string' && idPattern.test(o.optionId))
  );

  const chosen = permitted
    ? pick('allow_once', 'allow_always', /allow/i)
    : pick('reject_once', 'reject_always', /reject|deny/i);

  if (chosen) {
    return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

// Spawns an ACP stdio subprocess and speaks line-delimited JSON-RPC 2.0 over stdin/stdout.
export function createAcpClient({
  bin,
  args = [],
  cwd = os.tmpdir(),
  env = process.env,
  timeoutMs = 180000,
  onNotification = () => {},
  onRequest = null,
  onTimeout = null,
} = {}) {
  const { file, shell } = spawnArgs(bin);
  const finalArgs = shell ? shellQuote(args) : args;
  const child = spawn(file, finalArgs, {
    cwd,
    shell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  child.stdin.on('error', () => {});

  let nextId = 1;
  let closed = false;
  let stdoutTail = '';
  let stdoutNonJson = '';
  let stderrBuf = '';
  const pending = new Map();

  const clearTimer = () => {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };

  const rejectAllPending = (error) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };

  const writeJson = (payload) => {
    if (closed || !child.stdin.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const getDiagnostics = () => [stderrBuf.trim(), stdoutNonJson.trim()].filter(Boolean).join('\n');

  let deadlineTimer = null;
  if (timeoutMs > 0) {
    deadlineTimer = setTimeout(() => {
      if (closed) return;
      try { onTimeout?.(); } catch { /* ignore */ }
      closed = true;
      const e = err('tooSlow', { bin });
      e.code = 'ACP_TIMEOUT';
      rejectAllPending(e);
      killChild(child).catch(() => {});
    }, timeoutMs);
    deadlineTimer.unref?.();
  }

  const handleServerRequest = (msg) => {
    const id = msg.id;
    if (typeof onRequest !== 'function') {
      writeJson({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    Promise.resolve()
      .then(() => onRequest(msg.method, msg.params))
      .then((result) => {
        writeJson({ jsonrpc: '2.0', id, result: result === undefined ? {} : result });
      })
      .catch((e) => {
        writeJson({
          jsonrpc: '2.0',
          id,
          error: {
            code: typeof e?.rpcCode === 'number' ? e.rpcCode : -32601,
            message: e?.message || 'Method not found',
          },
        });
      });
  };

  const handleStdoutLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('{')) {
      let msg;
      try { msg = JSON.parse(trimmed); } catch { msg = null; }
      if (msg && typeof msg === 'object') {
        if (msg.id !== undefined && typeof msg.method === 'string') {
          handleServerRequest(msg);
          return;
        }
        if (msg.id !== undefined && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) {
          const waiter = pending.get(msg.id);
          if (!waiter) return;
          pending.delete(msg.id);
          if (msg.error) {
            const e = new Error(String(msg.error.message || 'ACP error'));
            e.code = msg.error.code;
            e.data = msg.error.data;
            e.rpcError = true;
            waiter.reject(e);
          } else {
            waiter.resolve(msg.result);
          }
          return;
        }
        if (typeof msg.method === 'string') {
          try { onNotification(msg.method, msg.params); } catch { /* ignore */ }
          return;
        }
      }
    }
    stdoutNonJson = appendBounded(stdoutNonJson, `${trimmed}\n`, 4096);
  };

  child.stdout.on('data', (chunk) => {
    const combined = stdoutTail + String(chunk);
    const lines = combined.split(/\r?\n/);
    stdoutTail = lines.pop() ?? '';
    for (const line of lines) handleStdoutLine(line);
  });

  child.stderr.on('data', (chunk) => {
    stderrBuf = appendBounded(stderrBuf, String(chunk), 8192);
  });

  child.once('error', (spawnErr) => {
    closed = true;
    clearTimer();
    const e = err('cannotRun', { bin, error: spawnErr.message });
    e.code = 'ACP_SPAWN_ERROR';
    rejectAllPending(e);
  });

  child.once('close', (code) => {
    if (stdoutTail) {
      handleStdoutLine(stdoutTail);
      stdoutTail = '';
    }
    closed = true;
    clearTimer();
    if (pending.size > 0) {
      const diag = getDiagnostics();
      const e = new Error(diag || `${path.basename(bin)} exited with code ${code ?? 1}`);
      e.code = 'ACP_CLOSED';
      e.exitCode = code;
      rejectAllPending(e);
    }
  });

  return {
    child,
    getDiagnostics,
    notify(method, params) {
      return writeJson({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    },
    request(method, params) {
      if (closed) {
        return Promise.reject(new Error(getDiagnostics() || 'ACP connection closed'));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        if (!writeJson({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })) {
          pending.delete(id);
          reject(new Error(getDiagnostics() || 'Failed to write ACP request'));
        }
      });
    },
    close(graceMs = 150) {
      closed = true;
      clearTimer();
      return closeChild(child, graceMs);
    },
    kill() {
      closed = true;
      clearTimer();
      return killChild(child);
    },
  };
}

function extractChunkText(content) {
  if (!content) return '';
  if (Array.isArray(content)) return content.map(extractChunkText).join('');
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

function selectModelTarget(modelOpt, requestedModel, resolved) {
  const opts = flattenConfigOptions(modelOpt.options);
  const values = new Set(opts.map((o) => o.value));
  if (values.has(requestedModel)) {
    return {
      targetModel: requestedModel,
      clearEffort: EFFORT_SUFFIX_RE.test(requestedModel),
      overrideEffort: null,
    };
  }
  if (resolved?.model && resolved.model !== requestedModel && values.has(resolved.model)) {
    return { targetModel: resolved.model, clearEffort: true, overrideEffort: null };
  }
  const suffixed = EFFORT_SUFFIX_RE.exec(requestedModel);
  if (suffixed && values.has(suffixed[1])) {
    return {
      targetModel: suffixed[1],
      clearEffort: false,
      overrideEffort: suffixed[2].toLowerCase(),
    };
  }
  return {
    targetModel: requestedModel,
    clearEffort: EFFORT_SUFFIX_RE.test(requestedModel),
    overrideEffort: null,
  };
}

async function setSessionModel({ client, sessionId, getConfigOptions, setConfigOptions, requestedModel, resolved }) {
  const configOptions = getConfigOptions();
  const modelOpt = findConfigOption(configOptions, 'model');
  if (modelOpt) {
    const { targetModel, clearEffort, overrideEffort } = selectModelTarget(modelOpt, requestedModel, resolved);
    if (targetModel !== modelOpt.currentValue) {
      try {
        const res = await client.request('session/set_config_option', {
          sessionId,
          configId: modelOpt.id,
          value: targetModel,
        });
        if (Array.isArray(res?.configOptions)) setConfigOptions(res.configOptions);
      } catch (e) {
        if (e?.code !== -32601) throw e;
        await client.request('session/set_model', {
          sessionId,
          modelId: resolved?.model || targetModel,
        });
      }
    }
    const latestOpt = findConfigOption(getConfigOptions(), 'model');
    return {
      activeModel: latestOpt?.currentValue || targetModel,
      clearEffort,
      overrideEffort,
    };
  }

  const legacyModelId = resolved?.model || requestedModel;
  await client.request('session/set_model', { sessionId, modelId: legacyModelId });
  return {
    activeModel: legacyModelId,
    clearEffort: resolved?.effort === null,
    overrideEffort: null,
  };
}

async function setSessionEffort({ client, sessionId, getConfigOptions, setConfigOptions, desiredEffort, fallbackEffort }) {
  const effortOpt = findConfigOption(getConfigOptions(), 'thought_level');
  if (!effortOpt) return;

  const opts = flattenConfigOptions(effortOpt.options);
  const avail = opts.map((o) => o.value);
  const matched = avail.find((v) => v.toLowerCase() === desiredEffort);
  let targetEffort = matched;
  if (!targetEffort) {
    if (avail.length > 0) {
      const fb = pickFallbackEffort(avail, desiredEffort);
      targetEffort = avail.find((v) => v.toLowerCase() === fb) || fb;
    } else {
      targetEffort = desiredEffort;
    }
  }
  if (!targetEffort || targetEffort === effortOpt.currentValue) return;

  try {
    const res = await client.request('session/set_config_option', {
      sessionId,
      configId: effortOpt.id,
      value: targetEffort,
    });
    if (Array.isArray(res?.configOptions)) setConfigOptions(res.configOptions);
  } catch (e) {
    const retry = typeof fallbackEffort === 'function' ? fallbackEffort(e.message, targetEffort, avail) : undefined;
    if (typeof retry === 'string' && retry && retry !== targetEffort) {
      const retryTarget = avail.find((v) => v.toLowerCase() === retry.toLowerCase()) || retry;
      const res = await client.request('session/set_config_option', {
        sessionId,
        configId: effortOpt.id,
        value: retryTarget,
      });
      if (Array.isArray(res?.configOptions)) setConfigOptions(res.configOptions);
    } else if (retry !== null) {
      throw e;
    }
  }
}

// Runs a single-turn chat inference against any ACP stdio server:
// initialize -> session/new -> model/effort config -> session/prompt.
export async function runAcpPrompt({
  bin,
  args = ['acp', '--stdio'],
  cwd = os.tmpdir(),
  env = process.env,
  clientInfo = { name: 'forever-ai-companion', version: 'unknown' },
  prompt,
  model,
  effort,
  webSearch = false,
  allowTool = null,
  sessionMeta = null,
  resolveModel = null,
  fallbackEffort = null,
  timeoutMs = 180000,
} = {}) {
  let sessionId = null;
  let configOptions = null;
  let activeModel = null;
  let collecting = false;
  let lastUsage = null;
  const chunks = [];
  const toolCalls = new Map();

  const refreshActiveModel = () => {
    const modelOpt = findConfigOption(configOptions, 'model');
    if (modelOpt?.currentValue) activeModel = modelOpt.currentValue;
  };

  let client;
  client = createAcpClient({
    bin,
    args,
    cwd,
    env,
    timeoutMs,
    onNotification(method, params) {
      if (method !== 'session/update') return;
      if (sessionId && params?.sessionId && params.sessionId !== sessionId) return;
      const u = params?.update;
      if (!u || typeof u !== 'object') return;
      if (u.sessionUpdate === 'agent_message_chunk') {
        if (collecting) {
          const text = extractChunkText(u.content);
          if (text) chunks.push(text);
        }
      } else if (u.sessionUpdate === 'config_option_update') {
        if (Array.isArray(u.configOptions)) {
          configOptions = u.configOptions;
          refreshActiveModel();
        }
      } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        if (u.toolCallId) {
          toolCalls.set(u.toolCallId, { ...(toolCalls.get(u.toolCallId) || {}), ...u });
        }
      } else if (u.sessionUpdate === 'usage_update') {
        const parsed = acpUsage(u.usage || u._meta?.usage || u);
        if (parsed) lastUsage = u.usage || u._meta?.usage || u;
      }
    },
    onRequest(method, params) {
      if (method === 'session/request_permission') {
        const tcId = params?.toolCall?.toolCallId;
        const prev = tcId ? toolCalls.get(tcId) : null;
        const mergedToolCall = { ...(prev || {}), ...(params?.toolCall || {}) };
        return acpPermissionResponse({ ...params, toolCall: mergedToolCall }, { allowWeb: webSearch, allowTool });
      }
      const missing = new Error('Method not found');
      missing.rpcCode = -32601;
      throw missing;
    },
    onTimeout() {
      if (sessionId) client?.notify('session/cancel', { sessionId });
    },
  });

  try {
    const initResult = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo,
    });

    const sessionParams = {
      cwd,
      mcpServers: [],
      ...(sessionMeta ? { _meta: sessionMeta } : {}),
    };
    const session = await client.request('session/new', sessionParams);
    sessionId = session?.sessionId || null;
    if (!sessionId) throw new Error('ACP session/new returned no sessionId');

    configOptions = Array.isArray(session.configOptions) ? session.configOptions : null;
    activeModel = findConfigOption(configOptions, 'model')?.currentValue || session.models?.currentModelId || null;

    const requestedModel = String(model || '').trim();
    const hasExplicitModel = Boolean(requestedModel && requestedModel !== 'default');
    let desiredEffort = String(effort || '').trim().toLowerCase() || null;
    const resolved = typeof resolveModel === 'function'
      ? resolveModel(model, effort)
      : { model: hasExplicitModel ? requestedModel : null, effort: desiredEffort };

    if (hasExplicitModel) {
      const mRes = await setSessionModel({
        client,
        sessionId,
        getConfigOptions: () => configOptions,
        setConfigOptions: (next) => { configOptions = next; },
        requestedModel,
        resolved,
      });
      activeModel = mRes.activeModel;
      if (mRes.overrideEffort) desiredEffort = mRes.overrideEffort;
      else if (mRes.clearEffort) desiredEffort = null;
    }

    if (desiredEffort) {
      await setSessionEffort({
        client,
        sessionId,
        getConfigOptions: () => configOptions,
        setConfigOptions: (next) => { configOptions = next; },
        desiredEffort,
        fallbackEffort,
      });
    }

    collecting = true;
    const promptRes = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: String(prompt ?? '') }],
    });
    refreshActiveModel();
    const rawUsage = promptRes?.usage || promptRes?._meta?.usage || lastUsage || null;

    return {
      text: chunks.join(''),
      stopReason: promptRes?.stopReason || null,
      model: activeModel,
      usage: acpUsage(rawUsage),
      configOptions,
      initResult,
    };
  } finally {
    await client.close();
  }
}
