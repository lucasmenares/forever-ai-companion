// English (default) and Spanish messages for everything the player reads:
// the app window's errors, the tray icon and errors shown in the game.
//
// Language: the player's system language (or FAIC_LANG / config "language").
// Requests from the game carry the game's language (req.lang), and everything
// said while answering one uses it: see runInLang().
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';

export const LANGS = ['en', 'es'];

export function normalizeLang(value) {
  const v = String(value || '').toLowerCase();
  if (v.startsWith('es')) return 'es';
  if (v.startsWith('en')) return 'en';
  return null;
}

// macOS: apps opened from Finder get no LANG, so Node would always say
// "en-US". The player's language list (System Settings › General ›
// Language & Region) is read instead: "es-CL" from ( "es-CL", "en-US" ).
export function macPreferredLanguage() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /^\s*"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?,?\s*$/m.exec(out.replace(/^\(\s*/, ''))?.[1] || null;
  } catch {
    return null;
  }
}

// The system's user locale as Node sees it (es-CL, en-US...).
export function systemLang() {
  // AZIA_LANG: the variable's name before the rename (see config.envVar).
  const candidates = [process.env.FAIC_LANG, process.env.AZIA_LANG, macPreferredLanguage()];
  try { candidates.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch { /* no ICU */ }
  candidates.push(process.env.LANG, process.env.LC_ALL);
  for (const c of candidates) {
    const l = normalizeLang(c);
    if (l) return l;
  }
  return 'en';
}

let appLang = systemLang();
export const setAppLang = (lang) => { appLang = normalizeLang(lang) || systemLang(); return appLang; };
export const getAppLang = () => appLang;

const als = new AsyncLocalStorage();
// Runs fn with messages in `lang` (falls back to the app's language).
export const runInLang = (lang, fn) => als.run(normalizeLang(lang) || appLang, fn);
export const currentLang = () => als.getStore() || appLang;

const APP = 'Forever AI Companion';

const MESSAGES = {
  en: {
    needGameFolder: 'Choose the game folder first.',
    needAddon: 'Install the addon first.',
    unknownOption: 'Unknown option.',
    unknownAI: 'Unknown AI option.',
    notForeverFolder: 'WoW Forever is not in that folder. Choose the "World of Warcraft" folder or the "_forever_" folder inside it.',
    pasteKey: 'Paste your API key for this option.',
    installClaudeFirst: 'Install Claude Code first.',
    installCodexFirst: 'Install Codex first.',
    installedOnly: 'Only available in the installed version.',
    typePath: 'Type the path in the settings.',
    requestTooLarge: 'Request too large.',
    adminCancelled: 'The administrator permission was cancelled.',
    voiceRegisterFailed: 'Could not register the voice (code {code}).',
    noCsc: 'The Windows C# compiler (.NET Framework 4) was not found.',
    installFailed: 'Could not install to {target}: {error}',

    claudeBadKey: 'The Claude key is not valid. Check that you copied all of it (it starts with sk-ant-).',
    claudeNoPermission: 'Your Claude account is not allowed to use this model.',
    apiRateLimit: 'The API usage limit was reached. Wait a moment or check your credit.',
    apiNoCredit: 'Your API account has no credit left. Add credit on its Billing page.',
    modelGone: 'The model {model} is no longer available. Choose another model in the app, or update the app.',
    apiBusy: 'The AI is overloaded right now. Try again in a moment.',
    apiRejected: 'The API rejected the request: {error}',
    anthropicError: 'Anthropic API error ({status}): {error}',
    refused: 'The AI declined to answer that question.',
    badKey: 'The API key is not valid. Check that you copied all of it.',
    noText: 'The API returned no text.',
    tooSlow: '{bin} took too long to answer.',
    cannotRun: 'Could not run "{bin}": {error}. Is it installed?',
    exitCode: '{bin} exited with code {code}: {output}',
    claudeMissing: `Claude Code is not installed. Click "Install Claude Code" in the ${APP} window.`,
    claudeUnexpected: 'Unexpected answer from Claude Code: {output}',
    claudeSignedOut: `Claude Code is not signed in. Click "Sign in" in the ${APP} window.`,
    claudeError: 'Claude Code: {error}',
    claudeStatusFailed: 'Could not check Claude Code.',
    yourSubscription: 'your subscription',
    yourClaudeSubscription: 'your Claude subscription',
    codexMissing: `Codex is not installed. Click "Install Codex" in the ${APP} window.`,
    codexSignedOut: `Codex is not signed in. Click "Sign in" in the ${APP} window.`,
    codexLimit: `You reached your ChatGPT plan's usage limit. Wait a while or choose another AI in the ${APP} window.`,
    codexModel: `Your ChatGPT plan does not include that model. Choose "Your plan's default" in the ${APP} window.`,
    codexNoAnswer: 'Codex returned no answer.',
    codexError: 'Codex: {error}',
    probeRecording: 'Recording. The channel test runs now and takes about 25 seconds.',
    codexUnsafe: 'This Codex version no longer accepts a safety setting the app relies on ({feature}), so it was not used. Update Forever AI Companion, or choose another AI.',
    codexStatusFailed: 'Could not check Codex.',
    pickCodex: 'Find codex.exe (the Codex program)',
    codexPickInvalid: 'That file is not Codex. Choose codex.exe (or codex.cmd if you installed it with npm).',
    emptyAnswer: '(empty answer)',
    // Plugins: other addons asking through this one (plugins.js).
    unknownPlugin: 'This version of the companion app has no "{name}" plugin. Update the app.',
    pluginResend: 'Some of the data had to be sent again: ask once more.',
    unreadable: 'The request could not be read: something was covering the top-left corner of the screen.',
    unreadableScreen: 'I could not read the question on the screen: something was covering the top edge of the game window.',
    unreadableQuestion: '(unreadable question)',
    pickFolder: 'Choose the World of Warcraft folder (or the _forever_ folder inside it)',

    echoIntro: 'Connection test OK. This is not an AI: the app received your question and this data.',
    echoQuestion: '- Question: {q}',
    echoCharacter: '- Character: {name}, {race} {cls} level {level}',
    echoPosition: '- Position: {where}',
    echoCounts: '- Equipped items: {gear} · Quests: {quests}',
    echoPick: `For real answers, choose an AI in the ${APP} window.`,

    testQuestion: 'Which dungeon do you recommend for me right now? Answer in two sentences.',

    // Console windows (no accents: the console code page may not show them).
    consoleDone: `Done. You can close this window and go back to ${APP}.`,
    consoleSignInClaude: 'Sign in to Claude',
    consoleSignInChatGPT: 'Sign in to ChatGPT',
    consoleInstallClaude: 'Install Claude Code',
    consoleInstallCodex: 'Install Codex',

    updateUnsupported: 'Updates are only available in the installed app.',
    updateNoticeTitle: 'Forever AI Companion {version} is available',
    updateNoticeText: 'Click here to update it in one click.',
    voiceUpdateNoticeTitle: 'Update invisible sending',
    voiceUpdateNoticeText: 'It keeps working, but this version moves it to a protected folder. Click here and press "Update invisible sending".',
    startFailed: 'Forever AI Companion could not start:',

    trayRunning: `${APP}: running`,
    trayOpen: `Open ${APP}`,
    trayClose: `Close ${APP}`,
    trayStillRunning: `${APP} is still running`,
    trayClickHint: 'Click this icon to open it, or right-click to close it.',
    trayAskTitle: 'Keep it running?',
    trayAskText: 'If it keeps running in the background, you can keep asking from the game. You will find it next to the Windows clock: click its icon to open it again.\n\nIf you close it, the game will not get answers until you open it again.',
    trayRemember: 'Remember my choice',
    trayKeep: 'Keep running in the background',
    trayQuit: 'Close the app',
  },
  es: {
    needGameFolder: 'Primero elige la carpeta del juego.',
    needAddon: 'Falta instalar el addon.',
    unknownOption: 'Opción desconocida.',
    unknownAI: 'Opción de IA desconocida.',
    notForeverFolder: 'En esa carpeta no está WoW Forever. Elige la carpeta "World of Warcraft" o la carpeta "_forever_" que está dentro.',
    pasteKey: 'Pega tu clave de API para esta opción.',
    installClaudeFirst: 'Primero instala Claude Code.',
    installCodexFirst: 'Primero instala Codex.',
    installedOnly: 'Solo disponible en la versión instalada.',
    typePath: 'Escribe la ruta en la configuración.',
    requestTooLarge: 'Petición demasiado grande.',
    adminCancelled: 'Se canceló el permiso de administrador.',
    voiceRegisterFailed: 'No se pudo registrar la voz (código {code}).',
    noCsc: 'No se encontró el compilador de C# de Windows (.NET Framework 4).',
    installFailed: 'No se pudo instalar en {target}: {error}',

    claudeBadKey: 'La clave de Claude no es válida. Revisa que la copiaste completa (empieza con sk-ant-).',
    claudeNoPermission: 'Tu cuenta de Claude no tiene permiso para usar este modelo.',
    apiRateLimit: 'Se alcanzó el límite de uso de la API. Espera un momento o revisa tu crédito.',
    apiNoCredit: 'Tu cuenta de la API se quedó sin crédito. Carga más en su página de Billing.',
    modelGone: 'El modelo {model} ya no está disponible. Elige otro modelo en la app, o actualiza la app.',
    apiBusy: 'La IA está sobrecargada en este momento. Prueba de nuevo en un rato.',
    apiRejected: 'Petición rechazada por la API: {error}',
    anthropicError: 'Error de la API de Anthropic ({status}): {error}',
    refused: 'La IA no quiso responder a esa pregunta.',
    badKey: 'La clave de API no es válida. Revisa que la copiaste completa.',
    noText: 'La API no devolvió texto.',
    tooSlow: '{bin} tardó demasiado en responder.',
    cannotRun: 'No se pudo ejecutar "{bin}": {error}. ¿Está instalado?',
    exitCode: '{bin} terminó con código {code}: {output}',
    claudeMissing: `Claude Code no está instalado. Pulsa "Instalar Claude Code" en la ventana de ${APP}.`,
    claudeUnexpected: 'Respuesta inesperada de Claude Code: {output}',
    claudeSignedOut: `Claude Code no tiene la sesión iniciada. Pulsa "Iniciar sesión" en la ventana de ${APP}.`,
    claudeError: 'Claude Code: {error}',
    claudeStatusFailed: 'No se pudo consultar Claude Code.',
    yourSubscription: 'tu suscripción',
    yourClaudeSubscription: 'tu suscripción de Claude',
    codexMissing: `Codex no está instalado. Pulsa "Instalar Codex" en la ventana de ${APP}.`,
    codexSignedOut: `Codex no tiene la sesión iniciada. Pulsa "Iniciar sesión" en la ventana de ${APP}.`,
    codexLimit: `Llegaste al límite de uso de tu plan de ChatGPT. Espera un rato o elige otra IA en la ventana de ${APP}.`,
    codexModel: `Tu plan de ChatGPT no incluye ese modelo. Elige "El de tu plan" en la ventana de ${APP}.`,
    codexNoAnswer: 'Codex no devolvió ninguna respuesta.',
    codexError: 'Codex: {error}',
    probeRecording: 'Registrando. La prueba de canales empieza ahora y tarda unos 25 segundos.',
    codexUnsafe: 'Esta versión de Codex ya no acepta un ajuste de seguridad del que depende la app ({feature}), así que no se usó. Actualiza Forever AI Companion o elige otra IA.',
    codexStatusFailed: 'No se pudo consultar Codex.',
    pickCodex: 'Busca codex.exe (el programa Codex)',
    codexPickInvalid: 'Ese archivo no es Codex. Elige codex.exe (o codex.cmd si lo instalaste con npm).',
    emptyAnswer: '(respuesta vacía)',
    unknownPlugin: 'Esta versión de la app compañera no tiene el plugin "{name}". Actualiza la app.',
    pluginResend: 'Hubo que volver a enviar parte de los datos: pídelo otra vez.',
    unreadable: 'La captura con la pregunta no se pudo leer: algo tapaba la esquina superior izquierda de la pantalla.',
    unreadableScreen: 'No pude leer la pregunta en la pantalla: algo tapaba el borde superior de la ventana del juego.',
    unreadableQuestion: '(pregunta ilegible)',
    pickFolder: 'Elige la carpeta de World of Warcraft (o la carpeta _forever_ dentro de ella)',

    echoIntro: 'Prueba de conexión OK. Esto no es una IA: la app recibió tu pregunta y estos datos.',
    echoQuestion: '- Pregunta: {q}',
    echoCharacter: '- Personaje: {name}, {race} {cls} nivel {level}',
    echoPosition: '- Posición: {where}',
    echoCounts: '- Objetos equipados: {gear} · Misiones: {quests}',
    echoPick: `Para respuestas de verdad, elige una IA en la ventana de ${APP}.`,

    testQuestion: '¿Qué mazmorra me recomiendas ahora? Responde en dos frases.',

    consoleDone: `Listo. Ya puedes cerrar esta ventana y volver a ${APP}.`,
    consoleSignInClaude: 'Iniciar sesion en Claude',
    consoleSignInChatGPT: 'Iniciar sesion en ChatGPT',
    consoleInstallClaude: 'Instalar Claude Code',
    consoleInstallCodex: 'Instalar Codex',

    updateUnsupported: 'Las actualizaciones solo están disponibles en la app instalada.',
    updateNoticeTitle: 'Hay una versión nueva: Forever AI Companion {version}',
    updateNoticeText: 'Haz clic aquí para actualizarla con un clic.',
    voiceUpdateNoticeTitle: 'Actualiza el envío invisible',
    voiceUpdateNoticeText: 'Sigue funcionando, pero esta versión lo mueve a una carpeta protegida. Haz clic aquí y pulsa «Actualizar envío invisible».',
    startFailed: 'Forever AI Companion no pudo iniciarse:',

    trayRunning: `${APP}: funcionando`,
    trayOpen: `Abrir ${APP}`,
    trayClose: `Cerrar ${APP}`,
    trayStillRunning: `${APP} sigue funcionando`,
    trayClickHint: 'Haz clic en este ícono para abrirla, o clic derecho para cerrarla.',
    trayAskTitle: '¿Quieres que siga funcionando?',
    trayAskText: 'Si sigue en segundo plano, podrás seguir preguntando desde el juego. La encontrarás junto al reloj de Windows: haz clic en su ícono para volver a abrirla.\n\nSi la cierras, el juego no recibirá respuestas hasta que la abras de nuevo.',
    trayRemember: 'Recordar mi elección',
    trayKeep: 'Seguir en segundo plano',
    trayQuit: 'Cerrar la app',
  },
};

// macOS wording where Windows' doesn't fit (menu bar instead of the clock,
// Terminal instead of a console window...).
const MAC = {
  en: {
    pickCodexMac: 'Find codex (the Codex program)',
    codexPickInvalidMac: 'That file is not Codex. Choose the codex program (for example in /opt/homebrew/bin or ~/.local/bin).',
    trayClickHint: 'Click its icon in the menu bar to open it again.',
    trayAskText: 'If it keeps running in the background, you can keep asking from the game. You will find it in the menu bar, at the top of the screen: click its icon to open it again.\n\nIf you close it, the game will not get answers until you open it again.',
    trayClose: `Quit ${APP}`,
    voiceUpdateNoticeText: 'Click here and press "Update invisible sending".',
  },
  es: {
    pickCodexMac: 'Busca codex (el programa Codex)',
    codexPickInvalidMac: 'Ese archivo no es Codex. Elige el programa codex (por ejemplo en /opt/homebrew/bin o ~/.local/bin).',
    trayClickHint: 'Haz clic en su ícono de la barra de menús para volver a abrirla.',
    trayAskText: 'Si sigue en segundo plano, podrás seguir preguntando desde el juego. La encontrarás en la barra de menús, arriba en la pantalla: haz clic en su ícono para volver a abrirla.\n\nSi la cierras, el juego no recibirá respuestas hasta que la abras de nuevo.',
    trayClose: `Salir de ${APP}`,
    voiceUpdateNoticeText: 'Haz clic aquí y pulsa «Actualizar envío invisible».',
  },
};
const isMac = process.platform === 'darwin';

// t('tooSlow', { bin: 'claude' }) in the current language (English fallback).
export function t(key, vars = {}, lang = currentLang()) {
  const text = (isMac ? MAC[lang]?.[key] ?? MAC.en[key] : undefined) ?? MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

// Error with a translated message.
export const err = (key, vars) => new Error(t(key, vars));

export const messagesFor = (lang) => ({ ...MESSAGES.en, ...(MESSAGES[lang] || {}) });
