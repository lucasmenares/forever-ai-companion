// Plugins: other addons that ask through Forever AI Companion (Plugins.lua
// in the addon). A request carries req.ext = { name, kind, input }; the
// plugin registered here under that name answers it with data for its addon.
//
// Only plugins listed here run. What a plugin tells the AI is written in this
// app (never taken from the request), so a request can only choose among the
// things a plugin knows how to do.
//
// A plugin: { name, handle(req, env) -> Promise<{ text, data, model, usage }> }
//   req:  the addon's request: req.ext.kind and req.ext.input say what is
//         asked; req.context holds the character's sections the plugin's
//         addon chose to send, and its own under "<name>_<section>".
//   env:  { cfg, log, lang, guides, knowledge }
//   text: one or two sentences for the app's list of questions (and the
//         addon's status line); data: a plain object for the plugin's addon;
//         usage: { input, cached, output } tokens, when an AI was asked.

// The plugins this app carries: functions that make one from the options
// createPlugins() was given.
const BUILT_IN = [];

export function createPlugins(options = {}) {
  const plugins = {};
  for (const create of BUILT_IN) {
    const plugin = create(options);
    plugins[plugin.name] = plugin;
  }
  return plugins;
}
