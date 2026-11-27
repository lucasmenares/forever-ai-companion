// AI providers. Each returns { text, model }.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flattenPrompt } from './prompt.js';
import { findClaudeCode, spawnArgs } from './claude-code.js';
import { err, t } from './i18n.js';
import {
  CODEX_DISABLE, CODEX_MODELS, CODEX_MUST_DISABLE, codexArgs, codexAuthStatus, findCodex, friendlyCodexError, parseCodexEvents,
  rejectedCodexFeatures, shellQuote,
} from './codex.js';
import { runAcpPrompt } from './acp.js';
import {
  ANTIGRAVITY_NOTE, antigravityAcpArgs, antigravityAuthStatus, fallbackAntigravityEffort, findAntigravity,
  friendlyAntigravityError, isAntigravityAuthError, prettyAntigravityModel, resolveAntigravityModel,
} from './antigravity.js';

// Tokens an answer used, the same shape for every provider (shown in the game):
// input = everything the AI read (including what came from the cache),
// cached = the part of input read from the cache, output = what it wrote.
export function tokenUsage(input = 0, cached = 0, output = 0) {
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  return { input: n(input), cached: n(cached), output: n(output) };
}

function addUsage(total, u) {
  return total ? tokenUsage(total.input + u.input, total.cached + u.cached, total.output + u.output) : u;
}

// Claude Code's JSON result: modelUsage adds up every model call of the
// question (web searches included).
export function claudeCodeUsage(json) {
  const models = Object.values(json?.modelUsage || {});
  if (models.length) {
    return models.reduce((t, m) => addUsage(t, tokenUsage(
      (m.inputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0),
      m.cacheReadInputTokens, m.outputTokens,
    )), null);
  }
  const u = json?.usage;
  if (!u) return null;
  return tokenUsage((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), u.cache_read_input_tokens, u.output_tokens);
}

// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// Providers that can search the web (WoW Forever is newer than the models).
export function canSearch(cfg) {
  return cfg.webSearch !== false && ['claude-code', 'anthropic', 'codex', 'antigravity'].includes(cfg.provider);
}

// Server-side web tools for the Claude API. The newest variants (dynamic
// filtering) need Opus/Sonnet 4.6 or later; Haiku uses the basic web search.
export function anthropicWebTools(model) {
  if (/haiku/.test(model)) return [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
  return [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2 },
  ];
}

async function anthropic(cfg, system, messages) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const c = cfg.anthropic;
  const client = new Anthropic(c.apiKey ? { apiKey: c.apiKey } : {});
  const params = {
    model: c.model,
    max_tokens: c.maxTokens,
    // Stable prefix (rules + server knowledge) first so it can be cached.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: { effort: c.effort },
  };
  if (canSearch(cfg)) params.tools = anthropicWebTools(c.model);
  const send = (p) => (c.fallbacks && FALLBACK_MODELS.has(c.model)
    ? client.beta.messages.create({ ...p, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { timeout: cfg.timeoutMs })
    : client.messages.create(p, { timeout: cfg.timeoutMs }));
  let response;
  let usage = null;
  const count = (r) => {
    const u = r?.usage;
    if (!u) return;
    const cached = u.cache_read_input_tokens || 0;
    usage = addUsage(usage, tokenUsage((u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0), cached, u.output_tokens));
  };
  try {
    response = await send(params);
    count(response);
    // A long web search can pause the turn: send it back and the server resumes.
    for (let i = 0; i < 3 && response.stop_reason === 'pause_turn'; i++) {
      response = await send({ ...params, messages: [...messages, { role: 'assistant', content: response.content }] });
      count(response);
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw err('claudeBadKey');
    } else if (error instanceof Anthropic.PermissionDeniedError) {
      throw err('claudeNoPermission');
    } else if (error instanceof Anthropic.RateLimitError) {
      throw err('apiRateLimit');
    } else if (error instanceof Anthropic.BadRequestError) {
      throw err('apiRejected', { error: error.message });
    } else if (error instanceof Anthropic.APIError) {
      throw err('anthropicError', { status: error.status ?? 'network', error: error.message });
    }
    throw error;
  }
  if (response.stop_reason === 'refusal') {
    throw err('refused');
  }
  // With web search the answer comes in several text blocks (one per citation).
  let text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (response.stop_reason === 'max_tokens') text += ' [...]';
  return { text, model: response.model, usage };
}

// Waits between tries when the provider is overloaded (503) or hiccups (500).
export const BUSY_RETRY_MS = [2000, 5000];

async function openaiCompatible(cfg, system, messages) {
  const c = cfg.openai;
  const key = c.apiKey || (c.apiKeyEnv && process.env[c.apiKeyEnv]);
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  const send = () => fetch(`${c.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ ...(c.params || {}), model: c.model, messages: [{ role: 'system', content: system }, ...messages] }),
    signal,
  });
  let res = await send();
  for (const wait of cfg.busyRetryMs ?? BUSY_RETRY_MS) {
    if (res.status !== 503 && res.status !== 500) break;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, wait));
    res = await send();
  }
  if (res.status === 503) throw err('apiBusy');
  const failure = res.ok ? '' : await res.text();
  // No credit left (xAI answers 403, OpenAI 429 "insufficient_quota"): not a wrong key.
  if ([402, 403, 429].includes(res.status) && /credit|insufficient_quota|spending limit|billing/i.test(failure)) throw err('apiNoCredit');
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api[_ ]?key/i.test(failure))) {
    throw err('badKey');
  }
  if (res.status === 429) throw err('apiRateLimit');
  // The provider retired the model (Gemini: "models/x is no longer available").
  if (res.status === 404 && /model/i.test(failure)) throw err('modelGone', { model: c.model });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${failure.slice(0, 300)}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw err('noText');
  return { text, model: json.model || c.model, usage: openaiUsage(json.usage) };
}

// OpenAI counts reasoning inside completion_tokens; xAI (Grok) doesn't, but
// bills it, and its total_tokens includes it: output = total - prompt.
export function openaiUsage(u) {
  if (!u) return null;
  const output = Math.max(u.completion_tokens || 0, (u.total_tokens || 0) - (u.prompt_tokens || 0));
  return tokenUsage(u.prompt_tokens, u.prompt_tokens_details?.cached_tokens, output);
}

function run(bin, args, input, timeoutMs, cwd, shell = process.platform === 'win32', env = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, shell, windowsHide: true, ...(env ? { env } : {}) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(err('tooSlow', { bin }));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(err('cannotRun', { bin, error: e.message }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const e = err('exitCode', { bin, code, output: (stderr || stdout).slice(0, 300) });
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
      }
    });
    child.stdin.end(input);
  });
}

// An empty working folder so CLI agents have nothing local to read or edit.
export function sandboxDir() {
  const dir = path.join(os.tmpdir(), 'forever-ai-companion-cli');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Arguments for `claude -p` so it behaves as a plain chat model, not as a
// coding agent: our own system prompt instead of Claude Code's (which alone
// is ~38k tokens of the plan's limit per question), no tools, no MCP servers,
// no user/project settings, skills or CLAUDE.md, and nothing saved to
// ~/.claude/projects.
export function claudeCodeArgs(c, systemFile, shell, { webSearch = false } = {}) {
  const empty = shell ? '""' : '';
  // Web search only (no files, no commands), allowed without asking.
  const tools = webSearch ? ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'] : ['--tools', empty];
  const args = [
    '-p', '--output-format', 'json',
    '--system-prompt-file', systemFile,
    '--no-session-persistence',
    ...tools,
    '--strict-mcp-config',
    '--setting-sources', empty,
    '--disable-slash-commands',
  ];
  if (c.model && c.model !== 'default') args.push('--model', c.model);
  if (c.effort) args.push('--effort', c.effort);
  args.push(...(c.extraArgs || []));
  return args;
}

// "claude-sonnet-5-5" -> "Claude Sonnet 5.5"
function prettyModel(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id || '');
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

// Claude Code CLI: uses the account you are logged into (Pro/Max subscription).
async function claudeCode(cfg, system, messages) {
  const c = cfg.claudeCode;
  const found = findClaudeCode(c.bin);
  if (!found) {
    throw err('claudeMissing');
  }
  const { file, shell } = spawnArgs(found.path);
  // The system prompt goes in a file: with the server knowledge it can be far
  // longer than a Windows command line allows.
  const systemFile = path.join(sandboxDir(), `system-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(systemFile, system);
  const args = claudeCodeArgs(c, systemFile, shell, { webSearch: canSearch(cfg) });
  let out;
  try {
    out = await run(file, args, flattenPrompt(null, messages), cfg.timeoutMs, sandboxDir(), shell);
  } catch (e) {
    // claude -p exits with 1 on errors but still prints its JSON result.
    out = e.stdout;
    if (!out) throw e;
  } finally {
    fs.rmSync(systemFile, { force: true });
  }
  let json;
  try {
    json = JSON.parse(out);
  } catch {
    throw err('claudeUnexpected', { output: String(out).slice(0, 200) });
  }
  if (json.is_error) {
    if (/not logged in|\/login/i.test(json.result || '')) {
      throw err('claudeSignedOut');
    }
    throw err('claudeError', { error: json.result || 'error' });
  }
  const used = Object.keys(json.modelUsage || {})[0];
  return {
    text: json.result,
    model: used ? `${prettyModel(used)} · ${t('yourSubscription')}` : t('yourClaudeSubscription'),
    usage: claudeCodeUsage(json),
  };
}

// A newer Codex may no longer know a feature we turn off, and rejects the
// whole call. Only the feature it names is dropped and the call retried; one
// of CODEX_MUST_DISABLE, or an error that names nothing we sent, fails closed.
export async function callWithoutFeatures(call, disable = CODEX_DISABLE) {
  let list = [...disable];
  for (;;) {
    try {
      return await call(list);
    } catch (e) {
      const named = rejectedCodexFeatures(`${e.stderr || ''} ${e.message}`);
      if (!named) throw e;
      const unsafe = named.find((f) => CODEX_MUST_DISABLE.includes(f)) || (named.some((f) => list.includes(f)) ? null : named[0] || '?');
      if (unsafe) {
        const failure = err('codexUnsafe', { feature: unsafe });
        failure.stdout = '';
        throw failure;
      }
      list = list.filter((f) => !named.includes(f));
    }
  }
}

// Codex only: it still offers its agent tools, so say they are not for this.
const CODEX_NOTE = `## Tools
Do not run commands or read or write files: nothing on this PC helps answer. Answer directly from the character data, the guide and, if allowed above, a web search.`;

let codexLogin = { ok: false, at: 0 };

// Codex CLI: uses the ChatGPT Plus / Pro plan you are signed into.
async function codex(cfg, system, messages) {
  const c = cfg.codex;
  const found = findCodex(c.bin);
  if (!found) {
    throw err('codexMissing');
  }
  // Signed out, Codex retries for ~30 s before failing: check first (cheap, local).
  if (!codexLogin.ok || Date.now() - codexLogin.at > 10 * 60000) {
    const s = await codexAuthStatus(found.path);
    if (!s.loggedIn) throw new Error(friendlyCodexError('not logged in'));
    codexLogin = { ok: true, at: Date.now() };
  }
  const { file, shell } = spawnArgs(found.path);
  const work = sandboxDir();
  const stamp = `${process.pid}-${Date.now()}`;
  const instructionsFile = path.join(work, `codex-system-${stamp}.txt`);
  const outFile = path.join(work, `codex-answer-${stamp}.txt`);
  fs.writeFileSync(instructionsFile, `${system}\n\n${CODEX_NOTE}`);
  const call = (disable) => {
    const args = codexArgs(c, { instructionsFile, outFile, workDir: work, webSearch: canSearch(cfg), disable });
    return run(file, shell ? shellQuote(args) : args, flattenPrompt(null, messages), cfg.timeoutMs, work, shell);
  };
  let out;
  try {
    out = await callWithoutFeatures(call);
  } catch (e) {
    out = e.stdout;
    const parsed = parseCodexEvents(out);
    if (parsed.error) {
      if (/401|unauthori[sz]ed/i.test(parsed.error)) codexLogin = { ok: false, at: 0 };
      throw new Error(friendlyCodexError(parsed.error));
    }
    throw e;
  } finally {
    fs.rmSync(instructionsFile, { force: true });
  }
  const parsed = parseCodexEvents(out);
  let text = parsed.text;
  try { text = fs.readFileSync(outFile, 'utf8') || text; } catch { /* use the event stream */ }
  fs.rmSync(outFile, { force: true });
  if (!text.trim()) throw new Error(parsed.error ? friendlyCodexError(parsed.error) : t('codexNoAnswer'));
  const name = CODEX_MODELS[c.model];
  const u = parsed.usage;
  return {
    text,
    model: `${name || 'ChatGPT'} · ${t('yourSubscription')}`,
    usage: u ? tokenUsage(u.input_tokens, u.cached_input_tokens, u.output_tokens) : null,
  };
}

let antigravityLogin = { ok: false, at: 0, bin: null };

// Antigravity CLI (`agy`): uses the Google account / Google AI plan you are signed into via ACP.
async function antigravity(cfg, system, messages) {
  const c = cfg.antigravity;
  const found = findAntigravity(c.bin);
  if (!found) {
    throw err('antigravityMissing');
  }
  // Signed out, `agy` waits 60s for interactive OAuth: check first (`agy models` fails in <1s).
  if (!antigravityLogin.ok || antigravityLogin.bin !== found.path || Date.now() - antigravityLogin.at > 10 * 60000) {
    const s = await antigravityAuthStatus(found.path);
    if (!s.loggedIn && !s.error) throw new Error(friendlyAntigravityError('not signed in'));
    if (s.loggedIn) antigravityLogin = { ok: true, at: Date.now(), bin: found.path };
  }
  const prompt = flattenPrompt(`${system}\n\n${ANTIGRAVITY_NOTE}`, messages);
  const env = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };

  let result;
  try {
    result = await runAcpPrompt({
      bin: found.path,
      args: antigravityAcpArgs(c),
      cwd: sandboxDir(),
      env,
      clientInfo: { name: 'forever-ai-companion', version: '1.13.0' },
      prompt,
      model: c.model,
      effort: c.effort,
      webSearch: canSearch(cfg),
      resolveModel: resolveAntigravityModel,
      fallbackEffort: fallbackAntigravityEffort,
      timeoutMs: cfg.timeoutMs,
    });
  } catch (e) {
    if (e?.code === 'ACP_TIMEOUT' || e?.code === 'ACP_SPAWN_ERROR') throw e;
    if (isAntigravityAuthError(e)) antigravityLogin = { ok: false, at: 0, bin: null };
    throw new Error(friendlyAntigravityError(e?.message || String(e)));
  }

  if (result.stopReason === 'refusal' && !result.text.trim()) {
    throw err('refused');
  }
  let text = result.text;
  if (result.stopReason === 'max_tokens' && text.trim()) {
    text += ' [...]';
  }
  if (!text.trim()) throw err('antigravityNoAnswer');
  const name = prettyAntigravityModel(result.model || c.model);
  return {
    text,
    model: `${name || 'Gemini'} · ${t('yourSubscription')}`,
    usage: result.usage,
  };
}

// No AI: echoes what arrived. Use it to test the in-game round trip for free.
async function echo(cfg, system, messages, req) {
  const ctx = req.context || {};
  const ch = ctx.character || {};
  const pos = ctx.position || {};
  const coords = pos.x != null ? ` (${pos.x}, ${pos.y})` : '';
  return {
    model: 'echo',
    text: [
      t('echoIntro'),
      t('echoQuestion', { q: req.question }),
      t('echoCharacter', { name: ch.name ?? '?', race: ch.race ?? '?', cls: ch.class ?? '?', level: ch.level ?? '?' }),
      t('echoPosition', { where: `${pos.zone ?? '?'}${pos.subzone ? ' - ' + pos.subzone : ''}${coords}` }),
      t('echoCounts', { gear: (ctx.gear || []).length, quests: (ctx.quests || []).length }),
      t('echoPick'),
    ].join('\n'),
  };
}

const PROVIDERS = { anthropic, openai: openaiCompatible, 'claude-code': claudeCode, codex, antigravity, echo };

export async function ask(cfg, system, messages, req) {
  const fn = PROVIDERS[cfg.provider];
  if (!fn) throw new Error(`Unknown provider "${cfg.provider}". Use: ${Object.keys(PROVIDERS).join(', ')}`);
  return fn(cfg, system, messages, req);
}
