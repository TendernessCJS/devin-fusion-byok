'use strict';
const { translator } = require('../i18n/index.cjs');
const NAME = 'fusion-fast-context';
// POSIX single-quote escaping; Windows users are told to adapt quoting in the prompt itself.
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function checkServer({ command, args }) {
  if (typeof command !== 'string' || !Array.isArray(args) || args.length !== 3 || args[1] !== '--root') throw new Error('invalid_config');
}
// Client-specific snippets embedded in the prompt; generated from this machine's install paths.
function snippets({ command, args }) {
  checkServer({ command, args });
  const json = value => JSON.stringify(value);
  return {
    json: JSON.stringify({ mcpServers: { [NAME]: { command, args } } }, null, 2),
    claude: `claude mcp add ${NAME} --scope user -- ${[command, ...args].map(shellQuote).join(' ')}`,
    codex: `[mcp_servers.${NAME}]\ncommand = ${json(command)}\nargs = ${json(args)}\ntool_timeout_sec = 150`,
  };
}
// The prompt is a document the user previews in the panel and pastes to
// another agent, so its text lives in the string table (fc.setupPrompt) with
// the machine-specific pieces filled in as placeholders.
function setupPrompt({ command, args, platform = process.platform, t = translator() }) {
  checkServer({ command, args });
  const [serverPath, , root] = args;
  const json = value => JSON.stringify(value);
  const { json: generic, claude, codex } = snippets({ command, args });
  const windows = platform === 'win32';
  return t('fc.setupPrompt', {
    name: NAME, command, commandJson: json(command), argsJson: json(args), serverPathJson: json(serverPath), rootJson: json(root),
    generic, claude, codex: codex.replace(/^/gm, '     '),
    opencode: JSON.stringify({ [NAME]: { type: 'local', command: [command, ...args], enabled: true } }),
    claudeRun: t(windows ? 'fc.setupPrompt.claudeRunWindows' : 'fc.setupPrompt.claudeRun'),
  });
}
module.exports = { setupPrompt, snippets, NAME };
