// Generic ACP client tests: usage normalization, config selectors, SSRF-safe
// tool permission filtering, and stdio JSON-RPC lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acpPermissionResponse, acpUsage, findConfigOption, flattenConfigOptions, isPublicHttpUrl, isWebLookupTool,
  pickFallbackEffort, runAcpPrompt,
} from '../src/acp.js';

const PERM_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
];

test('acpUsage normalizes camelCase, Claude uncached input, and legacy snake_case usage', () => {
  assert.deepEqual(
    acpUsage({ inputTokens: 10415, outputTokens: 657, thoughtTokens: 616, cachedReadTokens: 8113, totalTokens: 11072 }),
    { input: 10415, cached: 8113, output: 657 },
  );
  // Claude-style uncached inputTokens (< cachedReadTokens) plus thoughtTokens > outputTokens.
  assert.deepEqual(
    acpUsage({ inputTokens: 278, outputTokens: 4, thoughtTokens: 12, cachedReadTokens: 30214, cachedWriteTokens: 100 }),
    { input: 30592, cached: 30214, output: 12 },
  );
  assert.deepEqual(
    acpUsage({ input_tokens: 120, output_tokens: 15, thinking_tokens: 5, cache_read_tokens: 40 }),
    { input: 120, cached: 40, output: 15 },
  );
  assert.equal(acpUsage(null), null);
  assert.equal(acpUsage({}), null);
});

test('config option helpers flatten groups, locate selectors, and choose effort fallbacks', () => {
  const flat = flattenConfigOptions([
    { value: 'low', name: 'Low' },
    { group: 'advanced', name: 'Advanced', options: [{ value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra' }] },
  ]);
  assert.deepEqual(flat.map((o) => o.value), ['low', 'high', 'xhigh']);

  const cfgOpts = [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [] },
    { id: 'model_select', name: 'Model', category: 'model', type: 'select', currentValue: 'a', options: [] },
    { id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: 'medium', options: [] },
  ];
  assert.equal(findConfigOption(cfgOpts, 'model')?.id, 'model_select');
  assert.equal(findConfigOption(cfgOpts, 'thought_level')?.id, 'reasoning_effort');

  assert.equal(pickFallbackEffort(['medium', 'high'], 'low'), 'medium');
  assert.equal(pickFallbackEffort(['low', 'medium', 'high'], 'max'), 'low');
  assert.equal(pickFallbackEffort(['high'], 'low'), 'high');
  assert.equal(pickFallbackEffort([], 'low'), null);
});

test('isPublicHttpUrl blocks private, loopback, link-local and non-HTTP URLs', () => {
  assert.equal(isPublicHttpUrl('https://www.wowhead.com/forever/guide/deadmines'), true);
  assert.equal(isPublicHttpUrl('http://example.com/path?q=1'), true);
  assert.equal(isPublicHttpUrl('http://127.0.0.1:47365/api/status'), false);
  assert.equal(isPublicHttpUrl('http://localhost:8080/'), false);
  assert.equal(isPublicHttpUrl('http://sub.localhost/'), false);
  assert.equal(isPublicHttpUrl('http://myhost.local/'), false);
  assert.equal(isPublicHttpUrl('http://[::1]:3000/'), false);
  assert.equal(isPublicHttpUrl('http://[::ffff:127.0.0.1]/'), false);
  assert.equal(isPublicHttpUrl('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isPublicHttpUrl('http://10.0.0.1/'), false);
  assert.equal(isPublicHttpUrl('http://172.16.0.1/'), false);
  assert.equal(isPublicHttpUrl('http://192.168.1.1/'), false);
  assert.equal(isPublicHttpUrl('file:///etc/passwd'), false);
  assert.equal(isPublicHttpUrl('not a url'), false);
});

test('acpPermissionResponse enforces allowWeb and fail-closed tool safety rules', () => {
  const webFetch = {
    toolCallId: 'tc1',
    kind: 'fetch',
    name: 'read_url_content',
    title: 'Read URL content from https://www.wowhead.com/forever/guide/deadmines',
    rawInput: { Url: 'https://www.wowhead.com/forever/guide/deadmines' },
  };
  const webSearch = {
    toolCallId: 'tc2',
    kind: 'search',
    name: 'search_web',
    title: 'Search the web: Deadmines WoW Forever',
    rawInput: { query: 'Deadmines WoW Forever' },
  };
  const localCmd = { toolCallId: 'tc3', kind: 'execute', title: 'Run ls', rawInput: { CommandLine: 'ls' } };
  const localRead = { toolCallId: 'tc4', kind: 'read', title: 'Read config.json', locations: [{ path: 'C:\\config.json' }] };
  const localEdit = { toolCallId: 'tc5', kind: 'edit', title: 'Edit file' };
  const localDelete = { toolCallId: 'tc6', kind: 'delete', title: 'Delete file' };
  const localGrep = { toolCallId: 'tc7', kind: 'search', title: 'Grep "secret" in /', rawInput: { DirectoryPath: '/' } };
  const localFind = { toolCallId: 'tc8', kind: 'search', title: 'Files named *.js', rawInput: { Pattern: '*.js' } };
  const browserTool = { toolCallId: 'tc9', kind: 'fetch', name: 'browser_subagent', title: 'Open browser' };
  const execUrlTool = { toolCallId: 'tc10', kind: 'fetch', name: 'execute_url', title: 'Execute URL' };
  const mcpTool = { toolCallId: 'tc11', kind: 'other', name: 'mcp_server_fetch', title: 'Calling MCP tool' };
  const ssrfFetch = {
    toolCallId: 'tc12',
    kind: 'fetch',
    name: 'read_url_content',
    title: 'Fetch http://127.0.0.1:47365/api/status',
    rawInput: { Url: 'http://127.0.0.1:47365/api/status' },
  };
  const fileUriFetch = {
    toolCallId: 'tc13',
    kind: 'fetch',
    name: 'web_fetch',
    rawInput: { url: 'file:///etc/passwd' },
  };

  // With allowWeb: false, everything is rejected.
  for (const tc of [webFetch, webSearch, localCmd, localRead, localEdit]) {
    assert.deepEqual(
      acpPermissionResponse({ toolCall: tc, options: PERM_OPTIONS }, { allowWeb: false }),
      { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    );
  }

  // With allowWeb: true, only read-only public web search/fetch are allowed.
  assert.equal(isWebLookupTool(webFetch), true);
  assert.equal(isWebLookupTool(webSearch), true);
  assert.deepEqual(
    acpPermissionResponse({ toolCall: webFetch, options: PERM_OPTIONS }, { allowWeb: true }),
    { outcome: { outcome: 'selected', optionId: 'allow-once' } },
  );
  assert.deepEqual(
    acpPermissionResponse({ toolCall: webSearch, options: PERM_OPTIONS }, { allowWeb: true }),
    { outcome: { outcome: 'selected', optionId: 'allow-once' } },
  );

  for (const denied of [localCmd, localRead, localEdit, localDelete, localGrep, localFind, browserTool, execUrlTool, mcpTool, ssrfFetch, fileUriFetch]) {
    assert.equal(isWebLookupTool(denied), false, denied.title || denied.name);
    assert.deepEqual(
      acpPermissionResponse({ toolCall: denied, options: PERM_OPTIONS }, { allowWeb: true }),
      { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    );
  }

  // Fallback when reject_once is missing -> reject_always; when no options -> cancelled.
  assert.deepEqual(
    acpPermissionResponse({ toolCall: localCmd, options: [{ optionId: 'no-always', name: 'No', kind: 'reject_always' }] }, { allowWeb: true }),
    { outcome: { outcome: 'selected', optionId: 'no-always' } },
  );
  assert.deepEqual(
    acpPermissionResponse({ toolCall: localCmd, options: [] }, { allowWeb: true }),
    { outcome: { outcome: 'cancelled' } },
  );
});

const FAKE_GENERIC_ACP = `
import fs from 'node:fs';
const logFile = process.env.FAKE_ACP_TEST_LOG;
const mode = process.env.FAKE_ACP_TEST_MODE || 'standard';
const record = (entry) => {
  const prev = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
  prev.push(entry);
  fs.writeFileSync(logFile, JSON.stringify(prev));
};

let buf = '';
let nextReqId = 100;
const pendingClient = new Map();
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const callClient = (method, params) => new Promise((resolve) => {
  const id = nextReqId++;
  pendingClient.set(id, resolve);
  send({ jsonrpc: '2.0', id, method, params });
});

process.stdin.on('data', async (chunk) => {
  buf += String(chunk);
  const lines = buf.split(/\\r?\\n/);
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && !msg.method && pendingClient.has(msg.id)) {
      const done = pendingClient.get(msg.id);
      pendingClient.delete(msg.id);
      done(msg);
      continue;
    }
    record({ method: msg.method, params: msg.params });
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'FakeACP', version: '1.0' } } });
    } else if (msg.method === 'session/new') {
      if (mode === 'legacy') {
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-legacy', models: { currentModelId: 'default-model', availableModels: [] } } });
      } else {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 's-1',
            configOptions: [
              { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm-default', options: [{ value: 'm-default', name: 'Default' }, { value: 'm-fast', name: 'Fast' }] },
              { id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] },
            ],
          },
        });
      }
    } else if (msg.method === 'session/set_config_option') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          configOptions: [
            { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: msg.params.configId === 'model' ? msg.params.value : 'm-fast', options: [{ value: 'm-default', name: 'Default' }, { value: 'm-fast', name: 'Fast' }] },
            { id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: msg.params.configId === 'thought_level' ? msg.params.value : 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] },
          ],
        },
      });
    } else if (msg.method === 'session/set_model') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'session/prompt') {
      if (mode === 'hang') continue;
      // Split metadata: tool_call announces kind/rawInput, permission request omits them.
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-web',
            kind: 'fetch',
            name: 'read_url_content',
            title: 'Read URL content from https://example.com',
            rawInput: { Url: 'https://example.com' },
          },
        },
      });
      const webPerm = await callClient('session/request_permission', {
        sessionId: msg.params.sessionId,
        toolCall: { toolCallId: 'tc-web', title: 'Read URL content from https://example.com' },
        options: [
          { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const fsResp = await callClient('fs/read_text_file', { sessionId: msg.params.sessionId, path: 'secret.txt' });
      record({ permDecision: webPerm.result, fsError: fsResp.error });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echoed user' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'secret thought' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world.' } } } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10, cachedReadTokens: 20, totalTokens: 60 } } });
    }
  }
});
`;

test('runAcpPrompt executes full ACP lifecycle, merges tool_call context, and cleans up on timeout', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-acp-test-'));
  const script = path.join(dir, 'fake-acp.mjs');
  const logFile = path.join(dir, 'calls.json');
  fs.writeFileSync(script, FAKE_GENERIC_ACP);
  process.env.FAKE_ACP_TEST_LOG = logFile;
  t.after(() => {
    delete process.env.FAKE_ACP_TEST_LOG;
    delete process.env.FAKE_ACP_TEST_MODE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 1. Standard configOptions flow + permission merging + ignoring thoughts + rejecting fs/*.
  const r1 = await runAcpPrompt({
    bin: process.execPath,
    args: [script],
    cwd: dir,
    prompt: 'Hi',
    model: 'm-fast',
    effort: 'low',
    webSearch: true,
    timeoutMs: 10000,
  });
  assert.equal(r1.text, 'Hello world.');
  assert.equal(r1.model, 'm-fast');
  assert.equal(r1.stopReason, 'end_turn');
  assert.deepEqual(r1.usage, { input: 50, cached: 20, output: 10 });

  const calls1 = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.deepEqual(calls1[0], {
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'forever-ai-companion', version: 'unknown' } },
  });
  assert.deepEqual(calls1[1], { method: 'session/new', params: { cwd: dir, mcpServers: [] } });
  assert.deepEqual(calls1[2], { method: 'session/set_config_option', params: { sessionId: 's-1', configId: 'model', value: 'm-fast' } });
  assert.deepEqual(calls1[3], { method: 'session/set_config_option', params: { sessionId: 's-1', configId: 'thought_level', value: 'low' } });
  assert.deepEqual(calls1[5].permDecision, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
  assert.equal(calls1[5].fsError.code, -32601);

  // 2. Legacy server without configOptions falls back to session/set_model.
  fs.writeFileSync(logFile, '[]');
  process.env.FAKE_ACP_TEST_MODE = 'legacy';
  const r2 = await runAcpPrompt({
    bin: process.execPath,
    args: [script],
    cwd: dir,
    prompt: 'Hi',
    model: 'legacy-m',
    effort: 'low',
    webSearch: false,
    timeoutMs: 10000,
  });
  assert.equal(r2.model, 'legacy-m');
  const calls2 = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.ok(calls2.some((c) => c.method === 'session/set_model' && c.params.modelId === 'legacy-m'));
  assert.deepEqual(calls2.find((c) => c.permDecision)?.permDecision, { outcome: { outcome: 'selected', optionId: 'reject-once' } });

  // 3. Timeout sends session/cancel and rejects with ACP_TIMEOUT.
  fs.writeFileSync(logFile, '[]');
  process.env.FAKE_ACP_TEST_MODE = 'hang';
  await assert.rejects(
    runAcpPrompt({ bin: process.execPath, args: [script], cwd: dir, prompt: 'Hi', timeoutMs: 250 }),
    (e) => e?.code === 'ACP_TIMEOUT',
  );
  const calls3 = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.ok(calls3.some((c) => c.method === 'session/cancel' && c.params.sessionId === 's-1'));
});
