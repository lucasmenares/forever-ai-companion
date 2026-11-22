-- Companion -> game transport, without /reload.
-- The installer creates SLOTS LoadOnDemand addons (ForeverAICompanion_S01..). Each
-- contains Inbox.lua, which the companion rewrites with the latest answers.
-- LoadAddOn() reads the file from disk, so loading a not-yet-used slot
-- delivers fresh data. Each slot can only be loaded once per UI session.
--
-- To know *when* to load a slot, the companion "rings" signal files
-- sig/NNN.wav: an empty file cannot be played, a short silent WAV can.
-- WoW only sees files that existed at startup, so all of them are created
-- empty by the installer and only their content changes afterwards.
--
-- On Windows, PlaySoundFile refuses an empty file right away. On macOS it
-- says yes to any file that exists, but an empty one stops at once: there
-- the files are played and checked a moment later with C_Sound.IsPlaying
-- ("deferred" checks, see Live:Probe). Trusting the first answer on a Mac
-- took every signal as rung and used up the mailboxes in a few questions.
local _, ns = ...

local Live = {}
ns.Live = Live

Live.SLOTS = 50
Live.SIGNALS = 500
local TICK = 2
local SIG_PATH = "Interface\\AddOns\\ForeverAICompanion\\sig\\%03d.wav"
local OK_PATH = "Interface\\AddOns\\ForeverAICompanion\\sig\\ok.wav"
-- Seconds after sending at which a slot is loaded anyway.
local SCHEDULE_NO_SOUND = { 8, 20, 40, 75, 120, 240 } -- sound disabled: no signals
local SCHEDULE_SAFETY = { 90, 240 }                   -- signals on: only as a safety net
-- A plugin's request (Plugins.lua) takes minutes to answer: open fewer
-- mailboxes while waiting, as each can be opened once per session.
local SCHEDULE_SLOW_NO_SOUND = { 45, 90, 150, 240, 360, 540 }
local SCHEDULE_SLOW_SAFETY = { 300, 720 }
-- App status (see Live:CheckApp).
local STATUS_PATH = "Interface\\AddOns\\ForeverAICompanion\\sig\\%s.wav"
local APP_TICK = 2  -- the app switches its beat every 3 s: check faster than that
local STALE = 15    -- seconds without a switch: the app stopped (crashed or frozen)
local REASONS = { "need-ai", "need-login", "problem" }

local LoadAddOn = (C_AddOns and C_AddOns.LoadAddOn) or LoadAddOn
local IsAddOnLoaded = (C_AddOns and C_AddOns.IsAddOnLoaded) or IsAddOnLoaded
local EnableAddOn = (C_AddOns and C_AddOns.EnableAddOn) or EnableAddOn

local function playable(path)
  local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
  if ok and willPlay then
    if handle and StopSound then StopSound(handle) end
    return true
  end
  return false
end

local IsPlaying = C_Sound and C_Sound.IsPlaying
local DEFERRED_DELAY = 0.01 -- next frame: an empty file has stopped, a real one plays on

-- Plays every path and calls cb({ [path] = true / false }): whether it really
-- plays. Right away where the game refuses empty files; a moment later where
-- it doesn't (Live.deferred). Every sound is stopped.
function Live:Probe(paths, cb)
  local results, handles, waiting = {}, {}, false
  for _, path in ipairs(paths) do
    local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
    if not (ok and willPlay) then
      results[path] = false
    elseif self.deferred and handle then
      handles[path] = handle
      waiting = true
    else
      results[path] = true
      if handle and StopSound then StopSound(handle) end
    end
  end
  if not waiting then return cb(results) end
  C_Timer.After(DEFERRED_DELAY, function()
    for path, handle in pairs(handles) do
      local ok, playing = pcall(IsPlaying, handle)
      results[path] = (ok and playing) and true or false
      if StopSound then StopSound(handle) end
    end
    cb(results)
  end)
end

-- How this game tells an empty sound file from a real one. Without a way to
-- tell (a Mac game with no C_Sound.IsPlaying) the signals are not used:
-- mailboxes are opened on a timer instead.
function Live:Calibrate()
  local mac = IsMacClient and IsMacClient() or false
  self.deferred = mac and IsPlaying ~= nil
  self.noSignals = mac and IsPlaying == nil
end

local function slotName(i)
  return string.format("ForeverAICompanion_S%02d", i)
end

function Live:Init()
  local db = ns.db
  db.nextSig = db.nextSig or 1
  self.failed = {}
  self:Calibrate()
  self.soundOK = playable(OK_PATH) and not self.noSignals
  -- Skip signals that were rung while we were offline / before a /reload.
  if self.soundOK and not db.sigWait then
    if self.deferred then
      self:SkipRung()
    else
      while db.nextSig <= self.SIGNALS and playable(SIG_PATH:format(db.nextSig)) do
        db.nextSig = db.nextSig + 1
      end
    end
  end
  -- Pick up anything answered while we were away (a plugin's answer may have
  -- taken long enough to arrive after the game was closed).
  if ns.Core:HasPending() or (ns.Plugins and ns.Plugins:AwaitingLate()) then self:LoadNextSlot() end
  C_Timer.NewTicker(TICK, function() Live:Tick() end)
  -- Is the app open and ready? Checked while the window is open (it opening
  -- checks right away, see UI.lua), or while a plugin's window asks for it.
  C_Timer.NewTicker(APP_TICK, function()
    if ns.UI:IsShown() or (ns.Plugins and ns.Plugins:Watching()) then Live:CheckApp() end
  end)
end

-- The same skip, one signal per check (deferred checks take a frame each).
-- Signals are not used for slots until it is done.
function Live:SkipRung()
  local db = ns.db
  self.scanning = true
  local function step()
    if db.nextSig > self.SIGNALS then self.scanning = false return end
    local path = SIG_PATH:format(db.nextSig)
    self:Probe({ path }, function(r)
      if r[path] then
        db.nextSig = db.nextSig + 1
        step()
      else
        self.scanning = false
      end
    end)
  end
  step()
end

-- App status ------------------------------------------------------------------
-- The app keeps a few more sound files in sig/ (see companion/src/beacon.js),
-- created by the installer like the signals:
--   st.wav         always plays: these files existed when the game started.
--   beat1, beat2   while the app runs it switches every few seconds which one
--                  plays; both are silent once it is closed.
--   need-ai, need-login, problem
--                  at most one plays: why the app can't answer yet.

-- "checking" | "ready" | "closed" | "stuck" | "need-ai" | "need-login" |
-- "problem" | "restart" (files newer than the game) | "nosound" (can't
-- check) | "unknown" (this game doesn't notice files going silent).
function Live:AppState()
  return self.app and self.app.state or "checking"
end

local STATUS_FILES = { "ok", "st", "beat1", "beat2", "need-ai", "need-login", "problem" }

-- Checks the status files (at once, or a moment later on a Mac) and updates
-- the state. Returns the state known so far.
function Live:CheckApp()
  if self.checkingApp then return self:AppState() end
  local paths = {}
  for i, name in ipairs(STATUS_FILES) do paths[i] = name == "ok" and OK_PATH or STATUS_PATH:format(name) end
  self.checkingApp = true
  self:Probe(paths, function(r)
    self.checkingApp = false
    self:ApplyAppCheck(function(name) return r[name == "ok" and OK_PATH or STATUS_PATH:format(name)] == true end)
  end)
  return self:AppState()
end

-- plays(name): whether that status file plays.
function Live:ApplyAppCheck(plays)
  local app = self.app or {}
  self.app = app
  local before = app.state
  local now = GetTime()
  -- After a pause (window closed) the beat may have switched any number of
  -- times: start watching it again, keeping what we knew meanwhile.
  if app.lastCheck and now - app.lastCheck > APP_TICK * 2.5 then
    app.pattern, app.changedAt = nil, nil
  end
  app.lastCheck = now
  if self.noSignals then
    app.state = "unknown"
  elseif not plays("ok") then
    app.state = "nosound"
  elseif not plays("st") then
    app.state = "restart"
  else
    local pattern = (plays("beat1") and 1 or 0) + (plays("beat2") and 2 or 0)
    if pattern ~= app.pattern then
      if app.pattern and pattern ~= 0 and app.pattern ~= 0 then app.switched = true end
      app.pattern, app.changedAt = pattern, now
    end
    if pattern == 0 then
      -- One silent check can be the app switching files: wait for a second one.
      app.silent = (app.silent or 0) + 1
      if app.silent >= 2 then app.state, app.switched = "closed", nil end
    elseif pattern == 3 and now - app.changedAt >= 6 then
      app.silent = 0
      app.state = "unknown"
    else
      app.silent = 0
      if now - app.changedAt > STALE then
        app.state = "stuck"
      elseif not app.switched then
        app.state = app.state == "closed" and "closed" or "checking"
      else
        app.state = "ready"
        for _, reason in ipairs(REASONS) do
          if plays(reason) then app.state = reason break end
        end
      end
    end
  end
  if app.state ~= before then
    ns.UI:RefreshStatusBar()
    if ns.Plugins then ns.Plugins:AppStateChanged(app.state) end
  end
  return self:AppState()
end

-- Fields every request carries so the companion knows which signal to ring.
function Live:RequestFields()
  local db = ns.db
  if db.nextSig > self.SIGNALS then
    -- All signal files used: ask the companion to empty them and start over.
    db.nextSig = 1
    db.sigWait = true
    db.pendingReset = true
  end
  return db.nextSig, db.pendingReset or nil
end

-- slow: a plugin's request, answered in minutes rather than seconds.
function Live:OnSent(slow)
  self.sentAt = GetTime()
  self.scheduleIndex = 1
  self.slow = slow and true or nil
end

function Live:OnAnswer()
  ns.db.sigWait = nil
  ns.db.pendingReset = nil
end

function Live:Tick()
  local waiting = ns.Core:HasPending()
  -- A plugin's answer that is only late: the bell is still listened for, but
  -- no mailbox is opened on the timer for it.
  if not waiting and not (ns.Plugins and ns.Plugins:ListeningLate()) then return end
  local db = ns.db
  self.soundOK = playable(OK_PATH) and not self.noSignals
  local useSignals = self.soundOK and not db.sigWait and db.nextSig <= self.SIGNALS and not self.scanning

  if useSignals then
    local path = SIG_PATH:format(db.nextSig)
    if self.deferred then
      -- Checked a moment later; the timer below still runs as a safety net.
      if not self.checkingSig then
        self.checkingSig = true
        self:Probe({ path }, function(r)
          self.checkingSig = false
          if r[path] and SIG_PATH:format(db.nextSig) == path then
            db.nextSig = db.nextSig + 1
            self:LoadNextSlot()
          end
        end)
      end
    elseif playable(path) then
      db.nextSig = db.nextSig + 1
      self:LoadNextSlot()
      return
    end
  end

  if self.sentAt and waiting then
    local schedule
    if self.slow then schedule = useSignals and SCHEDULE_SLOW_SAFETY or SCHEDULE_SLOW_NO_SOUND
    else schedule = useSignals and SCHEDULE_SAFETY or SCHEDULE_NO_SOUND end
    local due = schedule[self.scheduleIndex]
    if not due then due = schedule[#schedule] + 240 * (self.scheduleIndex - #schedule) end
    if GetTime() - self.sentAt >= due then
      self.scheduleIndex = self.scheduleIndex + 1
      self:LoadNextSlot()
    end
  end
end

function Live:LoadNextSlot()
  for i = 1, self.SLOTS do
    local name = slotName(i)
    if not IsAddOnLoaded(name) and not self.failed[name] then
      _G.ForeverAICompanion_Inbox = nil
      local loaded, reason = LoadAddOn(name)
      if not loaded and reason == "DISABLED" and EnableAddOn then
        pcall(EnableAddOn, name)
        loaded, reason = LoadAddOn(name)
      end
      if loaded then
        self.usedSlots = i
        ns.Core:ApplyInbox(_G.ForeverAICompanion_Inbox)
        return true
      end
      self.failed[name] = reason or "?"
      if reason == "MISSING" then
        ns.UI:SetStatus("|cffff6060" .. ns.L.MAILBOX_MISSING .. "|r")
        return false
      end
    end
  end
  ns.UI:SetStatus("|cffff6060" .. ns.L.MAILBOX_OUT .. "|r")
  self:OfferReload()
  return false
end

-- Out of mailboxes: one click reloads the interface, which makes all of them
-- usable again (asked once per session; the chat keeps its messages).
function Live:OfferReload()
  if self.reloadOffered or not StaticPopup_Show or not StaticPopupDialogs then return end
  self.reloadOffered = true
  local L = ns.L
  StaticPopupDialogs.FOREVERAICOMPANION_RELOAD = StaticPopupDialogs.FOREVERAICOMPANION_RELOAD or {
    text = L.MAILBOX_OUT_POPUP,
    button1 = L.RELOAD,
    button2 = CANCEL or L.CANCEL,
    OnAccept = function() if ReloadUI then ReloadUI() end end,
    timeout = 0,
    whileDead = true,
    hideOnEscape = true,
    preferredIndex = 3,
  }
  StaticPopup_Show("FOREVERAICOMPANION_RELOAD")
end

function Live:Status()
  local L = ns.L
  local db = ns.db
  local s = string.format(L.STATUS_BASE,
    (C_AddOns and C_AddOns.GetAddOnMetadata or GetAddOnMetadata or function() return "?" end)("ForeverAICompanion", "Version") or "?",
    self.soundOK and L.YES or L.NO, db.nextSig or 0, self.SIGNALS, self.usedSlots or 0, self.SLOTS)
  local p = ns.Personas:Current()
  s = s .. string.format(L.STATUS_ASSISTANT, p.name, ns.Personas.PortraitName(p))
  local channel = ns.Core.lastChannel
  channel = channel == "voice" and L.CHANNEL_VOICE or channel == "strip" and L.CHANNEL_STRIP or "-"
  s = s .. string.format(L.STATUS_CHANNEL, channel,
    ns.Voice:Find() and L.INSTALLED or L.NOT_INSTALLED)
  local enc = ns.Core.lastEncode
  if enc then
    s = s .. (enc.failed and (L.STATUS_PREP_FAILED .. enc.failed)
      or string.format(L.STATUS_PREP,
        enc.level, enc.bytes, tostring(enc.collectMs), tostring(enc.encodeMs), tostring(enc.frames)))
  end
  if ns.Uplink.textures then
    s = s .. string.format(L.STATUS_CELLS, #ns.Uplink.textures)
  end
  local ok, w, h = pcall(GetPhysicalScreenSize)
  if ok and w then s = s .. string.format(L.STATUS_SCREEN, w, h) end
  local last = ns.Uplink.last
  if last then
    s = s .. string.format(L.STATUS_LAST,
      last.bytes, last.cols, last.rows, tostring(last.shownFrames))
  end
  return s
end
