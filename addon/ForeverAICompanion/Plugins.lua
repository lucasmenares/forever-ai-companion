-- Other addons asking the companion app through this one ("plugins").
--
-- Only this addon can reach the app: it holds the silent voice, the
-- on-screen line and the mailboxes the answers come back through. A plugin
-- lists this addon as a dependency in its .toc and uses the global
-- ForeverAICompanionAPI:
--
--   ForeverAICompanionAPI.Register("myplugin", {
--     onResult = function(result) ... end,     -- every answer, also after /reload
--     onAppState = function(state) ... end,    -- "ready", "closed"... (Live:AppState)
--   })
--   local id, err = ForeverAICompanionAPI.Request("myplugin", {
--     kind = "report",             -- what the app's side of the plugin should do
--     input = { ... },             -- small parameters of this request
--     sections = { name = value }, -- bigger data: sent only when it changed
--     context = true,              -- also send the character's data (default true)
--     only = { "gear", "stats" },  -- ...but just these sections of it
--     summary = "text",            -- shown in the app's list of questions
--     timeout = 300,               -- seconds to wait for the answer
--     onStatus = function(state, detail, id) end,  -- "preparing" | "sent" | "failed"
--   })
--
-- The app only runs plugins it knows by name (companion/src/plugins.js): a
-- request for any other name is answered with an error. The answer reaches
-- onResult as { id, kind, ok, text, data, model, tokens, timedOut, late }:
-- `data` is the plugin's own table, `text` a short summary or the error.
--
-- Requests waiting for an answer are kept in the saved data, so an answer
-- that arrives after /reload (or the next time the game opens) still gets to
-- the plugin. One nobody is registered for is held until its plugin loads.
local _, ns = ...
local L = ns.L

local Plugins = {}
ns.Plugins = Plugins

Plugins.VERSION = 1
local DEFAULT_TIMEOUT = 300  -- seconds: an analysis takes longer than a chat answer
local MAX_TIMEOUT = 900
local KEEP_LATE = 3600       -- how long an answer that arrives after the timeout is still delivered
local LISTEN_LATE = 900      -- ...and how long the bell is still listened for after it (Live:Tick)
local MAX_HELD = 5
local NAME = "^[a-z][a-z0-9]*$"

local handlers = {} -- name -> { onResult, onAppState }
local watching = {} -- name -> true: keep checking whether the app is open

local function store()
  if not ns.db then return nil end
  ns.db.plugins = ns.db.plugins or {}
  local s = ns.db.plugins
  s.pending = s.pending or {}
  s.held = s.held or {}
  return s
end

local function now()
  return time()
end

-- Hands a result to its plugin, or keeps it until that plugin registers.
local function deliver(name, result)
  local h = handlers[name]
  if h and h.onResult then
    local ok, err = pcall(h.onResult, result)
    if not ok then Plugins.lastError = tostring(err) end
    return
  end
  local s = store()
  if not s then return end
  local held = s.held[name] or {}
  held[#held + 1] = result
  while #held > MAX_HELD do table.remove(held, 1) end
  s.held[name] = held
end

function Plugins:Register(name, h)
  if type(name) ~= "string" or not name:match(NAME) or type(h) ~= "table" then return false end
  handlers[name] = {
    onResult = type(h.onResult) == "function" and h.onResult or nil,
    onAppState = type(h.onAppState) == "function" and h.onAppState or nil,
  }
  -- Results that arrived before this plugin was loaded.
  local s = store()
  local held = s and s.held[name]
  if held and handlers[name].onResult then
    s.held[name] = nil
    for _, result in ipairs(held) do deliver(name, result) end
  end
  return true
end

-- The request's fields the plugin controls, checked.
local function summaryOf(name, opts)
  local text = type(opts.summary) == "string" and ns.Collect.Clean(opts.summary) or ""
  text = strtrim(text):sub(1, 200)
  return text ~= "" and text or (name .. ": " .. opts.kind)
end

local function sectionsOf(name, opts)
  local out
  for k, v in pairs(type(opts.sections) == "table" and opts.sections or {}) do
    if type(k) == "string" and k:match("^[%w_]+$") and v ~= nil then
      out = out or {}
      out[name .. "_" .. k] = v -- "myplugin_list": never one of this addon's own sections
    end
  end
  return out
end

local function onlyOf(opts)
  if type(opts.only) ~= "table" then return nil end
  local set = {}
  for _, k in ipairs(opts.only) do if type(k) == "string" then set[k] = true end end
  return set
end

-- Sends a request for plugin `name`. Returns its id, or nil and why not.
function Plugins:Request(name, opts)
  opts = type(opts) == "table" and opts or {}
  if type(name) ~= "string" or not name:match(NAME) or #name > 24 then return nil, "plugin name" end
  if type(opts.kind) ~= "string" or not opts.kind:match("^[%w_%-%.]+$") or #opts.kind > 40 then return nil, "kind" end
  local s = store()
  if not s then return nil, L.PLUGIN_NOT_READY end
  local Core = ns.Core
  if Core.working or ns.Uplink.busy then return nil, L.WAIT_PREVIOUS end

  local id = string.format("%d%04d", time(), math.random(0, 9999))
  local sig, resetSignals = ns.Live:RequestFields()
  local req = {
    v = 2,
    id = id,
    question = summaryOf(name, opts),
    sig = sig,
    resetSignals = resetSignals,
    charKey = (UnitName("player") or "?") .. "-" .. (GetRealmName and GetRealmName() or "?"), -- as questions send it
    lang = L.code,
    ext = { name = name, kind = opts.kind, v = tonumber(opts.version) or 1, input = type(opts.input) == "table" and opts.input or nil },
  }
  local plugin = { sections = sectionsOf(name, opts), context = opts.context ~= false, only = onlyOf(opts) }
  local timeout = math.min(math.max(tonumber(opts.timeout) or DEFAULT_TIMEOUT, 30), MAX_TIMEOUT)
  local entry = { name = name, kind = opts.kind, t = now(), timeout = timeout }
  s.pending[id] = entry

  local function status(state, detail)
    if type(opts.onStatus) == "function" then pcall(opts.onStatus, state, detail, id) end
  end
  local function fail(msg)
    Core.working = false
    s.pending[id] = nil
    status("failed", msg)
  end

  status("preparing")
  Core.working = true
  -- Prepared a few milliseconds per frame, like a question (Core.step). The
  -- invisible voice when it is there; otherwise the on-screen line, which
  -- only fits small requests.
  local co = coroutine.create(function()
    if ns.Voice:Available() then
      local frame = Core:BuildFrame(req, Core.step, ns.Voice.MAX_FRAME_BYTES, nil, plugin)
      if frame and ns.Voice:Send(frame, req.id, Core.step) then
        Core.lastChannel = "voice"
        return true, "voice"
      end
    end
    Core.lastChannel = "strip"
    local frame = Core:BuildFrame(req, Core.step, nil, nil, plugin)
    if not frame then return false, L.PLUGIN_TOO_BIG end
    return ns.Uplink:Prepare(frame, Core.step)
  end)
  self.driver = self.driver or CreateFrame("Frame")
  self.driver:SetScript("OnUpdate", function(f)
    Core.deadline = (debugprofilestop and debugprofilestop() or GetTime() * 1000) + Core.BUDGET_MS
    local resumed, ok, err = coroutine.resume(co)
    if coroutine.status(co) ~= "dead" then return end
    f:SetScript("OnUpdate", nil)
    if not resumed then return fail(string.format(L.PREP_ERROR, tostring(ok))) end
    if not ok then return fail(tostring(err)) end
    entry.sent = req.hashes
    -- What had to be left out to make it fit (0 = nothing), for the plugin to say so.
    local detail = { trimmed = Core.lastEncode and Core.lastEncode.level or 0 }
    if err == "voice" then
      entry.viaVoice = true
      Core.working = false
      ns.Live:OnSent(true)
      detail.channel = "voice"
      return status("sent", detail)
    end
    ns.Uplink:Reveal(function()
      Core.working = false
      ns.Live:OnSent(true)
      detail.channel = "strip"
      status("sent", detail)
    end)
  end)
  return id
end

-- Forgets a request: its answer, if one still comes, is dropped.
function Plugins:Cancel(name, id)
  local s = store()
  local e = s and s.pending[id]
  if e and e.name == name then s.pending[id] = nil end
end

-- The requests of `name` still waiting: { [id] = { kind, t, timeout } }.
function Plugins:Pending(name)
  local out = {}
  local s = store()
  for id, e in pairs(s and s.pending or {}) do
    if e.name == name and not e.timedOut then out[id] = { kind = e.kind, t = e.t, timeout = e.timeout } end
  end
  return out
end

-- True while a request waits for its answer (Core:HasPending asks, so the
-- mailboxes keep being checked). One past its timeout fails, but stays for a
-- while in case the answer is only late.
function Plugins:HasPending(at)
  local s = store()
  if not s then return false end
  at = at or now()
  local any = false
  for id, e in pairs(s.pending) do
    local age = at - (e.t or at)
    if e.timedOut then
      if age > KEEP_LATE then s.pending[id] = nil end
    elseif age > (e.timeout or DEFAULT_TIMEOUT) then
      e.timedOut = true
      deliver(e.name, { id = id, kind = e.kind, ok = false, timedOut = true, text = L.NO_ANSWER })
    else
      any = true
    end
  end
  return any
end

-- A request gave up waiting a short while ago: its answer may only be late
-- (two rounds with the AI can take longer than the plugin said it would
-- wait). Live keeps listening for the bell, without opening mailboxes on the
-- timer, so the answer is picked up when it comes.
function Plugins:ListeningLate(at)
  local s = store()
  if not s then return false end
  at = at or now()
  for _, e in pairs(s.pending) do
    if e.timedOut and at - (e.t or at) <= (e.timeout or DEFAULT_TIMEOUT) + LISTEN_LATE then return true end
  end
  return false
end

-- Something may have been answered while the game was closed or after the
-- timeout: worth opening one mailbox at login (Live:Init).
function Plugins:AwaitingLate()
  local s = store()
  return s ~= nil and next(s.pending) ~= nil
end

-- Answers in a mailbox that belong to a plugin. `data`: the character's
-- saved data (the sections the app has now cached are remembered there).
-- Returns how many arrived.
function Plugins:ApplyInbox(inbox, data)
  local s = store()
  if not s or type(inbox) ~= "table" or type(inbox.answers) ~= "table" then return 0 end
  local arrived = 0
  for _, a in ipairs(inbox.answers) do
    local e = type(a) == "table" and a.id ~= nil and s.pending[a.id] or nil
    if e then
      s.pending[a.id] = nil
      if e.viaVoice then ns.Voice.broken = nil end
      if type(data) == "table" then
        data.acked = data.acked or {}
        for k, h in pairs(e.sent or {}) do data.acked[k] = h end
      end
      arrived = arrived + 1
      local result = {
        id = a.id, kind = e.kind, ok = a.ok and true or false, text = a.answer, model = a.model,
        data = type(a.data) == "table" and a.data or nil, late = e.timedOut or nil,
      }
      -- The app keeps only the newest results in the mailboxes.
      if a.dataDropped and not result.data then result.ok, result.text = false, L.PLUGIN_EXPIRED end
      if type(a.tokens) == "table" then
        result.tokens = { i = tonumber(a.tokens.i) or 0, c = tonumber(a.tokens.c) or 0, o = tonumber(a.tokens.o) or 0 }
      end
      deliver(e.name, result)
    end
  end
  -- The app saw the on-screen line but could not read it.
  local failedAt = tonumber(inbox.failedAt)
  if failedAt then
    for id, e in pairs(s.pending) do
      if not e.viaVoice and not e.timedOut and e.t and e.t <= failedAt and e.t >= failedAt - 300 then
        s.pending[id] = nil
        arrived = arrived + 1
        deliver(e.name, { id = id, kind = e.kind, ok = false, text = (inbox.failMessage or L.READ_FAILED) .. " " .. L.TRY_AGAIN })
      end
    end
  end
  return arrived
end

-- App status for plugins: they ask for it to be checked while their own
-- window is open (Live checks it only while someone is looking).
function Plugins:Watch(name, on)
  watching[name] = on and true or nil
  if on then ns.Live:CheckApp() end
end

function Plugins:Watching()
  return next(watching) ~= nil
end

function Plugins:AppStateChanged(state)
  for _, h in pairs(handlers) do
    if h.onAppState then pcall(h.onAppState, state) end
  end
end

-- The public face ---------------------------------------------------------------
-- Functions, not methods: ForeverAICompanionAPI.Request("myplugin", { ... }).

ForeverAICompanionAPI = {
  VERSION = Plugins.VERSION,
  Register = function(name, h) return Plugins:Register(name, h) end,
  Request = function(name, opts) return Plugins:Request(name, opts) end,
  Cancel = function(name, id) return Plugins:Cancel(name, id) end,
  Pending = function(name) return Plugins:Pending(name) end,
  -- A question or request is being prepared right now: try again in a moment.
  Busy = function() return (ns.Core.working or ns.Uplink.busy) and true or false end,
  -- "ready" | "checking" | "closed" | "stuck" | "need-ai" | "need-login" | "problem" | "restart" | "nosound" | "unknown"
  AppState = function() return ns.Live:AppState() end,
  WatchApp = function(name, on) return Plugins:Watch(name, on) end,
  -- The invisible channel is there: requests of any size fit (the on-screen line only takes small ones).
  CanSendLarge = function() return ns.Voice:Available() and true or false end,
  -- An item link as this addon describes it to the AI (name, itemId, quality,
  -- equipSlot, itemLevel, reqLevel, and with `full`: stats, effects, weapon damage).
  DescribeItem = function(link, full)
    local ok, item = pcall(ns.Collect.DescribeItem, link, full)
    return ok and item or nil
  end,
  -- The cheapest auction buyout seen for an item on this realm and faction:
  -- { name, unit (copper per item), seenAt } or nil.
  AuctionPrice = function(itemId)
    local ok, prices = pcall(ns.Core.Prices, ns.Core)
    return ok and type(prices) == "table" and prices[itemId] or nil
  end,
}
