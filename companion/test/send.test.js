// Runs the whole in-game send path (Core:Ask -> Collect -> Json -> Uplink:Send
// -> Draw -> Screenshot) against a fake WoW UI, then renders the textures the
// addon created and checks the companion can decode them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLua, encodePNG } from './helpers.js';
import { decodeImage } from '../src/image.js';
import { decodeGrid } from '../src/grid.js';
import { createAssembler } from '../src/voice-inbox.js';

const FAKE_UI = `
  local function noop() end
  local function newRegion(kind, parent)
    local r = { kind = kind, parent = parent, shown = true, points = {}, w = 0, h = 0, alpha = 1, scripts = {} }
    local mt = { __index = function(t, k)
      if k == "SetPoint" then return function(self, p, rel, rp, x, y) self.x, self.y = x or 0, y or 0; self.anchored = true end end
      if k == "SetAllPoints" then return function(self) self.anchored = true end end
      if k == "SetSize" then return function(self, w, h) self.w, self.h = w, h end end
      if k == "Show" then return function(self) self.shown = true end end
      if k == "Hide" then return function(self) self.shown = false end end
      if k == "IsShown" then return function(self) return self.shown end end
      if k == "SetShown" then return function(self, v) self.shown = v end end
      if k == "SetColorTexture" then return function(self, r, g, b) self.color = { r, g, b } end end
      if k == "CreateTexture" then return function(self) local t = newRegion("Texture", self); TEXTURES[#TEXTURES + 1] = t; return t end end
      if k == "CreateFontString" then return function(self) return newRegion("FontString", self) end end
      if k == "SetScript" then return function(self, name, fn) self.scripts[name] = fn end end
      if k == "GetScript" then return function(self, name) return self.scripts[name] end end
      if k == "GetHeight" then return function(self) return self.h end end
      if k == "GetWidth" then return function(self) return self.w end end
      if k == "SetWidth" then return function(self, v) self.w = v end end
      if k == "SetHeight" then return function(self, v) self.h = v end end
      if k == "GetStringWidth" or k == "GetUnboundedStringWidth" then return function() return 100 end end
      if k == "IsMouseOver" then return function() return false end end
      if k == "IsEnabled" then return function() return true end end
      if k == "HookScript" then return function(self, name, fn)
        local prev = self.scripts[name]
        self.scripts[name] = function(...) if prev then prev(...) end fn(...) end
      end end
      if k == "GetAlpha" then return function(self) return self.alpha end end
      if k == "SetAlpha" then return function(self, a) self.alpha = a end end
      if k == "GetText" then return function() return "" end end
      if k == "GetStringHeight" then return function() return 10 end end
      if k == "GetVerticalScrollRange" then return function() return 0 end end
      return noop
    end }
    return setmetatable(r, mt)
  end
  TEXTURES = {}
  FRAMES = {}
  CreateFrame = function(kind, name, parent)
    local f = newRegion(kind, parent)
    FRAMES[#FRAMES + 1] = f
    if name then _G[name] = f end
    return f
  end
  CreateFont = function() return newRegion("Font") end
  WorldFrame = newRegion("Frame"); WorldFrame.h = 768
  UIParent = newRegion("Frame"); UIParent.h = 768
  GetPhysicalScreenSize = function() return 2560, 1440 end
  local cvars = { screenshotFormat = "jpeg", screenshotQuality = "3" }
  GetCVar = function(k) return cvars[k] end
  SetCVar = function(k, v) cvars[k] = v end
  NOW = 100
  GetTime = function() return NOW end
  time = os.time
  SHOTS = 0
  Screenshot = function() SHOTS = SHOTS + 1 end
  GetLocale = function() return LOCALE or "enUS" end
  InCombatLockdown = function() return false end
  UnitAffectingCombat = function() return false end
  strtrim = function(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
  print = function() end
  C_Timer = { After = function(_, fn) end, NewTicker = function() end }
  PlaySoundFile = function() return false end
  UISpecialFrames = {}
  tinsert = table.insert
  SlashCmdList = {}
  date = os.date
  UnitName = function() return "Sharp" end
  UnitLevel = function() return 33 end
  UnitClass = function() return "Cazadora", "HUNTER" end
  UnitRace = function() return "Enana" end
  UnitExists = function(u) return u == "player" end
  GetRealmName = function() return "Forever" end
  GetInventoryItemLink = function() return nil end
  C_QuestLog = {
    GetNumQuestLogEntries = function() return 30 end,
    GetInfo = function(i) return { title = "Misión " .. i .. " con un nombre bastante largo", level = 30, questID = 1000 + i } end,
    GetQuestObjectives = function() return { { text = "Algo: 3/10", finished = false } } end,
  }
  GetQuestLogQuestText = function() return "d", "Mata 10 cosas y vuelve con el explorador en el campamento." end
`;

// Lua helpers: start the addon, ask, and dump what is on screen right away.
const PRELUDE_DRIVE = `
  function START()
    for _, f in ipairs(FRAMES) do
      if f.scripts.OnEvent then
        f.scripts.OnEvent(f, "ADDON_LOADED", "ForeverAICompanion")
        f.scripts.OnEvent(f, "PLAYER_LOGIN")
      end
    end
  end
  function RUN_FRAMES(n)
    for i = 1, n do
      for _, f in ipairs(FRAMES) do
        if f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end
      end
      NOW = NOW + 0.016
    end
  end
  -- Fake profiler clock: every call costs 0.5 ms, so a 4 ms budget is ~8 steps.
  local fakeMs = 0
  debugprofilestop = function() fakeMs = fakeMs + 0.5; return fakeMs end
  function FIRE(event, ...)
    for _, f in ipairs(FRAMES) do
      if f.scripts.OnEvent then f.scripts.OnEvent(f, event, ...) end
    end
  end
  -- Asks and runs frames until the strip appears. Returns the dump and frame count.
  function ASK(q)
    ns.Core:Ask(q)
    for i = 1, 2000 do
      if ns.Uplink.grid and ns.Uplink.grid.shown then return DUMP(), i - 1 end
      RUN_FRAMES(1)
    end
    return DUMP(), -1
  end
  function DUMP()
    local grid = ns.Uplink.grid
    local out = {}
    for _, t in ipairs(TEXTURES) do
      if t.parent == grid and t.shown and rawget(t, "color") and rawget(t, "x") then
        out[#out + 1] = string.format("%.4f,%.4f,%.4f,%d,%d,%d", t.x, -t.y, t.w,
          math.floor(t.color[1] * 255 + 0.5), math.floor(t.color[2] * 255 + 0.5), math.floor(t.color[3] * 255 + 0.5))
      end
    end
    return tostring(grid.shown) .. ";" .. grid.w .. "," .. grid.h .. ";" .. table.concat(out, "|")
  end
`;

const FILES = ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Core.lua'];

// Renders a DUMP() like the screen would show it (UIParent: 768 units = 1440 px)
// and decodes it with the companion's decoder.
function decodeDump(dump) {
  const [shown, size, texList] = dump.split(';');
  assert.equal(shown, 'true', 'strip should be visible right after asking');
  const scale = 1440 / 768;
  const [gw, gh] = size.split(',').map(Number);
  const width = 2560, height = 160;
  assert.ok(gh * scale <= height, `strip too tall: ${gh * scale}px`);
  const data = Buffer.alloc(width * height * 3, 200); // bright game scene behind
  for (const t of texList.split('|')) {
    const [x, y, w, r, g, b] = t.split(',').map(Number);
    const x0 = Math.round(x * scale), y0 = Math.round(y * scale);
    const x1 = Math.round((x + w) * scale), y1 = Math.round((y + w) * scale);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * width + xx) * 3;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }
  const payload = decodeGrid({ width, height, channels: 3, data });
  assert.ok(payload, 'strip not found');
  return { req: JSON.parse(payload.toString('utf8')), stripPx: Math.round(gh * scale) };
}

test('asking shows a thin strip (no screenshot, UI untouched) that decodes', () => {
  const out = runLua(`
    START()
    local first, frames = ASK("test")
    RUN_FRAMES(40)
    RESULT = first .. "#" .. frames .. ";" .. SHOTS .. ";" .. tostring(ns.Uplink.grid.shown) .. ";" .. tostring(ns.Uplink.busy) .. ";" .. UIParent.alpha
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [dump, after] = out.split('#');
  const [frames, shots, shownAfter, busy, alpha] = after.split(';');
  assert.ok(Number(frames) > 1, `preparation should be spread over several frames (took ${frames})`);
  assert.equal(shots, '0', 'no Screenshot() any more');
  assert.equal(alpha, '1', 'UI must not be hidden');
  assert.equal(shownAfter, 'false', 'strip disappears afterwards');
  assert.equal(busy, 'false');
  const { req, stripPx } = decodeDump(dump);
  assert.equal(req.question, 'test');
  assert.equal(req.context.quests.length, 30);
  assert.ok(stripPx <= 60, `strip is ${stripPx}px tall`);
});

test('second question only sends what changed (after the first was answered)', () => {
  const out = runLua(`
    START()
    local first = ASK("primera")
    RUN_FRAMES(40)
    -- the companion answers the first question
    local msgs = ns.Chats:Current().messages; local id = msgs[#msgs].id
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "ok" } } })
    -- one quest changes, everything else stays the same
    C_QuestLog.GetQuestObjectives = function(qid)
      if qid == 1005 then return { { text = "Algo: 4/10", finished = false } } end
      return { { text = "Algo: 3/10", finished = false } }
    end
    FIRE("QUEST_LOG_UPDATE")
    local second = ASK("segunda")
    RESULT = first .. "#" .. second
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [d1, d2] = out.split('#');
  const first = decodeDump(d1).req;
  const second = decodeDump(d2);
  assert.ok(first.hashes.character && first.hashes.quests);
  assert.deepEqual(Object.keys(second.req.same).sort(), Object.keys(first.hashes).filter((k) => k !== 'quests').sort());
  assert.ok(second.req.context.quests, 'changed section is sent');
  assert.equal(second.req.context.character, undefined, 'unchanged section is not sent');
  assert.ok(JSON.stringify(second.req).length < JSON.stringify(first).length);
});

test('/ia probar-canales runs every probe, undoes it and reports through the strip', () => {
  const probeApis = `
    CALLS = {}
    local function rec(name) return function(...) CALLS[#CALLS + 1] = name; return true end end
    TIMERS = {}
    C_Timer.After = function(d, fn) TIMERS[#TIMERS + 1] = { d = d, fn = fn } end
    function RUN_TIMERS(max)
      local list = TIMERS; TIMERS = {}
      for _, t in ipairs(list) do if t.d <= max then t.fn() else TIMERS[#TIMERS + 1] = t end end
    end
    function UNTIL_STRIP()
      for i = 1, 2000 do
        if ns.Uplink.grid and ns.Uplink.grid.shown then return end
        RUN_FRAMES(1)
      end
    end
    function UNTIL_SENT()
      for i = 1, 4000 do
        if not ns.Uplink.busy and not ns.Core.working then return end
        RUN_FRAMES(1)
      end
    end
    RegisterCVar = rec("RegisterCVar")
    SetCVar = function(k, v) CALLS[#CALLS + 1] = "SetCVar:" .. k .. "=" .. tostring(v) end
    C_AddOns = { DisableAddOn = rec("DisableAddOn"), EnableAddOn = rec("EnableAddOn"), SaveAddOns = rec("SaveAddOns"),
                 IsAddOnLoaded = function() return false end, LoadAddOn = function() return false, "MISSING" end }
    GetMacroIndexByName = function() return 0 end
    CreateMacro = rec("CreateMacro")
    local logging = false
    LoggingChat = function(v) if v ~= nil then logging = v end; return logging end
    C_ChatInfo = { RegisterAddonMessagePrefix = rec("RegisterPrefix"), SendAddonMessage = rec("SendAddonMessage") }
    C_VoiceChat = { GetTtsVoices = function() return { { voiceID = 0, name = "Microsoft Helena Desktop" } } end,
                    SpeakText = rec("SpeakText") }
    FlashClientIcon = function() end
  `;
  const out = runLua(`
    START()
    -- 1. The addon asks the app to start recording, and probes nothing yet.
    ns.Probe:Run()
    UNTIL_STRIP()
    local start = DUMP()
    local before = #CALLS
    UNTIL_SENT()
    -- 2. The app answers (it is recording): the probes run, then the report is sent.
    ns.Core:ApplyInbox({ answers = { { id = ns.Probe.waiting.id, ok = true, answer = "Recording." } } })
    RUN_TIMERS(25)
    UNTIL_STRIP()
    RESULT = start .. "#" .. before .. "#" .. DUMP() .. "#" .. table.concat(CALLS, ",") .. "#" .. tostring(LoggingChat())
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE + probeApis);
  const [startDump, callsBeforeAnswer, dump, calls, loggingAfter] = out.split('#');
  const start = decodeDump(startDump).req;
  assert.match(start.probeStart, /^\d+$/);
  assert.equal(start.probe, undefined);
  assert.equal(callsBeforeAnswer, '0', 'nothing is probed before the app is recording');
  for (const c of ['SetCVar:faicProbe=FAIC-PROBE-', 'DisableAddOn', 'SaveAddOns', 'CreateMacro', 'SendAddonMessage', 'SpeakText', 'EnableAddOn', 'SetCVar:faicProbe=']) {
    assert.ok(calls.includes(c), `missing ${c} in ${calls}`);
  }
  assert.equal(loggingAfter, 'false', 'chat logging restored');
  const { req } = decodeDump(dump);
  assert.equal(req.question, 'Invisible channel test');
  assert.equal(req.probe.results.cvar, 'ok');
  assert.equal(req.probe.results.addons, 'ok');
  assert.equal(req.probe.ttsVoices[0].name, 'Microsoft Helena Desktop');
  assert.match(req.probe.token, /^\d+$/);
  assert.equal(req.probe.token, start.probeStart, 'same test');
});

test('/ia probe gives up when the app never starts recording', () => {
  const out = runLua(`
    TIMERS = {}
    C_Timer.After = function(d, fn) TIMERS[#TIMERS + 1] = { d = d, fn = fn } end
    START()
    STATUS = ""
    local setStatus = ns.UI.SetStatus
    ns.UI.SetStatus = function(self, s) STATUS = s; return setStatus(self, s) end
    ns.Probe:Run()
    for _, t in ipairs(TIMERS) do if t.d == 60 then t.fn() end end
    RESULT = tostring(ns.Probe.running) .. "#" .. STATUS
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [running, status] = out.split('#');
  assert.equal(running, 'false');
  assert.match(status, /did not answer/);
});

test('oversized requests are trimmed to the frame size limit', () => {
  const big = FAKE_UI.replace('return 30 end', 'return 120 end');
  const out = runLua(`
    START()
    ASK("grande")
    RESULT = ns.Uplink.last.bytes .. ";" .. ns.Uplink.MAX_FRAME_BYTES
  `, {}, FILES, big + PRELUDE_DRIVE);
  const [bytes, max] = out.split(';').map(Number);
  assert.ok(bytes <= max, `${bytes} > ${max}`);
});


test('chats: each chat keeps its own history, answers land in the right chat', () => {
  const out = runLua(`
    ForeverAICompanion_DB = { history = { { id = "old1", question = "pregunta vieja", status = "done", answer = "respuesta vieja", t = 100 } } }
    START()
    local migrated = ns.Chats:Current()
    local a = ns.Chats:New()
    local dumpA1 = ASK("¿Qué mazmorra hago?")
    RUN_FRAMES(40)
    local idA1 = a.messages[1].id
    ns.Core:ApplyInbox({ answers = { { id = idA1, ok = true, answer = "Gnomeregan" } } })

    local b = ns.Chats:New()
    local dumpB1 = ASK("¿Cómo va mi equipo?")
    RUN_FRAMES(40)
    local idB1 = b.messages[1].id

    -- B's answer arrives while A is open: B gets the "new" mark.
    ns.Chats:Select(a.id)
    ns.Core:ApplyInbox({ answers = { { id = idB1, ok = true, answer = "Cambia las botas" } } })
    local bUnread = tostring(b.unread)

    local dumpA2 = ASK("¿Y después de Gnomeregan?")
    RUN_FRAMES(40)

    ns.Chats:Rename(b.id, "Mi equipo")
    ns.Chats:Delete(migrated.id)
    local titles = {}
    for _, c in ipairs(ns.Chats:All()) do titles[#titles + 1] = c.title end

    RESULT = migrated.title .. "|" .. #migrated.messages .. "#" .. dumpA1 .. "#" .. dumpB1 .. "#" .. dumpA2
      .. "#" .. a.title .. "|" .. tostring(a.messages[1].answer) .. "|" .. tostring(b.messages[1].answer) .. "|" .. bUnread
      .. "#" .. table.concat(titles, ",")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [migrated, dA1, dB1, dA2, summary, titles] = out.split('#');
  assert.equal(migrated, 'Previous conversation|1');
  const a1 = decodeDump(dA1).req;
  const b1 = decodeDump(dB1).req;
  const a2 = decodeDump(dA2).req;
  assert.deepEqual(a1.history, [], 'a new chat starts without history');
  assert.deepEqual(b1.history, [], 'chat B does not see chat A');
  assert.deepEqual(a2.history, [{ q: '¿Qué mazmorra hago?', a: 'Gnomeregan' }], 'chat A sees only its own turns');
  assert.equal(a2.chat.title, '¿Qué mazmorra hago?');
  const [aTitle, aAnswer, bAnswer, bUnread] = summary.split('|');
  assert.equal(aTitle, '¿Qué mazmorra hago?', 'title comes from the first question');
  assert.equal(aAnswer, 'Gnomeregan');
  assert.equal(bAnswer, 'Cambia las botas');
  assert.equal(bUnread, 'true');
  assert.deepEqual(titles.split(',').sort(), ['Mi equipo', '¿Qué mazmorra hago?'].sort());
});

test('floating button: opens the chats, new chat, unread badge, drag, hide', () => {
  const out = runLua(`
    IsShiftKeyDown = function() return SHIFT end
    -- A round minimap 140 px wide, centered at (1000, 700); the mouse above it.
    Minimap = CreateFrame("Frame"); Minimap.w, Minimap.h = 140, 140
    Minimap.GetCenter = function() return 1000, 700 end
    Minimap.GetEffectiveScale = function() return 1 end
    Minimap.GetFrameLevel = function() return 2 end
    GetCursorPosition = function() return 1000, 900 end
    START()
    local b = ForeverAICompanionFloatingButton
    b.SetPoint = function(self, p, rel, rp, x, y) self.anchorX, self.anchorY = math.floor((x or 0) + 0.5), math.floor((y or 0) + 0.5) end
    assert(b, "button not created")
    b.dragging = false -- the fake UI answers unknown fields with a function
    local shownAtStart = tostring(b.shown)
    b.scripts.OnClick(b, "LeftButton")
    local openedByClick = tostring(ns.UI.frame.shown)
    b.scripts.OnClick(b, "LeftButton")
    local closedBySecondClick = tostring(ns.UI.frame.shown)

    ns.Core:Ask("primera")           -- the open chat now has a message
    local before = #ns.db.chats
    b.scripts.OnClick(b, "RightButton")
    local newChat = tostring(#ns.db.chats == before + 1) .. "," .. tostring(ns.UI.frame.shown)

    ns.db.chats[1].unread = true
    ns.Button:Update()
    local badge = tostring(ns.Button.badge.shown) .. "," .. ns.Button.badgeText:GetText()
    local thinking = tostring(ns.Button.thinking)

    -- Dragged to straight above the minimap's center: it slides there (90°).
    b.scripts.OnDragStart(b)
    b.scripts.OnUpdate(b, 0.016)
    b.scripts.OnDragStop(b)
    local saved = tostring(ns.db.button.angle) .. "," .. tostring(b.anchorX) .. "," .. tostring(b.anchorY)
    b.dragging = false

    SHIFT = true
    b.scripts.OnClick(b, "RightButton")
    local hidden = tostring(b.shown) .. "," .. tostring(ns.db.button.shown)

    RESULT = table.concat({ shownAtStart, openedByClick, closedBySecondClick, newChat, badge, thinking, saved, hidden }, "#")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [shownAtStart, opened, closed, newChat, badge, thinking, saved, hidden] = out.split('#');
  assert.equal(shownAtStart, 'true');
  assert.equal(opened, 'true');
  assert.equal(closed, 'false');
  assert.equal(newChat, 'true,true');
  assert.equal(badge.split(',')[0], 'true');
  assert.equal(thinking, 'true', 'a pending question makes the icon breathe');
  assert.match(saved, /^90(\.0)?,0,75$/, 'on the minimap edge, above it (radius 70 + 5)');
  assert.equal(hidden, 'false,false');
});

test('window: welcome suggestions, bubbles, copy, retry, font size and sidebar', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    local ui = ns.UI
    ui:Refresh() -- the real game fires OnShow
    local welcomeShown = tostring(ui.welcome and ui.welcome.shown)
    local chips = #ui.welcome.chips

    -- A suggestion asks right away.
    ui.welcome.chips[1].scripts.OnClick(ui.welcome.chips[1])
    RUN_FRAMES(200)
    local current = ns.Chats:Current()
    local asked = current.messages[1].question

    -- Answer arrives: user bubble + AI bubble with "Copy".
    ns.Core:ApplyInbox({ answers = { { id = current.messages[1].id, ok = true, answer = "Ve a Gnomeregan" } } })
    ui:Refresh()
    local shownBubbles = 0
    for _, b in ipairs(ui.bubbles) do if b.shown then shownBubbles = shownBubbles + 1 end end
    local aiBubble = ui.bubbles[2]
    aiBubble.action.scripts.OnClick(aiBubble.action)
    local copyOpen = tostring(ui.copyFrame and ui.copyFrame.shown)

    -- An error offers "Retry", which asks again in the same chat.
    current.messages[1].status = "error"
    current.messages[1].answer = "Error: sin conexión"
    ui:Refresh()
    ui.bubbles[2].action.scripts.OnClick(ui.bubbles[2].action)
    local retried = #current.messages .. "," .. current.messages[1].status

    ui:SetFontSize(40)
    local size = ns.db.ui.fontSize
    ui:SetSidebar(false)
    local sidebar = tostring(ui.side.shown) .. "," .. tostring(ns.db.ui.sidebar)

    RESULT = table.concat({ welcomeShown, chips, asked, shownBubbles, copyOpen, retried, size, sidebar }, "#")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [welcome, chips, asked, bubbles, copyOpen, retried, size, sidebar] = out.split('#');
  assert.equal(welcome, 'true', 'empty chat shows the welcome screen');
  assert.equal(chips, '6');
  assert.equal(asked, 'Which dungeon should I run now?');
  assert.equal(bubbles, '2', 'one bubble for the question, one for the answer');
  assert.equal(copyOpen, 'true');
  assert.equal(retried, '1,pending', 'retry replaces the failed question with a new attempt');
  assert.equal(size, '20', 'font size is capped');
  assert.equal(sidebar, 'false,false');
});

test('assistant: first open asks Fizzi or Rizzik, suggests by faction, themes everything', () => {
  const out = runLua(`
    UnitFactionGroup = function() return "Horde" end
    START()
    ns.UI:Show()
    local ui = ns.UI
    ui:Refresh()
    local chooserShown = tostring(ui.chooser and ui.chooser.shown)
    local welcomeHidden = tostring(not (ui.welcome and ui.welcome.shown))
    local cards = #ui.chooser.cards
    local back = tostring(ui.chooser.back.shown)           -- nothing chosen yet: no way back
    local suggested = ns.Personas:Suggested().id

    -- Pick Rizzik: window goes gold, welcome uses his texts, button shows him.
    local rizzikCard = ui.chooser.cards[2]
    rizzikCard.pick.scripts.OnClick(rizzikCard.pick)
    local chosen = ns.Personas:Current().id .. "," .. tostring(ns.Personas:Chosen())
    local afterPick = tostring(ui.chooser.shown) .. "," .. tostring(ui.welcome.shown)
    local accent = string.format("%.2f", ui.COLORS.accent[1])
    local hello = ui.welcome.hello.textValue or ""

    -- The question carries the assistant so the app uses its personality.
    ns.Core:Ask("hola")
    local pending = ""
    for i = 1, 200 do
      RUN_FRAMES(1)
      for _, b in ipairs(ui.bubbles) do if b.shown and b.pending then pending = b.text.textValue or "" end end
    end

    -- Header click opens the chooser again; switching back to Fizzi recolors.
    ui:ShowChooser()
    local reopened = tostring(ui.chooser.shown) .. "," .. tostring(ui.chooser.back.shown)
    ui.chooser.cards[1].pick.scripts.OnClick(ui.chooser.cards[1].pick)
    local accent2 = string.format("%.2f", ui.COLORS.accent[1])

    RESULT = table.concat({ chooserShown, welcomeHidden, cards, back, suggested, chosen, afterPick,
      accent, hello, pending, reopened, accent2, ns.Personas:Current().id }, "#")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI.replace('GetStringHeight" then return function() return 10 end end',
    'GetStringHeight" then return function() return 10 end end\n      if k == "SetText" then return function(self, v) self.textValue = v end end') + PRELUDE_DRIVE);
  const [chooser, welcomeHidden, cards, back, suggested, chosen, afterPick, accent, hello, pending, reopened, accent2, final] = out.split('#');
  assert.equal(chooser, 'true', 'the first time, the window asks for an assistant');
  assert.equal(welcomeHidden, 'true');
  assert.equal(cards, '2');
  assert.equal(back, 'false');
  assert.equal(suggested, 'rizzik', 'Horde characters get the goblin suggested');
  assert.equal(chosen, 'rizzik,true');
  assert.equal(afterPick, 'false,true', 'after choosing, the welcome screen appears');
  assert.equal(accent, '0.80', 'Horde red accent for Rizzik');
  assert.match(hello, /deal/);
  assert.match(pending, /fine print|profits|contacts|transmitter|deal/, 'thinking phrases are Rizzik\'s');
  assert.equal(reopened, 'true,true', 'the chooser can be reopened, now with a way back');
  assert.equal(accent2, '0.25', 'switching to Fizzi recolors the window');
  assert.equal(final, 'fizzi');
});

test('the request tells the app which assistant answers', () => {
  const dump = runLua(`
    UnitFactionGroup = function() return "Alliance" end
    START()
    local d = ASK("¿Qué hago?")
    RESULT = d
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const { req } = decodeDump(dump);
  assert.equal(req.assistant, 'fizzi', 'asking before choosing keeps the faction\'s assistant');
  assert.equal(req.lang, 'en', 'the game\'s language travels with the request');
  const dumpEs = runLua(`
    START()
    RESULT = ASK("¿Qué hago?")
  `, {}, FILES, 'LOCALE = "esES"\n' + FAKE_UI + PRELUDE_DRIVE);
  assert.equal(decodeDump(dumpEs).req.lang, 'es');
});

test('every texture of the window is anchored (no invisible backgrounds)', () => {
  const out = runLua(`
    START()
    ns.UI:Show()
    ns.UI:Refresh()
    ns.Core:Ask("hola")
    RUN_FRAMES(200)
    ns.UI:Refresh()
    ns.UI:ShowCopy("texto")
    ns.Button:Update()
    local missing = {}
    for i, t in ipairs(TEXTURES) do
      if t.parent ~= ns.Uplink.grid and not rawget(t, "anchored") then missing[#missing + 1] = i end
    end
    RESULT = #missing .. "/" .. #TEXTURES
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [missing, total] = out.split('/').map(Number);
  assert.ok(total > 20, `expected many textures, got ${total}`);
  assert.equal(missing, 0, `${missing} textures have no anchor and would be invisible`);
});
test('notification card: preview, click opens the chat, fades away', () => {
  const out = runLua(`
    START()
    local chatA = ns.Chats:Current()
    ns.Core:Ask("¿Qué mazmorra hago?")
    RUN_FRAMES(200)
    ns.UI.frame.shown = false                 -- window closed while waiting
    ns.Chats:New()                            -- and another chat is open
    local id = chatA.messages[1].id
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "Ve a Gnomeregan con tu grupo, es la mejor opción para tu nivel." } } })
    local card = ns.Notify.cards[1]
    local shown = tostring(card.shown)
    local body = card.body.textValue or ""
    local hop = tostring(ns.Button.hopUntil ~= nil)
    local badge = tostring(ns.Button.badge.shown)

    card.scripts.OnClick(card, "LeftButton")
    local opened = tostring(ns.UI.frame.shown) .. "," .. tostring(ns.db.currentChat == chatA.id) .. "," .. tostring(card.shown)

    -- A second answer (error) shows a card that disappears on its own.
    ns.Core:Ask("otra")
    RUN_FRAMES(200)
    local chatB = ns.Chats:Current()
    ns.Chats:New()
    ns.Core:ApplyInbox({ answers = { { id = chatB.messages[#chatB.messages].id, ok = false, answer = "Error: sin conexión" } } })
    local card2 = ns.Notify.cards[1].shown and ns.Notify.cards[1] or ns.Notify.cards[2]
    local before = tostring(card2.shown)
    NOW = NOW + 11
    RUN_FRAMES(2)
    local after = tostring(card2.shown)

    RESULT = table.concat({ shown, hop, badge, opened, before, after }, "#")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [shown, hop, badge, opened, before, after] = out.split('#');
  assert.equal(shown, 'true', 'a card appears when the answer lands in a chat you are not viewing');
  assert.equal(hop, 'true', 'the floating button hops');
  assert.equal(badge, 'true', 'and shows the unread badge');
  assert.equal(opened, 'true,true,false', 'clicking the card opens that chat and closes the card');
  assert.equal(before, 'true');
  assert.equal(after, 'false', 'cards fade away after a few seconds');
});
test('portraits: race icon atlas when the game has it, icon files or the gadget otherwise', () => {
  const out = runLua(`
    START()
    local P = ns.Personas
    local function fresh(id) local p = P.list[id]; p.resolved = nil; return p end
    -- Modern client: the character creator's race icons exist.
    C_Texture = { GetAtlasInfo = function(name) if name:find("^raceicon128") then return { file = 1 } end end }
    GetFileIDFromPath = function() return nil end
    local a = P.PortraitName(fresh("rizzik")) .. "|" .. P.PortraitName(fresh("fizzi"))
    -- No atlas, but the achievement icon file exists.
    C_Texture = { GetAtlasInfo = function() return nil end }
    GetFileIDFromPath = function(path) if path:find("Goblin_Male") then return 123 end end
    local b = P.PortraitName(fresh("rizzik"))
    -- Nothing at all: the gadget.
    GetFileIDFromPath = function() return nil end
    local c = P.PortraitName(fresh("rizzik"))
    RESULT = a .. "#" .. b .. "#" .. c
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [a, b, c] = out.split('#');
  assert.equal(a, 'atlas raceicon128-goblin-male|atlas raceicon128-gnome-female');
  assert.match(b, /Achievement_Character_Goblin_Male/);
  assert.match(c, /INV_Misc_Coin_01/);
});

// --- Languages ---------------------------------------------------------------
// GetLocale() picks the texts: esES / esMX -> Spanish, anything else -> English.
const ALL_FILES = ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'];
const RECORD_TEXT = FAKE_UI.replace('GetStringHeight" then return function() return 10 end end',
  'GetStringHeight" then return function() return 10 end end\n      if k == "SetText" then return function(self, v) self.textValue = v end end');
const inLocale = (locale) => `LOCALE = ${JSON.stringify(locale)}\n` + RECORD_TEXT + PRELUDE_DRIVE;

for (const { locale, code, title, hello, hint, chip, chooserTitle, pick, role, faction } of [
  { locale: 'enUS', code: 'en', title: 'New chat', hello: 'Hi, Sharp! What shall we invent today?',
    hint: 'Each chat remembers its own conversation: use one per topic.', chip: 'Which dungeon should I run now?',
    chooserTitle: 'Your assistant', pick: 'Choose Fizzi|Choose Rizzik', role: 'Gnomeregan inventor · Alliance', faction: '(your faction)' },
  { locale: 'esMX', code: 'es', title: 'Nuevo chat', hello: '¡Hola, Sharp! ¿Qué inventamos hoy?',
    hint: 'Cada chat recuerda su propia conversación: usa uno por tema.', chip: '¿Qué mazmorra me conviene hacer ahora?',
    chooserTitle: 'Tu asistente', pick: 'Elegir a Fizzi|Elegir a Rizzik', role: 'Inventora de Gnomeregan · Alianza', faction: '(tu facción)' },
]) {
  test(`window and assistant chooser in ${locale}`, () => {
    const out = runLua(`
      UnitFactionGroup = function() return "Alliance" end
      START()
      ns.UI:Show()
      local ui = ns.UI
      ui:Refresh()
      -- First open: the chooser.
      local chooser = ui.title.textValue
      local picks = ui.chooser.cards[1].pick.textValue .. "|" .. ui.chooser.cards[2].pick.textValue
      local role = ui.chooser.cards[1].role.textValue
      local full = ns.Personas.list.fizzi.fullName .. "|" .. ns.Personas.list.rizzik.fullName
      ui.chooser.cards[1].pick.scripts.OnClick(ui.chooser.cards[1].pick)
      -- Then the welcome screen of an empty chat.
      local w = ui.welcome
      RESULT = table.concat({ ns.L.code, chooser, picks, role, full, ui.title.textValue, w.hello.textValue,
        w.hint.textValue, ns.L.SUGGESTIONS[1], ui.placeholder.textValue, ns.L.WINDOW_TITLE }, "#")
    `, {}, ALL_FILES, inLocale(locale));
    const [gotCode, chooser, picks, gotRole, full, gotTitle, gotHello, gotHint, gotChip, placeholder, windowTitle] = out.split('#');
    assert.equal(gotCode, code);
    assert.equal(chooser, chooserTitle);
    assert.equal(picks, pick);
    assert.match(gotRole, new RegExp(`^${role}`));
    assert.ok(gotRole.includes(faction), `suggested assistant marked: ${gotRole}`);
    assert.equal(full, code === 'en' ? 'Fizzi Sparkwrench|Rizzik Fastfuse' : 'Fizzi Chispatuerca|Rizzik Bujíaveloz');
    assert.equal(gotTitle, title);
    assert.equal(gotHello, hello);
    assert.equal(gotHint, hint);
    assert.equal(gotChip, chip);
    assert.match(placeholder, code === 'en' ? /^Ask Fizzi/ : /^Pregúntale algo a Fizzi/);
    assert.equal(windowTitle, 'Forever AI Companion');
  });
}

test('slash commands accept English and Spanish words in any game language', () => {
  for (const locale of ['enUS', 'esES']) {
    const out = runLua(`
      START()
      PRINTED = {}
      print = function(...) PRINTED[#PRINTED + 1] = table.concat({ ... }, " ") end
      local slash = SlashCmdList.FOREVERAICOMPANION
      slash("assistant rizzik")
      local en = ns.Personas:Current().id .. "|" .. PRINTED[#PRINTED]
      slash("asistente fizzi")
      local es = ns.Personas:Current().id .. "|" .. PRINTED[#PRINTED]
      slash("help")
      local help = PRINTED[#PRINTED]
      slash("ayuda")
      local ayuda = PRINTED[#PRINTED]
      slash("button reset")
      local reset = PRINTED[#PRINTED]
      local function talk() ns.Chats:AddMessage(ns.Chats:Current(), { id = tostring(math.random()), question = "q", status = "done" }) end
      talk()
      local before = #ns.db.chats
      slash("new")
      local afterNew = #ns.db.chats - before
      talk()
      slash("nuevo")
      local afterNuevo = #ns.db.chats - before
      -- Anything else is a question, even if it starts with a command word.
      slash("data about my quests")
      local asked = ns.Chats:Current().messages[1].question
      RESULT = table.concat({ en, es, help, ayuda, reset, afterNew, afterNuevo, asked,
        SLASH_FOREVERAICOMPANION1, SLASH_FOREVERAICOMPANION2, SLASH_FOREVERAICOMPANION3 }, "#")
    `, {}, ALL_FILES, inLocale(locale));
    const [en, es, help, ayuda, reset, afterNew, afterNuevo, asked, s1, s2, s3] = out.split('#');
    const spanish = locale === 'esES';
    assert.equal(en, spanish ? 'rizzik||cff66ccffForever AI:|r Rizzik es ahora tu asistente.'
      : 'rizzik||cff66ccffForever AI:|r Rizzik is now your assistant.');
    assert.equal(es, spanish ? 'fizzi||cff66ccffForever AI:|r Fizzi es ahora tu asistente.'
      : 'fizzi||cff66ccffForever AI:|r Fizzi is now your assistant.');
    assert.equal(help, ayuda, 'help and ayuda are the same command');
    assert.match(help, spanish ? /\/ia nuevo crea un chat/ : /\/ai new creates a chat/);
    // /ai (English) and /ia (Spanish) are the same command, and the help says so.
    assert.match(help, spanish ? /\|r \/ia \(o \/ai,/ : /\|r \/ai \(or \/ia,/);
    assert.match(help, spanish ? /funcionan también con \/ai$/ : /also works with \/ia$/);
    assert.match(reset, spanish ? /botón devuelto/ : /button moved back/);
    assert.equal(afterNew, '1');
    assert.equal(afterNuevo, '2');
    assert.equal(asked, 'data about my quests');
    assert.deepEqual([s1, s2, s3], ['/ia', '/azia', '/ai']);
  }
});

test('Spanish falls back to English for a missing key, and every key is translated', () => {
  const out = runLua(`
    local es, en = ns.Locales.es, ns.Locales.en
    local untranslated = {}
    for k in pairs(en) do if rawget(es, k) == nil then untranslated[#untranslated + 1] = k end end
    for k in pairs(es) do if rawget(en, k) == nil then untranslated[#untranslated + 1] = "en:" .. k end end
    local before = ns.L.SEND
    ns.L.SEND = nil                       -- a key the Spanish table does not have
    RESULT = table.concat({ ns.L.code, before, ns.L.SEND, ns.L.NO_SUCH_KEY, #ns.L.FIZZI_THINKING,
      table.concat(untranslated, ",") }, "#")
  `, {}, ['Locale.lua'], 'LOCALE = "esES"; GetLocale = function() return LOCALE end');
  const [code, before, fallback, unknown, thinking, untranslated] = out.split('#');
  assert.equal(code, 'es');
  assert.equal(before, 'Enviar');
  assert.equal(fallback, 'Send', 'missing Spanish text shows the English one');
  assert.equal(unknown, 'NO_SUCH_KEY', 'never nil');
  assert.equal(thinking, '5');
  assert.equal(untranslated, '', 'both languages have the same keys');
});

test('German has every English text, with the same placeholders', () => {
  const out = runLua(`
    local de, en = ns.Locales.de, ns.Locales.en
    local problems = {}
    local function specs(v) local out = {} for f in tostring(v):gmatch("%%[%d%.]*[sdf]") do out[#out + 1] = f end return table.concat(out) end
    for k, v in pairs(en) do
      local d = rawget(de, k)
      if d == nil then problems[#problems + 1] = "missing:" .. k
      elseif type(v) == "string" and specs(v) ~= specs(d) then problems[#problems + 1] = "format:" .. k end
    end
    for k in pairs(de) do if rawget(en, k) == nil then problems[#problems + 1] = "extra:" .. k end end
    table.sort(problems)
    RESULT = table.concat(problems, ",") .. "#" .. de.HELP
  `, {}, ['Locale.lua'], 'GetLocale = function() return "deDE" end');
  const [problems, help] = out.split('#');
  assert.equal(problems, '', 'German and English have the same keys and format specifiers');
  // The German help lists the same commands as the English one.
  for (const cmd of ['new', 'assistant', 'button', 'sound', 'proactive', 'data', 'status', 'inbox']) {
    assert.match(help, new RegExp(`/ai ${cmd}`), cmd);
  }
  assert.match(help, /\/ia/);
});
// --- App status in the chat header -------------------------------------------
// The app keeps sig/*.wav files that play or not (beacon.js); the addon reads
// them with PlaySoundFile and shows the result under the chat title.
const STATUS_UI = RECORD_TEXT + PRELUDE_DRIVE + `
  PLAYING = {}
  PlaySoundFile = function(path) return PLAYING[path:match("sig\\\\([%w%-]+)%.wav$") or ""] == true end
`;

test('chat header shows whether the app is open, ready, and why not', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    local states = {}
    local function check(note)
      NOW = NOW + 2
      states[#states + 1] = (note or "") .. ns.Live:CheckApp()
    end
    PLAYING = { ok = true, st = true }
    check(); check()                          -- nothing beats: closed
    local closedText = ns.UI.channel.textValue
    PLAYING.beat1 = true; check()             -- the app starts: still closed until it switches
    PLAYING.beat1, PLAYING.beat2 = nil, true; check()   -- it switches: ready
    local readyText = ns.UI.channel.textValue
    PLAYING["need-login"] = true; PLAYING.beat1, PLAYING.beat2 = true, nil; check()
    local loginText = ns.UI.channel.textValue
    PLAYING["need-login"] = nil; PLAYING.beat1, PLAYING.beat2 = nil, true; check()
    PLAYING.beat1, PLAYING.beat2 = nil, nil; check("1:")  -- one silent check: maybe switching
    PLAYING.beat1 = true; check()
    for i = 1, 8 do check() end               -- the same beat for 16 s: stuck
    PLAYING.beat1, PLAYING.beat2 = nil, true; check()   -- alive again
    -- Window closed for a minute: no "stuck" right after reopening.
    NOW = NOW + 60; check("gap:")
    PLAYING.st = nil; check()                 -- files newer than the game
    PLAYING.ok = nil; check()                 -- game sound off
    PLAYING = { ok = true, st = true, beat1 = true, beat2 = true }
    check(); check(); check(); check()        -- both always play: can't tell
    local tip = select(1, ns.UI:AppStatusHelp())
    RESULT = table.concat(states, ",") .. "#" .. closedText .. "#" .. readyText .. "#" .. loginText .. "#" .. tip
  `, {}, ALL_FILES, STATUS_UI);
  const [states, closedText, readyText, loginText, tip] = out.split('#');
  assert.equal(states, [
    'checking', 'closed', 'closed', 'ready', 'need-login', 'ready', '1:ready', 'ready',
    // 2..14 s on the same beat is fine; 16 s is more than STALE (15).
    'ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'stuck', 'ready',
    'gap:ready', 'restart', 'nosound', 'ready', 'ready', 'ready', 'unknown',
  ].join(','));
  assert.match(closedText, /\|cffff6060Forever AI Companion is closed/);
  assert.match(readyText, /Fizzi .* invisible link|Fizzi .* on-screen strip/);
  assert.match(loginText, /sign in/);
  assert.equal(tip, 'App status unknown');
});

// --- macOS: sound files are checked a moment later ------------------------------
// WoW for Mac says PlaySoundFile will play any file that exists, empty or not;
// only C_Sound.IsPlaying a moment later tells them apart. Trusting the first
// answer took every signal as rung and used up the 50 mailboxes in ~5 questions.
const MAC_SOUND = RECORD_TEXT + PRELUDE_DRIVE + `
  IsMacClient = function() return true end
  REAL = { ok = true, st = true }   -- sound files with real content
  HANDLES = {}
  PlaySoundFile = function(path)
    HANDLES[#HANDLES + 1] = path:match("sig\\\\([%w%-]+)%.wav$") or ""
    return true, #HANDLES          -- "will play", like the Mac client says for every file
  end
  StopSound = function() end
  C_Sound = { IsPlaying = function(h) return REAL[HANDLES[h]] == true end }
  TIMERS = {}
  C_Timer.After = function(_, fn) TIMERS[#TIMERS + 1] = fn end
  function FLUSH() local list = TIMERS; TIMERS = {}; for _, fn in ipairs(list) do fn() end end
  LOADS, LOADED = 0, {}
  C_AddOns = {
    IsAddOnLoaded = function(n) return LOADED[n] end,
    LoadAddOn = function(n) LOADED[n] = true; LOADS = LOADS + 1; return true end,
    EnableAddOn = function() end,
  }
`;

test('Mac: a mailbox is opened only when the app really rings, not on every check', () => {
  const out = runLua(`
    START()
    FLUSH()                                   -- the start-up scan finds nothing rung
    ns.Core.HasPending = function() return true end
    local first = ns.db.nextSig
    for i = 1, 15 do ns.Live:Tick(); FLUSH() end   -- 30 s waiting for an answer
    local idle = LOADS .. "/" .. ns.db.nextSig
    REAL[string.format("%03d", ns.db.nextSig)] = true   -- the app rings
    ns.Live:Tick(); FLUSH()
    local rung = LOADS .. "/" .. ns.db.nextSig
    for i = 1, 5 do ns.Live:Tick(); FLUSH() end    -- the next signal is still empty
    RESULT = first .. "#" .. idle .. "#" .. rung .. "#" .. LOADS .. "#" .. tostring(ns.Live.deferred)
  `, {}, ALL_FILES, MAC_SOUND);
  const [first, idle, rung, after, deferred] = out.split('#');
  assert.equal(deferred, 'true');
  assert.equal(idle, `0/${first}`, 'no mailbox used and no signal skipped while nothing rang');
  assert.equal(rung, `1/${Number(first) + 1}`, 'one ring, one mailbox');
  assert.equal(after, '1');
});

test('Mac: signals rung while the game was closed are skipped at start, one check at a time', () => {
  const out = runLua(`
    REAL["001"], REAL["002"], REAL["003"] = true, true, true
    START()
    local during = tostring(ns.Live.scanning)
    for i = 1, 5 do FLUSH() end
    RESULT = during .. "#" .. ns.db.nextSig .. "#" .. tostring(ns.Live.scanning)
  `, {}, ALL_FILES, MAC_SOUND);
  assert.equal(out, 'true#4#false');
});

test('Mac: the chat header tells closed from ready (not "unknown")', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    FLUSH()
    local states = {}
    local function check() NOW = NOW + 2; ns.Live:CheckApp(); FLUSH(); states[#states + 1] = ns.Live:AppState() end
    check(); check()                                   -- nothing beats: closed
    REAL.beat1 = true; check()
    REAL.beat1, REAL.beat2 = nil, true; check()        -- it switches: ready
    REAL["need-ai"] = true; REAL.beat1, REAL.beat2 = true, nil; check()
    RESULT = table.concat(states, ",")
  `, {}, ALL_FILES, MAC_SOUND);
  assert.equal(out.split(',').slice(-4).join(','), 'closed,closed,ready,need-ai');
});

test('Mac without C_Sound.IsPlaying: signals are not trusted, mailboxes go by the timer', () => {
  const out = runLua(`
    START()
    ns.Core.HasPending = function() return true end
    for i = 1, 10 do ns.Live:Tick() end
    RESULT = LOADS .. "#" .. tostring(ns.Live.soundOK) .. "#" .. ns.Live:CheckApp()
  `, {}, ALL_FILES, MAC_SOUND + 'C_Sound = nil\n');
  assert.equal(out, '0#false#unknown');
});

// --- Windows: the client can also say "will play" for an empty file ------------------
// Seen on WoW Forever for Windows: PlaySoundFile returns willPlay = true for an
// empty sig\NNN.wav (it stops at once). Trusting it opened a mailbox on every
// Tick (every 2 s) while an answer was pending: 7-12 mailboxes per question with
// a slow model. The deferred check now runs wherever C_Sound.IsPlaying exists.
test('Windows that accepts empty files: a mailbox only when the app really rings', () => {
  const out = runLua(`
    START()
    FLUSH()
    ns.Core.HasPending = function() return true end
    local first = ns.db.nextSig
    for i = 1, 15 do ns.Live:Tick(); FLUSH() end   -- 30 s waiting for an answer
    local idle = LOADS .. "/" .. ns.db.nextSig
    REAL[string.format("%03d", ns.db.nextSig)] = true   -- the app rings
    ns.Live:Tick(); FLUSH()
    local rung = LOADS .. "/" .. ns.db.nextSig
    RESULT = first .. "#" .. idle .. "#" .. rung .. "#" .. tostring(ns.Live.deferred) .. "#" .. tostring(ns.Live.noSignals)
  `, {}, ALL_FILES, MAC_SOUND + 'IsMacClient = function() return false end\n');
  const [first, idle, rung, deferred, noSignals] = out.split('#');
  assert.equal(deferred, 'true');
  assert.equal(noSignals, 'false');
  assert.equal(idle, `0/${first}`, 'no mailbox used and no signal skipped while nothing rang');
  assert.equal(rung, `1/${Number(first) + 1}`, 'one ring, one mailbox');
});

// --- A slow answer through the invisible voice ------------------------------------
const VOICE_ON = RECORD_TEXT + PRELUDE_DRIVE + `
  SPOKEN = {}
  C_VoiceChat = {
    GetTtsVoices = function() return { { voiceID = 7, name = "ForeverAICompanion" } } end,
    SpeakText = function(_, text) SPOKEN[#SPOKEN + 1] = text; return true end,
  }
  C_Timer.After = function(_, fn) fn() end
  function UNTIL_IDLE()
    for i = 1, 6000 do
      if not ns.Core.working and not ns.Uplink.busy then return end
      RUN_FRAMES(1)
    end
  end
`;

test('a slow answer through the voice: sent again as the same question, and the voice stays on', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    local id = ns.Core:Ask("¿Qué mazmorra me conviene?")
    UNTIL_IDLE()
    local chat = ns.Chats:Current()
    local entry = chat.messages[#chat.messages]
    local spoke = #SPOKEN
    entry.t = time() - 46                       -- no answer after 45 s (a slow first answer)
    ns.Core:HasPending()
    UNTIL_IDLE()
    local again = (ns.Uplink.last and ns.Uplink.last.bytes or 0) > 0
    local count = #chat.messages
    local stillPending = entry.status
    ns.Core:HasPending()                        -- only once
    UNTIL_IDLE()
    -- The answer to the first copy arrives (the app answers an id once).
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "Las Minas de la Muerte." } } })
    RESULT = table.concat({ spoke, tostring(again), count, stillPending, entry.id == id and "same-id" or "new-id",
      entry.status, tostring(ns.Voice.broken), tostring(ns.Voice:Available()) }, "#")
  `, {}, ALL_FILES, VOICE_ON);
  assert.equal(out, '1#true#1#pending#same-id#done#nil#true');
});

test('no answer at all through the voice: the question fails and the voice is given up, until an answer still arrives', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.Core:Ask("¿Hola?")
    UNTIL_IDLE()
    local chat = ns.Chats:Current()
    local entry = chat.messages[#chat.messages]
    entry.t = time() - 46; ns.Core:HasPending(); UNTIL_IDLE()
    entry.t = time() - 151; ns.Core:HasPending()
    local given = entry.status .. "#" .. tostring(ns.Voice.broken)
    -- The answer still arrives later: it is shown, and the voice is back.
    ns.Core:ApplyInbox({ answers = { { id = entry.id, ok = true, answer = "Hola, aventurera." } } })
    RESULT = given .. "#" .. entry.status .. "#" .. tostring(entry.answer) .. "#" .. tostring(ns.Voice.broken)
  `, {}, ALL_FILES, VOICE_ON);
  assert.equal(out, 'error#true#done#Hola, aventurera.#nil');
});

test('a proactive tip lost through the voice is removed and does not give the voice up', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.Core:Ask("We've hit level 12.", { proactive = { kind = "level", key = "level:12" } }, nil, nil, { silent = true })
    UNTIL_IDLE()
    local tip
    for _, c in ipairs(ns.db.chats) do if c.proactive then tip = c.messages[1] end end
    local via = tostring(tip.viaVoice)
    -- No strip resend for a tip, and no answer ever comes back.
    tip.t = time() - 46; ns.Core:HasPending(); UNTIL_IDLE()
    local resent = tostring(tip.resent)
    tip.t = time() - 151; ns.Core:HasPending()
    local left = 0
    for _, c in ipairs(ns.db.chats) do if c.proactive then left = left + #c.messages end end
    RESULT = table.concat({ via, resent, left, tostring(ns.Voice.broken) }, "#")
  `, {}, ALL_FILES, VOICE_ON);
  assert.equal(out, 'true#nil#0#nil', 'sent by voice, not resent, removed, and the voice is still trusted');
});

// --- Asking in combat ----------------------------------------------------------------
const IN_COMBAT = RECORD_TEXT + PRELUDE_DRIVE + `
  INCOMBAT = false
  UnitAffectingCombat = function() return INCOMBAT end
  InCombatLockdown = function() return INCOMBAT end
  HEALTH, MAXH = 800, 1000
  UnitHealth = function() return HEALTH end
  UnitHealthMax = function() return MAXH end
  function FIRE(event, ...)
    for _, f in ipairs(FRAMES) do
      if f.scripts.OnEvent then pcall(f.scripts.OnEvent, f, event, ...) end
    end
  end
`;

test('in combat you can ask, and the window warns you to watch the game (and flashes when you get hit)', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    INCOMBAT = true
    FIRE("PLAYER_REGEN_DISABLED")
    local id = ns.Core:Ask("¿Qué hago con este mob?")
    local chat = ns.Chats:Current()
    local asked = id and chat.messages[#chat.messages].status or "blocked"
    local C = ns.Combat
    local bar = tostring(C.bar.shown) .. ":" .. tostring(C.text.textValue)
    FIRE("UNIT_COMBAT", "target", "WOUND", "", 50)       -- someone else hit: nothing
    local other = tostring(C.hitAt)
    FIRE("UNIT_COMBAT", "player", "WOUND", "", 200)      -- the player is hit
    C:Fade(0.1)
    local hit = string.format("%.2f", C.glow.alpha) .. ":" .. tostring(C.text.textValue) .. ":" .. tostring(C.hpText.textValue)
    NOW = NOW + 5; C:Fade(0.1)                            -- a few seconds later
    local calm = tostring(C.text.textValue)
    INCOMBAT = false
    FIRE("PLAYER_REGEN_ENABLED")
    RESULT = table.concat({ asked, bar, other, hit, calm, tostring(C.bar.shown) }, "#")
  `, {}, ALL_FILES, IN_COMBAT);
  const [asked, bar, other, hit, calm, after] = out.split('#');
  assert.equal(asked, 'pending', 'the question is sent in combat');
  assert.equal(bar, 'true:In combat: keep an eye on the game');
  assert.equal(other, 'nil', 'only hits on the player count');
  assert.match(hit, /^0\.34:.*You're being hit! Watch the game.*:80%$/, 'the edges glow (discreetly); the health shows');
  assert.equal(calm, 'In combat: keep an eye on the game');
  assert.equal(after, 'false', 'the bar goes away after combat');
});

test('in combat, with the game hiding health from addons: the warning still works, without errors', () => {
  const out = runLua(`
    issecretvalue = function(v) return type(v) == "number" end   -- like the game in combat
    START()
    ns.UI:Show()
    INCOMBAT = true
    FIRE("PLAYER_REGEN_DISABLED")
    FIRE("UNIT_HEALTH", "player")
    FIRE("UNIT_COMBAT", "player", "WOUND", "", 120)   -- what WoW Forever sends: the amount hidden
    ns.Combat:Fade(0.1)
    RESULT = tostring(ns.Combat.bar.shown) .. "#" .. tostring(ns.Combat.text.textValue) .. "#" .. string.format("%.2f", ns.Combat.glow.alpha)
  `, {}, ALL_FILES, 'LOCALE = "esES"\n' + IN_COMBAT);
  const [shown, text, flash] = out.split('#');
  assert.equal(shown, 'true');
  assert.match(text, /¡Te están golpeando! Mira el juego\|r$/);
  assert.equal(flash, '0.34', 'the hit is seen even with its amount hidden');
});

test('the "thinking" bubble is big enough for every phrase it cycles through', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("rizzik")
    ns.Core:Ask("What now?")
    local b = ns.UI.bubbles[2]
    local textW = b.box.w - 20
    local worst = 0
    for _, phrase in ipairs(ns.Personas:Current().thinking) do
      b.text.w = textW
      b.text.textValue = phrase .. "..."
      worst = math.max(worst, b.text:GetStringHeight() + 16 - b.box.h)
    end
    RESULT = tostring(b.pending) .. "#" .. worst .. "#" .. textW
  `, {}, ALL_FILES, RECORD_TEXT.replace(
    'GetStringHeight" then return function() return 10 end end',
    'GetStringHeight" then return function(self) return 14 * math.max(1, math.ceil(#(self.textValue or "") * 6 / math.max(1, self.w))) end end')
    .replace('k == "GetStringWidth" or k == "GetUnboundedStringWidth" then return function() return 100 end end',
      'k == "GetStringWidth" or k == "GetUnboundedStringWidth" then return function(self) return #(self.textValue or "") * 6 end end')
    + PRELUDE_DRIVE);
  const [pending, worst] = out.split('#');
  assert.equal(pending, 'true');
  assert.ok(Number(worst) <= 0, `a phrase is ${worst} px taller than its box`);
});

test('a linked item goes in the context; the question keeps only its name; recipes are remembered', () => {
  const out = runLua(`
    START()
    GetTradeSkillLine = function() return "Cocina", 40, 75 end
    GetNumTradeSkills = function() return 1 end
    GetTradeSkillInfo = function() return "Lobo asado", "medium", 0 end
    ns.Core:RememberRecipes("trade")
    local dump = ASK("Is |cff1eff00|Hitem:9999::::|h[Anillo del alba]|h|r better?")
    RESULT = dump .. "#" .. ns.Chats:Current().messages[1].question
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [dump, shownQuestion] = out.split('#');
  const { req } = decodeDump(dump);
  assert.equal(req.question, 'Is [Anillo del alba] better?');
  assert.equal(shownQuestion, 'Is [Anillo del alba] better?');
  assert.equal(req.context.linkedItems[0].name, 'Anillo del alba');
  assert.equal(req.context.knownRecipes[0].profession, 'Cocina');
  assert.equal(req.context.knownRecipes[0].recipes[0].difficulty, 'yellow');
});

test('a big vendor list is shortened so the question still fits the on-screen strip', () => {
  const out = runLua(`
    START()
    GetMerchantNumItems = function() return 60 end
    GetMerchantItemInfo = function(i) return "Espada larga de mercader número " .. i, 0, 1000 + i, 1, -1, true, true, false end
    GetMerchantItemLink = function() return nil end
    ns.Collect.open.merchant = true
    RESULT = ASK("¿Qué le compro?")
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const { req } = decodeDump(out);
  const items = req.context.screen.merchant.items;
  assert.ok(items.length >= 1 && items.length <= 60, `${items.length} vendor items`);
  assert.equal(items[0].name, 'Espada larga de mercader número 1');
  assert.equal(req.question, '¿Qué le compro?');
});

test('links in the question bubble keep their color and open the item like in the chat', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    local REFS = {}
    SetItemRef = function(link, text, button) REFS[#REFS + 1] = link .. "/" .. button end
    ASK("Is |cnIQ3:|Hitem:9999::::|h[Anillo del alba]|h|r better than |cff1eff00|Hitem:3000|h[Arco]|h|r? 50|50")
    ns.UI:Refresh()
    local b = ns.UI.bubbles[1]
    b.box.scripts.OnHyperlinkClick(b.box, "item:9999::::", "[Anillo del alba]", "LeftButton")
    RESULT = b.text.textValue .. "#" .. ns.Chats:Current().messages[1].question .. "#" .. table.concat(REFS, ",")
  `, {}, ALL_FILES, RECORD_TEXT + PRELUDE_DRIVE);
  const [bubble, question, refs] = out.split('#');
  assert.equal(bubble, 'Is |cnIQ3:|Hitem:9999::::|h[Anillo del alba]|h|r better than |cff1eff00|Hitem:3000|h[Arco]|h|r? 50||50',
    'links stay working, any other "|" is shown literally');
  assert.equal(question, 'Is [Anillo del alba] better than [Arco]? 50|50', 'the AI and the chat list get plain text');
  assert.equal(refs, 'item:9999::::/LeftButton', 'clicking opens it like a chat link');
});

test('each answer shows the tokens it used, and the chat total sits under the text box', () => {
  const tip = `
    TIP = {}
    GameTooltip = { SetOwner = function() TIP = {} end, AddLine = function(_, s) TIP[#TIP + 1] = s end, Show = function() end, Hide = function() end }
  `;
  for (const [locale, meta, total, read] of [
    ['enUS', '  ·  18.2k tokens', 'This chat: 18.2k tokens', 'Read: 18,000 (from the cache: 12,000)'],
    ['esMX', '  ·  18,2k tokens', 'Este chat: 18,2k tokens', 'Leídos: 18.000 (de la caché: 12.000)'],
  ]) {
    const out = runLua(`
      START()
      ns.Personas:Set("fizzi")
      ns.UI:Show()
      ns.Core:Ask("primera")
      RUN_FRAMES(200)
      local chat = ns.Chats:Current()
      ns.Core:ApplyInbox({ answers = { { id = chat.messages[1].id, ok = true, answer = "uno", tokens = { i = 18000, c = 12000, o = 234 } } } })
      ns.Core:Ask("segunda")
      RUN_FRAMES(200)
      ns.Core:ApplyInbox({ answers = { { id = chat.messages[2].id, ok = true, answer = "dos" } } })
      ns.UI:Refresh()
      local b = ns.UI.bubbles[2]
      b.metaHover.scripts.OnEnter(b.metaHover)
      local tip1 = table.concat(TIP, "|")
      -- (the fake UI answers unknown fields with a function: "no table" means unset)
      local older = type(rawget(ns.UI.bubbles[4].metaHover, "tokens")) ~= "table" and not ns.UI.bubbles[4].meta.textValue:find("tokens")
      RESULT = table.concat({ b.meta.textValue:gsub("^%d+:%d+", ""), ns.UI.usage.textValue, tip1, tostring(older) }, "#")
    `, { locale }, ALL_FILES, `LOCALE = ${JSON.stringify(locale)}\n` + tip + RECORD_TEXT + PRELUDE_DRIVE);
    const [m, t, tipText, older] = out.split('#');
    assert.equal(m, meta, `${locale}: time · tokens under the answer`);
    assert.equal(t, total, `${locale}: the whole chat under the text box`);
    assert.match(tipText, new RegExp(read.replace(/[().]/g, '\\$&')));
    assert.equal(older, 'true', 'answers from apps that send no tokens show no count');
  }
});

test('items in the AI answer become links only when the id really is that item', () => {
  const items = `
    C_Item = {
      GetItemInfo = function(id)
        if id == 9999 then return "Anillo del alba", "|cff0070dd|Hitem:9999::::|h[Anillo del alba]|h|r" end
        if id == 1234 then return "Espada de bronce", "|cffffffff|Hitem:1234::::|h[Espada de bronce]|h|r" end
        return nil
      end,
      RequestLoadItemDataByID = function(id) REQUESTED = id end,
    }
  `;
  const out = runLua(`
    local answer = "Usa {{item:9999|anillo del alba}}, no {{item:1234|Hacha}}, y {{item:5555|Capa}}. 5|5"
    RESULT = ns.UI.RenderAnswer(answer) .. "#" .. tostring(ns.UI.waitingItems) .. "#" .. tostring(REQUESTED)
      .. "#" .. ns.UI.PlainAnswer(answer)
  `, {}, ALL_FILES, items + RECORD_TEXT + PRELUDE_DRIVE);
  const [shown, waiting, requested, plain] = out.split('#');
  assert.equal(shown, 'Usa |cff0070dd|Hitem:9999::::|h[Anillo del alba]|h|r, no Hacha, y Capa. 5||5',
    'right id: a link; wrong id or not loaded yet: just the name; other "|" shown literally');
  assert.equal(waiting, 'true', 'refreshes once the game loads the missing item');
  assert.equal(requested, '5555');
  assert.equal(plain, 'Usa [anillo del alba], no [Hacha], y [Capa]. 5|5');
});

test('places in the AI answer become waypoint links only for a zone the game knows', () => {
  const maps = `
    MAPS = { [69] = { name = "Feralas", mapType = 3 }, [1411] = { name = "Durotar", mapType = 3 },
             [1454] = { name = "Orgrimmar", mapType = 3 } }
    C_Map = C_Map or {}
    C_Map.GetMapInfo = function(id) return MAPS[id] end
    C_Map.GetBestMapForUnit = function() return 1411 end
    GetRealZoneText = function() return "Durotar" end
    WAYPOINTS = {}
    TomTom = {
      AddWaypoint = function(self, m, x, y, opts)
        WAYPOINTS[#WAYPOINTS + 1] = m .. "@" .. x .. "," .. y .. "@" .. tostring(opts.title) .. "@" .. tostring(opts.crazy)
        return { m, x, y }
      end,
      SetCrazyArrow = function(self, uid) ARROW = uid[1] end,
    }
  `;
  const out = runLua(`
    local answer = "Geh zu {{way:feralas|73.6|45.0|Rok Orhan}}, dann {{way:Durotar|52|43|}}, "
      .. "nicht {{way:Atlantis|10|10|Nirgends}} oder {{way:Feralas|0|200|Fehler}}. {{item:1|X}}"
    local shown = ns.UI.RenderAnswer(answer)
    local link = shown:match("|H(faiway:[^|]+)|h")
    local set = ns.UI.SetWaypointFromLink(link)
    RESULT = shown .. "#" .. link .. "#" .. tostring(set) .. "#" .. table.concat(WAYPOINTS, ";") .. "#" .. tostring(ARROW)
      .. "#" .. ns.UI.PlainAnswer(answer)
  `, {}, ALL_FILES, maps + RECORD_TEXT + PRELUDE_DRIVE);
  const [shown, link, set, waypoints, arrow, plain] = out.split('#');
  assert.equal(shown,
    'Geh zu |cff4fc3f7|Hfaiway:69:73.6:45.0:Rok Orhan|h[Rok Orhan (73.6, 45.0)]|h|r, dann '
    + '|cff4fc3f7|Hfaiway:1411:52.0:43.0:Durotar|h[Durotar (52.0, 43.0)]|h|r, '
    + 'nicht Nirgends (10.0, 10.0) oder Fehler (0.0, 200.0). X',
    'known zone (any case): a link; unknown zone or coordinates out of range: plain text');
  assert.equal(link, 'faiway:69:73.6:45.0:Rok Orhan');
  assert.equal(set, 'true');
  assert.equal(waypoints, '69@0.736,0.45@Rok Orhan@true', 'TomTom gets the map id, 0-1 coordinates and the name');
  assert.equal(arrow, '69', 'the arrow points at it even when TomTom already had that waypoint');
  assert.equal(plain, 'Geh zu Rok Orhan (73.6, 45.0), dann Durotar (52.0, 43.0), nicht Nirgends (10.0, 10.0) oder Fehler (0.0, 200.0). [X]');
});

test('a new chat suggests questions about the game window that is open (vendor, auction house...)', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    ns.UI:Refresh()
    local w = ns.UI.welcome
    local before = w.chips[1].label.textValue
    -- The player talks to a vendor.
    ns.Collect.open.merchant = true
    ns.UI:OnGameWindow()
    local title, first, last = w.context.textValue, w.chips[1].label.textValue, w.chips[5].label.textValue
    w.chips[1].scripts.OnClick(w.chips[1])
    local asked = ns.Chats:Get(ns.db.currentChat).messages[1].question
    -- With a conversation going, opening the auction house changes nothing.
    ns.Collect.open.merchant = nil
    ns.Collect.open.auction = true
    ns.UI:OnGameWindow()
    RESULT = table.concat({ before, title, first, last, asked, tostring(w:IsShown()) }, "#")
  `, {}, ALL_FILES, inLocale('esMX'));
  const [before, title, first, last, asked, welcomeShown] = out.split('#');
  assert.equal(before, '¿Qué mazmorra me conviene hacer ahora?');
  assert.match(title, /vendedor abierto/);
  assert.equal(first, '¿Qué me conviene comprarle a este vendedor?');
  assert.equal(last, '¿Qué mazmorra me conviene hacer ahora?', 'then the usual ones');
  assert.equal(asked, first, 'clicking asks it');
  assert.equal(welcomeShown, 'false');
});
test('a proactive tip goes out silently by the voice to its own chat, and a tip the app drops leaves no trace', () => {
  const files = [...ALL_FILES.slice(0, -1), 'ZoneLevels.lua', 'Proactive.lua', 'Core.lua'];
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    local mine = ns.Chats:New()
    mine.messages[1] = { id = "m1", question = "my own question", answer = "an answer", status = "done", t = time() }
    ns.Chats:Select(mine.id)
    -- The player turned tips on in Options → AddOns. An answer must not overwrite that.
    ns.Proactive:SetSettings({ enabled = true, level = true, zone = false })
    ns.Core:ApplyInbox({ answers = {}, proactive = { enabled = false, zone = true } })
    local settings = tostring(ns.db.proactive.enabled) .. tostring(ns.db.proactive.zone)
    -- A level-up: queued, then sent once the app is seen ready.
    ns.Live.CheckApp = function() end
    ns.Live.AppState = function() return "ready" end
    ns.Proactive.readyAt = 0
    FIRE("PLAYER_LEVEL_UP", 12)
    -- Without the voice the tip waits: it never flashes the strip on screen.
    HAS_VOICE = false
    for i = 1, 4 do NOW = NOW + 2; ns.Proactive:Tick() end
    local waited = #SPOKEN .. "/" .. #ns.Proactive.queue .. "/" .. tostring(ns.Uplink.grid and ns.Uplink.grid.shown)
    HAS_VOICE = true
    for i = 1, 4 do NOW = NOW + 2; ns.Proactive:Tick() end
    UNTIL_IDLE()
    local tips
    local proactiveCount = 0
    for _, c in ipairs(ns.db.chats) do
      if c.proactive then
        proactiveCount = proactiveCount + 1
        if c.messages[1] then tips = c end
      end
    end
    ns.Chats:NewProactive("We entered Westfall")
    local afterSecond = 0
    for _, c in ipairs(ns.db.chats) do if c.proactive then afterSecond = afterSecond + 1 end end
    local tip = tips.messages[1]
    RESULT = table.concat({
      settings, tostring(ns.UI:IsShown()), ns.db.currentChat == mine.id and "mine" or "other", #tips.messages, tips.title,
      tostring(tip.proactive.kind), #mine.messages, table.concat(SPOKEN, "\\1"), tip.id, proactiveCount, afterSecond,
      waited, tostring(ns.Uplink.grid and ns.Uplink.grid.shown),
    }, "#")
    -- The app turned it down: the tip disappears without an error or a card.
    ns.Core.working, ns.Uplink.busy = false, false
    ns.Core:ApplyInbox({ answers = { { id = tip.id, ok = false, answer = "", skipped = true } } })
    TIPS_AFTER = #tips.messages
    RESULT = RESULT .. "#" .. TIPS_AFTER .. "#" .. tostring(tips.unread)
  `, {}, files, VOICE_ON + `
    HAS_VOICE = true
    C_VoiceChat.GetTtsVoices = function() return HAS_VOICE and { { voiceID = 7, name = "ForeverAICompanion" } } or {} end
  `);
  const [settings, shown, current, tipCount, title, kind, myCount, spoken, , proactiveCount, afterSecond, waited, strip, after, unread] = out.split('#');
  assert.match(waited, /^0\/1\/(nil|false)$/, 'no voice: the tip waits in the queue and the strip stays hidden');
  assert.notEqual(strip, 'true', 'the strip never shows for a tip');
  assert.equal(settings, 'truefalse');
  assert.notEqual(shown, 'true', 'the window stays closed');
  assert.equal(current, 'mine', 'the open chat is not changed');
  assert.equal(tipCount, '1');
  assert.match(title, /^We've hit level 12/);
  assert.equal(proactiveCount, '1');
  assert.equal(afterSecond, '2', 'the next tip starts another chat');
  assert.equal(kind, 'level');
  assert.equal(myCount, '1', 'nothing lands in the player\'s chat');
  const asm = createAssembler();
  let payload = null;
  for (const s of spoken.split('\x01')) payload = asm.add(s) || payload;
  const req = JSON.parse(payload.toString('utf8'));
  assert.equal(req.proactive.kind, 'level');
  assert.equal(req.proactive.key, 'level:12');
  assert.deepEqual(req.history, [], 'the player\'s chats are not sent');
  assert.match(req.question, /level 12/);
  assert.equal(after, '0');
  assert.equal(unread, 'nil');
});
