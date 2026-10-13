'use strict';
// Shared design layer for every Fusion BYOK webview. A view embeds these
// base styles first and its own rules after, so view rules always win.
const BASE = `
    :root { --radius-control: 4px; --radius-container: 6px; --radius-overlay: 8px; --radius-pill: 9px; --control-h: 28px; --page-x: 24px; --page-top: 24px; --page-bottom: 72px; --mono: var(--vscode-editor-font-family, monospace); --border: var(--vscode-panel-border, #454545); --muted: var(--vscode-descriptionForeground, #999); --accent: var(--vscode-button-background, #0e639c); --hover: var(--vscode-list-hoverBackground, #2a2d2e); --warn: var(--vscode-editorWarning-foreground, #cca700); --error: var(--vscode-errorForeground, #f48771); --ok: var(--vscode-testing-iconPassed, #73c991); --bg: var(--vscode-editor-background, #1e1e1e); }
    * { box-sizing: border-box; }
    body { margin: 0 auto; max-width: calc(960px + 2 * var(--page-x)); padding: var(--page-top) var(--page-x) var(--page-bottom); color: var(--vscode-foreground, #ddd); background: var(--bg); font: 13px/1.5 var(--vscode-font-family, system-ui, sans-serif); }
    h1, h2, h3, p, ul, ol, figure, blockquote { margin: 0; }
    ul, ol { padding-left: 20px; }
    h1 { font-size: 16px; font-weight: 600; }
    h2 { font-size: 14px; font-weight: 600; }
    h3 { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    a { color: var(--vscode-textLink-foreground, #80bfff); }
    button, input, select, textarea { font: inherit; border: 1px solid var(--vscode-input-border, transparent); border-radius: var(--radius-control); }
    button { min-height: var(--control-h); padding: 3px 12px; color: var(--vscode-button-foreground, #fff); background: var(--accent); cursor: pointer; white-space: nowrap; }
    button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    button.secondary { color: var(--vscode-button-secondaryForeground, #ddd); background: var(--vscode-button-secondaryBackground, #3a3d41); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    button.quiet { color: var(--vscode-textLink-foreground, #80bfff); background: transparent; border-color: transparent; padding: 2px 6px; }
    button.quiet:hover { background: var(--hover); }
    button.danger { color: var(--error); background: transparent; border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
    button:disabled, input:disabled, select:disabled, textarea:disabled { opacity: .5; cursor: default; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible, a:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
    input:not([type="checkbox"]), select { min-height: var(--control-h); padding: 3px 8px; color: var(--vscode-input-foreground, #ddd); background: var(--vscode-input-background, #3c3c3c); width: 100%; }
    textarea { min-height: 70px; padding: 6px 8px; color: var(--vscode-input-foreground, #ddd); background: var(--vscode-input-background, #3c3c3c); width: 100%; }
    input::placeholder, textarea::placeholder { color: var(--vscode-input-placeholderForeground, #999); }
    input[readonly] { opacity: .7; }
    input[type="checkbox"] { margin: 0; width: 14px; height: 14px; flex: none; accent-color: var(--accent); }
    input.switch[type="checkbox"] { appearance: none; -webkit-appearance: none; width: 32px; height: 18px; border-radius: var(--radius-pill); position: relative; cursor: pointer; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--border); }
    input.switch[type="checkbox"]::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--vscode-foreground, #ddd); transition: left .12s ease; }
    input.switch[type="checkbox"]:checked { background: var(--accent); border-color: var(--accent); }
    input.switch[type="checkbox"]:checked::after { left: 16px; background: var(--vscode-button-foreground, #fff); }
    [hidden] { display: none !important; }
    .muted, .hint { color: var(--muted); }
    .hint { font-size: 12px; }
    .warn { display: block; color: var(--warn); font-size: 12px; }
    .error { color: var(--error); }
    .mono { font-family: var(--mono); font-size: 11px; }
    .spacer { flex: 1; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
    .tile { padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-container); min-width: 0; }
    .tile-value { display: block; font-size: 18px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .tile-label { display: block; font-size: 11px; color: var(--muted); }
    .mt { margin-top: 12px; }
    .mb { margin-bottom: 12px; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .actions.nowrap { flex-wrap: nowrap; }
    .code-block { margin: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-container); background: var(--vscode-textCodeBlock-background, var(--vscode-input-background, #3c3c3c)); font-family: var(--mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 0; }
`;
function baseStyles() { return BASE; }
module.exports = { baseStyles };
