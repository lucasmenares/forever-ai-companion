local ADDON, ns = ...
local L = ns.L

local Core = {}
ns.Core = Core

local HISTORY_TURNS_SENT = 6      -- earlier Q&A of the same chat sent along
local HISTORY_ANSWER_CHARS = 600
local PENDING_TIMEOUT = 150       -- seconds

local function chat(msg)
  print("|cff66ccffForever AI:|r " .. msg)
end

function Core:FindEntry(id)
  return ns.Chats:FindEntry(id)
end

-- A question sent through the invisible voice with no answer after this
-- long is also sent through the strip, as the same question (same id): the
-- app answers it once, whichever copy it got. A slow answer (the AI taking a
-- while, a first start) is not a lost question: the voice is only given up
-- for the session when no answer comes back at all (PENDING_TIMEOUT). Giving
-- it up after these 45 s left a Mac without the Screen Recording permission
-- (the strip can't be read there) with no answers until /reload.
local VOICE_TIMEOUT = 45

function Core:HasPending()
  local now = time()
  local any = false
  local resend
  ns.Chats:EachEntry(function(e, c)
    if e.status ~= "pending" then return end
    if now - (e.t or now) > PENDING_TIMEOUT then
      e.status = "error"
      e.answer = L.NO_ANSWER
      e.timedOut = true -- an answer that still arrives is shown (see ApplyInbox)
      -- Sent through the voice and nothing came back, not even after the strip:
      -- the voice isn't working this session.
      if e.viaVoice then ns.Voice.broken = true end
      ns.UI:Refresh()
      return
    end
    any = true
    if e.viaVoice and not e.resent and not resend and not self.working and now - (e.t or now) > VOICE_TIMEOUT then
      e.resent = true
      resend = { entry = e, question = e.shown or e.question, chatId = c.id }
    end
  end)
  if resend then
    C_Timer.After(0, function() Core:Ask(resend.question, nil, resend.chatId, resend.entry) end)
  end
  -- Requests other addons sent through this one (Plugins.lua).
  if ns.Plugins and ns.Plugins:HasPending(now) then any = true end
  return any
end

-- Earlier answered turns of a chat (before the question being asked now).
function Core:RecentTurns(chatData, n)
  local turns = {}
  local messages = chatData and chatData.messages or {}
  for i = #messages, 1, -1 do
    local e = messages[i]
    if e.status == "done" then
      table.insert(turns, 1, { q = e.question, a = (e.answer or ""):sub(1, HISTORY_ANSWER_CHARS) })
      if #turns >= n then break end
    end
  end
  return turns
end

-- Sections that change on almost every question are always sent in full.
local ALWAYS_SEND = { localTime = true, serverTime = true, diagnostics = true }

-- Work allowed per frame while preparing a question, in milliseconds.
-- Spreading the work over several frames is what keeps the game from stuttering.
Core.BUDGET_MS = 4

local floor = math.floor
local function now()
  return debugprofilestop and debugprofilestop() or GetTime() * 1000
end

-- Pauses the preparation until the next frame once this frame's budget is used.
-- Only valid inside the preparation coroutine.
function Core.step()
  if now() > (Core.deadline or 0) then coroutine.yield() end
end

-- Copies of a list of tables without some keys (cached data is never modified).
local function without(list, keys, keep)
  if type(list) ~= "table" then return list end
  local out = {}
  for _, item in ipairs(list) do
    if type(item) == "table" then
      if not keep or keep(item) then
        local copy = {}
        for k, v in pairs(item) do copy[k] = v end
        for _, k in ipairs(keys) do copy[k] = nil end
        out[#out + 1] = copy
      end
    else
      out[#out + 1] = item
    end
  end
  return out
end

-- Successive reductions if a request does not fit. Each one replaces whole
-- sections with smaller copies.
-- Known recipes without the ones that no longer give skill, and without reagents.
local function slimRecipes(list)
  if type(list) ~= "table" then return list end
  local out = {}
  for _, p in ipairs(list) do
    local copy = {}
    for k, v in pairs(p) do copy[k] = v end
    copy.recipes = without(p.recipes, { "reagents" }, function(r) return r.difficulty ~= "grey" end)
    out[#out + 1] = copy
  end
  return out
end

-- Open windows with shorter lists: vendor and loot items without their stats,
-- and at most 25 vendor items / 30 trainer services.
local function slimScreen(screen)
  if type(screen) ~= "table" then return screen end
  local out = {}
  for k, v in pairs(screen) do out[k] = v end
  local function first(list, n)
    if type(list) ~= "table" then return list end
    local cut = {}
    for i = 1, math.min(#list, n) do cut[i] = list[i] end
    return cut
  end
  if type(screen.merchant) == "table" then
    local m = {}
    for k, v in pairs(screen.merchant) do m[k] = v end
    m.items = first(without(screen.merchant.items, { "stats", "effects" }), 25)
    out.merchant = m
  end
  if type(screen.trainer) == "table" then
    local t = {}
    for k, v in pairs(screen.trainer) do t[k] = v end
    t.services = first(screen.trainer.services, 30)
    out.trainer = t
  end
  out.loot = without(screen.loot, { "stats", "effects" })
  if type(screen.auction) == "table" then
    local a = {}
    for k, v in pairs(screen.auction) do a[k] = v end
    a.results = first(screen.auction.results, 15)
    a.myAuctions = first(screen.auction.myAuctions, 15)
    out.auction = a
  end
  if type(screen.flightMap) == "table" then
    out.flightMap = { from = screen.flightMap.from, destinations = without(screen.flightMap.destinations, { "stops" }) }
  end
  return out
end

local TRIMS = {
  function(ctx) ctx.bank = nil end,
  function(ctx) ctx.knownRecipes = slimRecipes(ctx.knownRecipes) end,
  function(ctx) ctx.screen = slimScreen(ctx.screen) end,
  function(ctx, req) req.history = nil end,
  function(ctx) ctx.quests = without(ctx.quests, { "rewardItems", "rewardChoices" }) end,
  function(ctx)
    ctx.inventory = without(ctx.inventory, { "stats", "effects" }, function(it) return it.quality ~= "poor" end)
  end,
  function(ctx)
    ctx.spells, ctx.currencies, ctx.reputations = nil, nil, nil
    ctx.actionBars, ctx.spellsNotOnBars, ctx.stable, ctx.auctionPrices = nil, nil, nil, nil
  end,
  function(ctx) ctx.quests = without(ctx.quests, { "goal", "nextStep" }) end,
  function(ctx)
    ctx.gear = without(ctx.gear, { "stats", "effects" })
    ctx.quests = without(ctx.quests, { "objectives" })
  end,
  function(ctx) ctx.knownRecipes = nil end,
  function(ctx) ctx.quests, ctx.professions, ctx.inventory = nil, nil, nil end,
}

-- Request JSON from sections that are (mostly) already encoded.
local function assemble(req, ctx, encoded, step)
  local keys = {}
  for k in pairs(ctx) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for _, k in ipairs(keys) do
    parts[#parts + 1] = '"' .. k .. '":' .. (encoded[k] or ns.Json.Encode(ctx[k]))
    step()
  end
  local head = ns.Json.Encode(req) -- everything except the context
  return head:sub(1, -2) .. ',"context":{' .. table.concat(parts, ",") .. "}}"
end

-- Gathers the character data and turns it into the bytes to draw.
-- Only what changed is sent: sections whose hash the companion already
-- confirmed (it answered a request that carried them) go as { name = hash }
-- in `same`, and the companion fills them in from its cache.
-- maxBytes: size limit for channels without the screen's limits (voice).
-- extra: more context for this question only (e.g. the items linked in it).
-- plugin: a request from another addon (Plugins.lua): { context = false } to
-- leave the character's data out, { only = { section = true } } to send just
-- those sections of it, { sections = { name = value } } for the plugin's own
-- data, which is skipped like ours once the companion has it.
function Core:BuildFrame(req, step, maxBytes, extra, plugin)
  local fits = maxBytes and function(len) return len <= maxBytes end
    or function(len) return ns.Uplink:Fits(len) end
  local t0 = now()
  local snap, meta, errors
  if plugin and plugin.context == false then
    snap, meta, errors = {}, {}, {}
  else
    snap, meta, errors = ns.Collect:Gather(step)
  end
  if plugin and plugin.only then
    for k in pairs(snap) do
      if not plugin.only[k] then snap[k] = nil end
    end
  end
  for k, v in pairs(extra or {}) do snap[k] = v end
  for k, v in pairs(plugin and plugin.sections or {}) do
    local json = ns.Json.Encode(v)
    snap[k], meta[k] = v, { value = v, json = json, hash = ns.Json.Hash(json) }
    step()
  end
  local t1 = now()
  local acked = self:CharData().acked or {}
  local ctx, encoded, hashes, same = {}, {}, {}, {}
  for k, v in pairs(snap) do
    local m = meta[k]
    if m and not ALWAYS_SEND[k] and acked[k] == m.hash then
      same[k] = m.hash
    else
      ctx[k] = v
      if m then encoded[k], hashes[k] = m.json, m.hash end
    end
  end
  if next(errors) then ctx.diagnostics = errors end
  req.hashes, req.same = hashes, same

  local frame, json
  for level = 0, #TRIMS do
    if level > 0 then
      local before = {}
      for k, v in pairs(ctx) do before[k] = v end
      TRIMS[level](ctx, req)
      -- Trimmed sections are re-encoded and not cached by the companion.
      for k, v in pairs(before) do
        if ctx[k] ~= v then encoded[k], hashes[k] = nil, nil end
      end
    end
    json = assemble(req, ctx, encoded, step)
    frame = ns.Uplink.Frame(json, step)
    if fits(#frame) then
      self.lastEncode = {
        level = level, bytes = #frame, json = #json,
        collectMs = floor(t1 - t0), encodeMs = floor(now() - t1),
      }
      return frame
    end
    step()
  end
  self.lastEncode = { failed = string.format(L.FRAME_TOO_BIG, #frame, #json) }
  return nil, self.lastEncode.failed
end


-- Per-character data remembered between sessions.
function Core:CharData()
  if not ns.db then return nil end
  local key = (UnitName("player") or "?") .. "-" .. (GetRealmName and GetRealmName() or "?")
  ns.db.chars = ns.db.chars or {}
  ns.db.chars[key] = ns.db.chars[key] or {}
  return ns.db.chars[key]
end

function Core:RememberBank()
  local items = ns.Collect.ContainerItems(ns.Collect.BankBags(), false)
  if items and #items > 0 then
    self:CharData().bank = { seenAt = date("%Y-%m-%d %H:%M"), items = items }
  end
end

function Core:RememberFlightPaths()
  local data = self:CharData()
  data.flightPaths = data.flightPaths or {}
  if C_TaxiMap and C_TaxiMap.GetAllTaxiNodes then
    local mapID = (GetTaxiMapID and GetTaxiMapID()) or (C_Map and C_Map.GetBestMapForUnit("player"))
    local unreachable = Enum and Enum.FlightPathState and Enum.FlightPathState.Unreachable
    for _, node in ipairs(C_TaxiMap.GetAllTaxiNodes(mapID) or {}) do
      if node.name and node.state ~= unreachable then data.flightPaths[node.name] = true end
    end
  elseif NumTaxiNodes and TaxiNodeName then
    for i = 1, NumTaxiNodes() do
      if TaxiNodeGetType(i) ~= "NONE" then data.flightPaths[TaxiNodeName(i)] = true end
    end
  end
end

-- The open profession window's recipes, remembered per character and
-- profession (the game only lists them while the window is open).
-- kind: "craft" for the classic enchanting-style window.
function Core:RememberRecipes(kind)
  local p = ns.Collect:Recipes(kind)
  if not p or not p.profession or #p.recipes == 0 then return end
  p.seenAt = date("%Y-%m-%d %H:%M")
  local data = self:CharData()
  data.recipes = data.recipes or {}
  data.recipes[p.profession] = p
end

-- What Beast Training teaches and the pet already knows, remembered (the
-- game only lists it while the window is open).
function Core:RememberBeastTraining(kind)
  local b = ns.Collect:BeastTraining(kind)
  if not b then return false end
  b.seenAt = date("%Y-%m-%d %H:%M")
  self:CharData().beastTraining = b
  return true
end

-- Auction prices seen, per realm and faction (each has its own auction house):
-- itemId -> { name, unit = cheapest buyout per item in copper, seenAt }.
local MAX_PRICES = 1000
function Core:Prices()
  if not ns.db then return nil end
  local key = (GetRealmName and GetRealmName() or "?") .. "-" .. (UnitFactionGroup and UnitFactionGroup("player") or "?")
  ns.db.prices = ns.db.prices or {}
  ns.db.prices[key] = ns.db.prices[key] or {}
  return ns.db.prices[key]
end

function Core:RememberPrices()
  local prices = self:Prices()
  if not prices then return end
  local seenAt = date("%Y-%m-%d %H:%M")
  for _, p in ipairs(ns.Collect:AuctionPrices() or {}) do
    if p.itemId and p.unit and p.unit > 0 and p.name then
      prices[p.itemId] = { name = p.name, unit = math.floor(p.unit), seenAt = seenAt }
    end
  end
  -- Keep the most recent ones.
  local ids = {}
  for id in pairs(prices) do ids[#ids + 1] = id end
  if #ids > MAX_PRICES then
    table.sort(ids, function(a, b) return prices[a].seenAt > prices[b].seenAt end)
    for i = MAX_PRICES + 1, #ids do prices[ids[i]] = nil end
  end
end

function Core:RememberStable()
  local pets = ns.Collect:StablePets()
  if pets then self:CharData().stable = { seenAt = date("%Y-%m-%d %H:%M"), pets = pets } end
end

function Core:RememberTurnIn(questID)
  local title = C_QuestLog and C_QuestLog.GetTitleForQuestID and C_QuestLog.GetTitleForQuestID(questID)
  if not title then return end
  local data = self:CharData()
  data.turnedIn = data.turnedIn or {}
  table.insert(data.turnedIn, 1, title)
  while #data.turnedIn > 10 do table.remove(data.turnedIn) end
end

-- `extra`: additional request fields (used by the channel probe).
-- `chatId`: chat the question belongs to (default: the open one).
-- Returns the request id, or nil when nothing was sent.
-- again: a question already asked (its chat entry), sent once more through
-- the strip with the same id (see VOICE_TIMEOUT).
function Core:Ask(question, extra, chatId, again)
  -- Items (and spells, quests...) linked with shift-click go along with their
  -- full description; the question itself keeps just their "[Name]".
  local linked = ns.Collect:Links(question)
  local shown = linked and strtrim(question) or nil -- with the links, for the chat bubble
  question = strtrim(ns.Collect.Clean(question or "") or "")
  if question == "" then return end
  -- Asking in combat is allowed: the window then warns the player to keep an
  -- eye on the game (see Combat.lua).
  ns.UI:Show()
  if self.working or ns.Uplink.busy then
    ns.UI:SetStatus(L.WAIT_PREVIOUS)
    return
  end

  -- Asking before choosing an assistant: keep the one of the character's faction.
  if not ns.Personas:Chosen() then ns.Personas:Set(ns.Personas:Suggested().id) end
  ns.UI.choosing = false

  -- The question belongs to the open chat (or to the given one, for resends).
  local chatData = ns.Chats:Get(chatId) or ns.Chats:Current()
  local id = again and again.id or string.format("%d%04d", time(), math.random(0, 9999))
  local sig, resetSignals = ns.Live:RequestFields()
  local req = {
    v = 2,
    id = id,
    question = question,
    sig = sig,
    resetSignals = resetSignals,
    charKey = (UnitName("player") or "?") .. "-" .. (GetRealmName and GetRealmName() or "?"),
    assistant = ns.Personas:Current().id,
    lang = L.code,                  -- the app writes its error messages in this language
    history = self:RecentTurns(chatData, HISTORY_TURNS_SENT),
  }
  for k, v in pairs(extra or {}) do req[k] = v end

  local entry = again or { id = id, question = question, shown = shown, status = "pending", t = time() }
  if not again then ns.Chats:AddMessage(chatData, entry) end
  req.chat = { id = chatData.id, title = chatData.title }

  local function fail(msg)
    Core.working = false
    entry.status = "error"
    entry.answer = msg
    ns.UI:SetStatus("")
    ns.UI:Refresh()
  end

  ns.UI:Refresh()
  ns.UI:SetStatus(L.PREPARING)
  self.working = true

  -- The preparation runs a few milliseconds per frame (see Core.step).
  -- Invisible voice channel when available; otherwise the strip on screen.
  local context = linked and { linkedItems = linked } or nil
  local co = coroutine.create(function()
    if not again and ns.Voice:Available() then
      local frame = Core:BuildFrame(req, Core.step, ns.Voice.MAX_FRAME_BYTES, context)
      if frame and ns.Voice:Send(frame, req.id, Core.step) then
        Core.lastChannel = "voice"
        return true, "voice"
      end
    end
    Core.lastChannel = "strip"
    local frame, why = Core:BuildFrame(req, Core.step, nil, context)
    if not frame then return false, why end
    return ns.Uplink:Prepare(frame, Core.step)
  end)
  self.driver = self.driver or CreateFrame("Frame")
  local frames = 0
  self.driver:SetScript("OnUpdate", function(f)
    frames = frames + 1
    Core.deadline = now() + Core.BUDGET_MS
    local resumed, ok, err = coroutine.resume(co)
    if coroutine.status(co) ~= "dead" then return end
    f:SetScript("OnUpdate", nil)
    if not resumed then
      fail(string.format(L.PREP_ERROR, tostring(ok)))
      return
    end
    if not ok then
      fail(string.format(L.PREP_FAILED, tostring(err)))
      return
    end
    if Core.lastEncode then Core.lastEncode.frames = frames end
    entry.sent = req.hashes
    if err == "voice" then
      entry.viaVoice = true
      Core.working = false
      ns.UI:SetStatus(string.format(L.SENT_TO, ns.Personas:Current().name))
      ns.Live:OnSent()
      return
    end
    ns.UI:SetStatus(string.format(L.SENDING, ns.Uplink.last.bytes / 1024))
    ns.Uplink:Reveal(function()
      Core.working = false
      ns.UI:SetStatus(string.format(L.SENT_TO, ns.Personas:Current().name))
      ns.Live:OnSent()
    end)
  end)
  return id
end


function Core:ApplyInbox(inbox)
  if type(inbox) ~= "table" or type(inbox.answers) ~= "table" then return end
  local arrived = 0
  local toNotify = {}
  local answered = {}
  local data = self:CharData()
  for _, a in ipairs(inbox.answers) do
    local entry, owner
    if type(a) == "table" then entry, owner = self:FindEntry(a.id) end
    -- Pending, or given up waiting: an answer that arrives late is still shown.
    if entry and (entry.status == "pending" or entry.timedOut) then
      entry.timedOut = nil
      -- It came back: the app got the question, so the voice works after all.
      if entry.viaVoice then ns.Voice.broken = nil end
      entry.status = a.ok and "done" or "error"
      entry.answer = a.answer
      -- Tokens the answer used (read, of which cached, written), if the AI said.
      if type(a.tokens) == "table" then
        entry.tokens = { i = tonumber(a.tokens.i) or 0, c = tonumber(a.tokens.c) or 0, o = tonumber(a.tokens.o) or 0 }
      end
      arrived = arrived + 1
      answered[#answered + 1] = { id = a.id, ok = a.ok and true or false }
      -- Chats with news the player is not looking at: mark and notify.
      owner.updated = time()
      if owner.id ~= ns.db.currentChat or not ns.UI:IsShown() then
        owner.unread = true
        toNotify[#toNotify + 1] = { entry = entry, chat = owner }
      end
      -- The companion has now cached these sections: next time, skip them.
      data.acked = data.acked or {}
      for k, h in pairs(entry.sent or {}) do data.acked[k] = h end
      entry.sent = nil
    end
  end
  -- Answers to requests other addons sent through this one (Plugins.lua).
  if ns.Plugins and ns.Plugins:ApplyInbox(inbox, data) > 0 then ns.Live:OnAnswer() end
  -- The companion lost its cache: send everything next time.
  if inbox.resync and tonumber(inbox.resync) and tonumber(inbox.resync) > (data.resyncSeen or 0) then
    data.resyncSeen = tonumber(inbox.resync)
    data.acked = nil
  end
  -- The companion saw our screenshot but could not read it: fail the
  -- questions sent shortly before that instead of waiting forever.
  local failedAt = tonumber(inbox.failedAt)
  if failedAt then
    ns.Chats:EachEntry(function(e)
      if e.status == "pending" and e.t and e.t <= failedAt and e.t >= failedAt - 300 then
        e.status = "error"
        e.answer = (inbox.failMessage or L.READ_FAILED) .. " " .. L.TRY_AGAIN
        arrived = arrived + 1
      end
    end)
  end
  if arrived > 0 then
    ns.Live:OnAnswer()
    ns.UI:SetStatus("")
    ns.UI:Refresh()
    if ns.Button then ns.Button:Update() end
    if #toNotify > 0 and ns.Notify then
      for _, n in ipairs(toNotify) do ns.Notify:Show(n.entry, n.chat) end
    elseif ns.Button and ns.Button.Celebrate then
      ns.Button:Celebrate() -- answer in the open chat: no card, just the hop
    end
  end
  -- The channel test waits for the app's answer before it starts.
  if ns.Probe and ns.Probe.OnAnswer then
    for _, a in ipairs(answered) do ns.Probe:OnAnswer(a.id, a.ok) end
  end
end

-- Events ------------------------------------------------------------------

local events = CreateFrame("Frame")
for _, e in ipairs({ "ADDON_LOADED", "PLAYER_LOGIN", "BANKFRAME_OPENED", "BANKFRAME_CLOSED",
                     "PLAYERBANKSLOTS_CHANGED", "TAXIMAP_OPENED", "QUEST_TURNED_IN",
                     "TRADE_SKILL_SHOW", "TRADE_SKILL_UPDATE", "TRADE_SKILL_LIST_UPDATE",
                     "CRAFT_SHOW", "CRAFT_UPDATE", "TRAINER_SHOW", "TRAINER_UPDATE",
                     "PET_STABLE_SHOW", "PET_STABLE_UPDATE",
                     "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED", "AUCTION_HOUSE_BROWSE_RESULTS_ADDED",
                     "COMMODITY_SEARCH_RESULTS_UPDATED", "ITEM_SEARCH_RESULTS_UPDATED",
                     "AUCTION_ITEM_LIST_UPDATE" }) do
  pcall(events.RegisterEvent, events, e)
end

-- Profession windows fire their update events in bursts: read once it settles.
-- "trainer" is Beast Training (a trainer window in WoW Forever).
local RECIPE_EVENTS = {
  TRADE_SKILL_SHOW = "trade", TRADE_SKILL_UPDATE = "trade", TRADE_SKILL_LIST_UPDATE = "trade",
  CRAFT_SHOW = "craft", CRAFT_UPDATE = "craft", TRAINER_SHOW = "trainer", TRAINER_UPDATE = "trainer",
  -- Auction results on screen: remember their prices.
  AUCTION_HOUSE_BROWSE_RESULTS_UPDATED = "prices", AUCTION_HOUSE_BROWSE_RESULTS_ADDED = "prices",
  COMMODITY_SEARCH_RESULTS_UPDATED = "prices", ITEM_SEARCH_RESULTS_UPDATED = "prices",
  AUCTION_ITEM_LIST_UPDATE = "prices",
}
local recipesPending = {}
local function rememberRecipesSoon(kind)
  if recipesPending[kind] then return end
  recipesPending[kind] = true
  C_Timer.After(0.5, function()
    recipesPending[kind] = nil
    if kind == "prices" then
      pcall(Core.RememberPrices, Core)
    elseif kind == "trainer" then
      pcall(Core.RememberBeastTraining, Core)
    elseif kind == "craft" then
      -- A classic craft window is either enchanting or Beast Training.
      local ok, isBeast = pcall(Core.RememberBeastTraining, Core, "craft")
      if not (ok and isBeast) then pcall(Core.RememberRecipes, Core, kind) end
    else
      pcall(Core.RememberRecipes, Core, kind)
    end
  end)
end

events:SetScript("OnEvent", function(_, event, arg1)
  if event == "ADDON_LOADED" and arg1 == ADDON then
    ForeverAICompanion_DB = ForeverAICompanion_DB or {}
    ns.db = ForeverAICompanion_DB
    ns.Chats:Init()
  elseif event == "PLAYER_LOGIN" then
    ns.Uplink:Init()
    ns.Live:Init()
    if ns.Button then pcall(ns.Button.Init, ns.Button) end
    -- Build the strip's textures in the background once the login rush is over.
    C_Timer.After(5, function() pcall(ns.Uplink.Warmup, ns.Uplink) end)
  elseif not ns.db then
    return
  elseif event == "BANKFRAME_OPENED" or event == "BANKFRAME_CLOSED" or event == "PLAYERBANKSLOTS_CHANGED" then
    -- Bank contents are only readable while it is open: remember them.
    if event ~= "BANKFRAME_CLOSED" or not Core.bankSaved then pcall(Core.RememberBank, Core) end
    Core.bankSaved = event ~= "BANKFRAME_CLOSED" and true or nil
  elseif event == "TAXIMAP_OPENED" then
    pcall(Core.RememberFlightPaths, Core)
  elseif event == "QUEST_TURNED_IN" then
    pcall(Core.RememberTurnIn, Core, arg1)
  elseif RECIPE_EVENTS[event] then
    rememberRecipesSoon(RECIPE_EVENTS[event])
  elseif event == "PET_STABLE_SHOW" or event == "PET_STABLE_UPDATE" then
    pcall(Core.RememberStable, Core)
  end
end)

-- Slash commands -------------------------------------------------------------

-- Subcommands work in English and Spanish, whatever the game's language.
local COMMANDS = {
  new = "new", nuevo = "new",
  data = "data", datos = "data",
  inbox = "inbox", buzon = "inbox", ["buzón"] = "inbox",
  status = "status", estado = "status",
  probe = "probe", probar = "probe", ["probar-canales"] = "probe",
  ["test-voice"] = "voice", ["probar-voz"] = "voice",
  button = "button", boton = "button", ["botón"] = "button",
  sound = "sound", sonido = "sound",
  assistant = "assistant", asistente = "assistant",
  help = "help", ayuda = "help",
}
Core.COMMANDS = COMMANDS

SLASH_FOREVERAICOMPANION1 = "/ia"
SLASH_FOREVERAICOMPANION2 = "/azia"
SLASH_FOREVERAICOMPANION3 = "/ai"
SlashCmdList.FOREVERAICOMPANION = function(msg)
  msg = strtrim(msg or "")
  local lower = msg:lower()
  local word, rest = lower:match("^(%S+)%s*(.-)$")
  local cmd = COMMANDS[word or ""]
  if lower == "" then
    ns.UI:Toggle()
  elseif cmd == "data" and rest == "" then
    ns.UI:ShowContext()
  elseif cmd == "inbox" and rest == "" then
    ns.Live:LoadNextSlot()
  elseif cmd == "status" and rest == "" then
    chat(ns.Live:Status())
  elseif cmd == "probe" and rest == "" then
    ns.Probe:Run()
  elseif cmd == "voice" and rest == "" then
    ns.Voice:Diagnose()
  elseif cmd == "button" and rest == "" then
    ns.Button:Toggle()
  elseif cmd == "button" and rest == "reset" then
    ns.Button:Reset()
    chat(L.BUTTON_RESET)
  elseif cmd == "sound" and rest == "" then
    chat(ns.Notify:ToggleSound() and L.SOUND_ON or L.SOUND_OFF)
  elseif cmd == "new" and rest == "" then
    ns.Chats:New()
    ns.UI:Show()
    ns.UI:Refresh()
  elseif cmd == "assistant" and rest == "" then
    ns.UI:ShowChooser()
  elseif cmd == "assistant" and (rest == "fizzi" or rest == "rizzik") then
    ns.Personas:Set(rest)
    chat(string.format(L.NOW_YOUR_ASSISTANT, ns.Personas:Current().name))
  elseif cmd == "help" and rest == "" then
    chat(L.HELP)
  else
    Core:Ask(msg)
  end
end

function ForeverAICompanion_Toggle()
  ns.UI:Toggle()
end
