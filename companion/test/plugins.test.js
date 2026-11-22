// Plugins: another addon asking the app through ours. The addon's side
// (Plugins.lua, with the real Core.lua, Voice.lua and Uplink.lua) builds and
// "speaks" a request; the app's side (watcher.handlePluginRequest, plugins.js)
// answers it with data; and the addon hands that data to the plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, wowPaths } from '../src/config.js';
import { install } from '../src/install.js';
import { handlePluginRequest, parseRequest } from '../src/watcher.js';
import { createAssembler } from '../src/voice-inbox.js';
import { KEEP_DATA, inboxSource, withoutOldData } from '../src/inbox.js';
import { createPlugins } from '../src/plugins.js';
import { runLua } from './helpers.js';

const FILES = ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Plugins.lua', 'Core.lua'];

// The game, as far as these files need it: frames that keep their scripts,
// a silent voice that records what is spoken, and a clock the test moves.
const GAME = `
  GetLocale = function() return "enUS" end
  NOW = 1700000000
  time = function() return NOW end
  date = os.date
  GetTime = function() return 1000 end
  strtrim = function(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
  SlashCmdList = {}
  FRAMES = {}
  CreateFrame = function()
    local f = { scripts = {} }
    function f:RegisterEvent() end
    function f:SetScript(name, fn) self.scripts[name] = fn end
    FRAMES[#FRAMES + 1] = f
    return f
  end
  -- Runs every frame's OnUpdate until none is left (a request being prepared).
  function PUMP()
    for _ = 1, 200 do
      local busy = false
      for _, f in ipairs(FRAMES) do
        if f.scripts.OnUpdate then busy = true; f.scripts.OnUpdate(f, 0.016) end
      end
      if not busy then return end
    end
    error("still preparing after 200 frames")
  end
  UnitGUID = function() return "Player-1-00ABCDEF" end
  UnitName = function() return "Thora" end
  UnitLevel = function() return 14 end
  UnitClass = function() return "Warrior", "WARRIOR" end
  GetRealmName = function() return "Stormrage" end
  SPOKEN = {}
  C_VoiceChat = {
    GetTtsVoices = function() return { { voiceID = 7, name = "ForeverAICompanion" } } end,
    SpeakText = function(voiceID, text) SPOKEN[#SPOKEN + 1] = text end,
  }
`;

// Stand-ins for the parts of the addon these tests don't load.
const ADDON = `
  ns.db = {}
  SENT = {}
  ns.Live = {
    RequestFields = function() return 3, nil end,
    OnSent = function(_, slow) SENT[#SENT + 1] = slow and "slow" or "fast" end,
    OnAnswer = function() ANSWERED = (ANSWERED or 0) + 1 end,
    AppState = function() return "ready" end,
    CheckApp = function() CHECKED = true end,
  }
  ns.Chats = { EachEntry = function() end, FindEntry = function() end }
  ns.UI = { SetStatus = function() end, Refresh = function() end, IsShown = function() return false end }
  -- A plugin's own data: something bigger than a parameter.
  LIST = { title = "Shopping", items = { { name = "Linen Cloth", count = 20 }, { name = "Copper Bar", count = 6 } } }
  RESULTS = {}
  local API = ForeverAICompanionAPI
`;

const lua = (script, globals = {}) => runLua(ADDON + script, globals, FILES, GAME);

const tempWow = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-plugin-'));
  fs.mkdirSync(path.join(dir, 'Interface', 'AddOns'), { recursive: true });
  return dir;
};

// What the app's voice inbox makes of the spoken messages: the request.
function heard(spoken) {
  const assembler = createAssembler();
  let payload = null;
  for (const text of spoken) payload = assembler.add(text) || payload;
  assert.ok(payload, 'the spoken parts make a complete frame');
  return parseRequest(payload);
}

// The app's side of a plugin: counts what its addon sent.
const demo = {
  name: 'demo',
  async handle(req, env) {
    if (req.ext.kind === 'fail') throw new Error('No list arrived.');
    const list = req.context.demo_list;
    if (!list) throw new Error('No list arrived.');
    return {
      text: `**${list.title}**: ${list.items.length} items.`,
      data: { kind: req.ext.kind, title: list.title, names: list.items.map((i) => i.name), asked: req.ext.input, lang: env.lang },
      model: 'demo',
      usage: { input: 40, cached: 10, output: 5 },
    };
  },
};

test('the public API is there, and bad requests are refused before anything is sent', () => {
  const out = JSON.parse(lua(`
    local r = {}
    r.version = API.VERSION
    r.functions = {}
    for _, name in ipairs({ "Register", "Request", "Cancel", "Pending", "Busy", "AppState", "WatchApp", "CanSendLarge", "DescribeItem", "AuctionPrice" }) do
      r.functions[#r.functions + 1] = type(API[name])
    end
    local function refused(...)
      local id, why = API.Request(...)
      return { id = id, why = why }
    end
    r.badName = refused("Demo!", { kind = "count" })
    r.badKind = refused("demo", { kind = "has space" })
    r.noKind = refused("demo", {})
    ns.Core.working = true
    r.busy = refused("demo", { kind = "count" })
    r.isBusy = API.Busy()
    ns.Core.working = false
    r.state = API.AppState()
    r.large = API.CanSendLarge()
    r.registered = API.Register("demo", { onResult = function() end })
    r.badRegister = API.Register("Bad Name", {})
    API.WatchApp("demo", true)
    r.watching = { ns.Plugins:Watching(), CHECKED }
    API.WatchApp("demo", false)
    r.stopped = ns.Plugins:Watching()
    r.spoken = #SPOKEN
    RESULT = ns.Json.Encode(r)`));
  assert.equal(out.version, 1);
  assert.deepEqual([...new Set(out.functions)], ['function']);
  assert.deepEqual(out.badName, { why: 'plugin name' });
  assert.deepEqual(out.badKind, { why: 'kind' });
  assert.deepEqual(out.noKind, { why: 'kind' });
  assert.equal(out.busy.id, undefined);
  assert.match(out.busy.why, /Wait a moment/);
  assert.equal(out.isBusy, true);
  assert.equal(out.state, 'ready');
  assert.equal(out.large, true);
  assert.equal(out.registered, true);
  assert.equal(out.badRegister, false);
  assert.deepEqual(out.watching, [true, true]);
  assert.equal(out.stopped, false);
  assert.equal(out.spoken, 0);
});

test('a plugin request travels like a question: with its own sections, and only the data it asked for', () => {
  const out = JSON.parse(lua(`
    local states = {}
    local id = API.Request("demo", {
      kind = "count", input = { sort = "name", limit = 5 }, summary = "  Count my |cffffffffshopping|r list  ",
      sections = { list = LIST, ["bad key!"] = 1 }, only = { "character", "client" },
      onStatus = function(state, detail) states[#states + 1] = { state, type(detail) == "table" and detail.channel or detail } end,
    })
    PUMP()
    RESULT = ns.Json.Encode({ id = id, spoken = SPOKEN, states = states, sent = SENT, working = ns.Core.working,
      pending = API.Pending("demo"), stored = ns.db.plugins.pending[id] })`));
  assert.match(out.id, /^\d{14}$/);
  assert.deepEqual(out.states, [['preparing'], ['sent', 'voice']]);
  assert.deepEqual(out.sent, ['slow'], 'the mailboxes are checked on the slow schedule');
  assert.equal(out.working, false);
  assert.equal(out.pending[out.id].kind, 'count');
  assert.equal(out.stored.viaVoice, true);
  assert.equal(typeof out.stored.sent.demo_list, 'number', 'the hash of what was sent is kept until the answer');

  const req = heard(out.spoken);
  assert.equal(req.id, out.id);
  assert.equal(req.question, 'Count my shopping list');
  assert.deepEqual(req.ext, { name: 'demo', kind: 'count', v: 1, input: { sort: 'name', limit: 5 } });
  assert.equal(req.charKey, 'Thora-Stormrage');
  assert.equal(req.sig, 3);
  assert.equal(req.lang, 'en');
  // Its own section under its own name, and only the sections asked for.
  assert.equal(req.context.demo_list.items[1].name, 'Copper Bar');
  assert.equal(req.context.character.name, 'Thora');
  assert.equal(req.context.position, undefined);
  assert.equal(req.context.gear, undefined);
  assert.deepEqual(Object.keys(req.context).filter((k) => k.startsWith('demo_')), ['demo_list']);
  assert.equal(typeof req.hashes.demo_list, 'number');
});

test('context = false sends just the plugin\'s data, and what the app has is not sent twice', () => {
  const out = JSON.parse(lua(`
    local first = API.Request("demo", { kind = "count", sections = { list = LIST }, context = false })
    PUMP()
    local a = SPOKEN
    SPOKEN = {}
    -- The app answered the first one: it has the section now.
    ns.Core:ApplyInbox({ answers = { { id = first, ok = true, answer = "ok", data = { count = 2 } } } })
    NOW = NOW + 5
    local second = API.Request("demo", { kind = "count", sections = { list = LIST }, context = false })
    PUMP()
    RESULT = ns.Json.Encode({ a = a, b = SPOKEN, answered = ANSWERED })`));
  const first = heard(out.a);
  assert.deepEqual(Object.keys(first.context).filter((k) => k !== 'diagnostics'), ['demo_list']);
  const second = heard(out.b);
  assert.equal(second.context.demo_list, undefined);
  assert.equal(second.same.demo_list, first.hashes.demo_list);
  assert.equal(out.answered, 1);
});

test('the answer reaches the plugin with its data; a late one too; an unregistered plugin gets it when it loads', () => {
  const out = JSON.parse(lua(`
    API.Register("demo", { onResult = function(r) RESULTS[#RESULTS + 1] = r end })
    local id = API.Request("demo", { kind = "count", context = false, timeout = 60 })
    PUMP()
    local r = { pendingBefore = ns.Core:HasPending() }
    -- An answer for someone else changes nothing.
    ns.Core:ApplyInbox({ answers = { { id = "other", ok = true, answer = "x" } } })
    r.afterOther = #RESULTS
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "Two items.", model = "demo", tokens = { i = 10, c = 2, o = 3 },
      data = { kind = "count", names = { "Linen Cloth", "Copper Bar" } } } } })
    r.first = RESULTS[1]
    r.pendingAfter = ns.Core:HasPending()
    -- The same mailbox read again: delivered once.
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "Two items." } } })
    r.count = #RESULTS

    -- No answer in time: the plugin is told, and the late answer still arrives.
    NOW = NOW + 10
    local slow = API.Request("demo", { kind = "report", context = false, timeout = 60 })
    PUMP()
    NOW = NOW + 61
    r.stillPending = ns.Core:HasPending()
    r.timedOut = RESULTS[2]
    r.awaitingLate = ns.Plugins:AwaitingLate()
    r.listening = { ns.Plugins:ListeningLate(), ns.Plugins:ListeningLate(NOW + 1000) }
    ns.Core:ApplyInbox({ answers = { { id = slow, ok = true, answer = "late", data = { kind = "report" } } } })
    r.late = RESULTS[3]

    -- An answer whose data the app no longer keeps.
    NOW = NOW + 10
    local old = API.Request("demo", { kind = "report", context = false })
    PUMP()
    ns.Core:ApplyInbox({ answers = { { id = old, ok = true, answer = "x", dataDropped = true } } })
    r.dropped = RESULTS[4]

    -- A plugin that isn't loaded: kept until it registers.
    NOW = NOW + 10
    local held = API.Request("other", { kind = "thing", context = false })
    PUMP()
    ns.Core:ApplyInbox({ answers = { { id = held, ok = false, answer = "Error: no such plugin" } } })
    r.heldCount = #ns.db.plugins.held.other
    local got
    API.Register("other", { onResult = function(x) got = x end })
    r.held = got
    r.heldAfter = ns.db.plugins.held.other == nil

    -- The app could not read the on-screen line.
    NOW = NOW + 10
    ns.Voice.broken = true
    ns.Uplink.Fits = function() return true end
    ns.Uplink.Prepare = function() return true end
    ns.Uplink.Reveal = function(_, cb) cb(true) end
    local strip = API.Request("demo", { kind = "count", context = false })
    PUMP()
    ns.Core:ApplyInbox({ answers = {}, failedAt = NOW + 1, failMessage = "Unreadable." })
    r.unread = RESULTS[5]

    -- Cancelled: the answer is dropped.
    NOW = NOW + 10
    local gone = API.Request("demo", { kind = "count", context = false })
    PUMP()
    API.Cancel("demo", gone)
    ns.Core:ApplyInbox({ answers = { { id = gone, ok = true, answer = "x" } } })
    r.total = #RESULTS
    RESULT = ns.Json.Encode(r)`));
  assert.equal(out.pendingBefore, true);
  assert.equal(out.afterOther, 0);
  assert.equal(out.first.ok, true);
  assert.equal(out.first.kind, 'count');
  assert.equal(out.first.text, 'Two items.');
  assert.equal(out.first.model, 'demo');
  assert.deepEqual(out.first.tokens, { i: 10, c: 2, o: 3 });
  assert.deepEqual(out.first.data.names, ['Linen Cloth', 'Copper Bar']);
  assert.equal(out.pendingAfter, false);
  assert.equal(out.count, 1);
  assert.equal(out.stillPending, false);
  assert.equal(out.timedOut.ok, false);
  assert.equal(out.timedOut.timedOut, true);
  assert.match(out.timedOut.text, /No answer arrived/);
  assert.equal(out.awaitingLate, true);
  assert.deepEqual(out.listening, [true, false], 'the bell is listened for a while longer, not forever');
  assert.equal(out.late.ok, true);
  assert.equal(out.late.late, true);
  assert.equal(out.late.data.kind, 'report');
  assert.equal(out.dropped.ok, false);
  assert.match(out.dropped.text, /no longer kept/);
  assert.equal(out.heldCount, 1);
  assert.equal(out.held.ok, false);
  assert.equal(out.heldAfter, true);
  assert.equal(out.unread.ok, false);
  assert.match(out.unread.text, /Unreadable\. Try again\./);
  assert.equal(out.total, 5);
});

test('without the invisible voice a request that does not fit says so', () => {
  const out = JSON.parse(lua(`
    C_VoiceChat = nil
    ns.Uplink.Fits = function() return false end
    local failure
    local id = API.Request("demo", { kind = "count", context = false, sections = { list = LIST },
      onStatus = function(state, detail) if state == "failed" then failure = detail end end })
    PUMP()
    RESULT = ns.Json.Encode({ failure = failure, pending = ns.db.plugins.pending[id] == nil, working = ns.Core.working })`));
  assert.match(out.failure, /invisible sending/);
  assert.equal(out.pending, true);
  assert.equal(out.working, false);
});

test('game to app and back: the plugin\'s request is answered with data its addon receives', async (t) => {
  const wow = tempWow();
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: wow, slots: 2, signals: 5, provider: 'echo' };
  const p = install(cfg, { log: () => {}, resetState: false });

  const asked = JSON.parse(lua(`
    local id = API.Request("demo", { kind = "count", input = { sort = "name" }, sections = { list = LIST }, only = { "character" } })
    PUMP()
    RESULT = ns.Json.Encode({ id = id, spoken = SPOKEN })`));
  const req = heard(asked.spoken);

  const state = { nextSig: 1, answers: [], processed: [] };
  const events = [];
  const logs = [];
  const env = { cfg, paths: wowPaths(wow), state, plugins: { demo }, save: () => {}, onEvent: (e) => events.push(e), log: (m) => logs.push(m) };
  const answer = await handlePluginRequest(req, env);
  assert.equal(answer.ok, true);
  assert.equal(answer.ext, 'demo');
  assert.equal(answer.kind, 'count');
  assert.equal(answer.answer, 'Shopping: 2 items.', 'the text is cleaned like an answer');
  assert.deepEqual(answer.data, { kind: 'count', title: 'Shopping', names: ['Linen Cloth', 'Copper Bar'], asked: { sort: 'name' }, lang: 'en' });
  assert.deepEqual(answer.tokens, { i: 40, c: 10, o: 5 });
  assert.deepEqual(events.map((e) => e.type), ['question', 'answer']);
  assert.match(events[0].who, /Thora \(Warrior 14\)/);
  assert.ok(logs.some((m) => m.includes('Request for demo (count)')));
  assert.equal(await handlePluginRequest(req, env), null, 'answered once per id');
  assert.ok(fs.statSync(p.signal(3)).size > 44, 'the bell the addon is listening for');
  assert.equal(state.nextSig, 4);

  // What the game loads from the mailbox, handed to the plugin by the addon.
  const inbox = fs.readFileSync(path.join(p.slotDir(1), 'Inbox.lua'), 'utf8');
  const got = JSON.parse(lua(`
    assert(load(INBOX))()
    ns.db.plugins = { pending = { [ID] = { name = "demo", kind = "count", t = NOW, timeout = 300, sent = { demo_list = 42 } } }, held = {} }
    API.Register("demo", { onResult = function(r) RESULTS[#RESULTS + 1] = r end })
    ns.Core:ApplyInbox(ForeverAICompanion_Inbox)
    RESULT = ns.Json.Encode({ result = RESULTS[1], acked = ns.Core:CharData().acked })`, { INBOX: inbox, ID: asked.id }));
  assert.equal(got.result.ok, true);
  assert.equal(got.result.kind, 'count');
  assert.equal(got.result.text, 'Shopping: 2 items.');
  assert.deepEqual(got.result.data.names, ['Linen Cloth', 'Copper Bar']);
  assert.deepEqual(got.result.tokens, { i: 40, c: 10, o: 5 });
  assert.equal(got.acked.demo_list, 42);
});

test('a plugin the app does not have, and a plugin that fails, are answered with an error', async (t) => {
  const wow = tempWow();
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: wow, slots: 2, signals: 5, provider: 'echo' };
  install(cfg, { log: () => {}, resetState: false });
  const fresh = () => ({ nextSig: 1, answers: [], processed: [] });
  const base = { cfg, paths: wowPaths(wow), plugins: { demo }, save: () => {} };
  // This app carries no plugins of its own.
  assert.deepEqual(createPlugins(), {});
  const unknown = await handlePluginRequest({ id: '1', question: 'x', lang: 'es', ext: { name: 'nope', kind: 'k' } }, { ...base, state: fresh() });
  assert.equal(unknown.ok, false);
  assert.match(unknown.answer, /no tiene el plugin "nope"/, 'in the game\'s language');
  assert.equal(unknown.data, undefined);
  // A name that is not a plugin but is a property of every object.
  const proto = await handlePluginRequest({ id: '2', question: 'x', ext: { name: 'constructor', kind: 'k' } }, { ...base, state: fresh() });
  assert.equal(proto.ok, false);
  const failed = await handlePluginRequest({ id: '3', question: 'x', ext: { name: 'demo', kind: 'fail' } }, { ...base, state: fresh() });
  assert.equal(failed.ok, false);
  assert.equal(failed.answer, 'Error: No list arrived.');
  assert.equal(failed.ext, 'demo');
  // Sections the app no longer has: the error says to ask again, and the addon is told to resend.
  const missing = await handlePluginRequest({ id: '4', question: 'x', charKey: 'c', same: { demo_list: 5 }, ext: { name: 'demo', kind: 'count' } }, { ...base, state: fresh() });
  assert.equal(missing.ok, false);
  assert.match(missing.answer, /No list arrived\. .*ask once more/);
  const inbox = fs.readFileSync(path.join(wowPaths(wow).slotDir(1), 'Inbox.lua'), 'utf8');
  assert.match(inbox, /resync = \d+/);
});

test('only the newest answers keep their data in the mailboxes', () => {
  const answers = [];
  for (let i = 1; i <= KEEP_DATA + 2; i++) {
    answers.push({ id: `p${i}`, ok: true, answer: 'x', data: { n: i } });
    answers.push({ id: `c${i}`, ok: true, answer: 'chat' });
  }
  const out = withoutOldData(answers);
  assert.equal(out.length, answers.length);
  assert.deepEqual(out.filter((a) => a.data).map((a) => a.id), ['p3', 'p4', 'p5', 'p6']);
  assert.deepEqual(out.filter((a) => a.dataDropped).map((a) => a.id), ['p1', 'p2']);
  assert.equal(answers[0].data.n, 1, 'the stored answers are not changed');
  assert.deepEqual(out.map((a) => a.id), answers.map((a) => a.id));
  // Nested data becomes a Lua table the game can load, keys that are Lua keywords included.
  const src = inboxSource([{ id: 'p', ok: true, answer: 'x', data: { order: [101, 102], 'odd key': { a: true, b: null }, text: 'line\n"quoted"', for: 1, end: { nil: 2 } } }]);
  const back = JSON.parse(runLua('assert(load(SRC))(); RESULT = ns.Json.Encode(ForeverAICompanion_Inbox.answers[1].data)', { SRC: src }, ['Json.lua']));
  assert.deepEqual(back, { order: [101, 102], 'odd key': { a: true }, text: 'line\n"quoted"', for: 1, end: { nil: 2 } });
});
