'use strict';
const { translator } = require('../i18n/index.cjs');

function installCommands({ vscode, context, config, catalog, output, log, run, runtime, selection, panel, t = translator() }) {
  const refresh = async () => {
    panel.open();
    vscode.window.showInformationMessage(t('commands.importHint'));
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.refreshModels', run(refresh)));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.openPanel', run(async () => panel.open())));
  require('../fast-context/config-ui.cjs').registerFastContext({ vscode, context, t });
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.selectFusion', run(async () => {
    const choices = catalog().models.filter(model => model.kind === 'matrix').map(model => ({ label: model.label || model.uid, uid: model.uid }));
    if (!choices.length) { panel.open(); vscode.window.showInformationMessage(t('commands.fusionInPicker')); return; }
    const choice = await vscode.window.showQuickPick(choices, { title: t('commands.selectFusion'), matchOnDescription: true }); if (!choice) return;
    await selection.saveFusionChoice(choice.uid);
    vscode.window.showInformationMessage(t('commands.fusionSaved'));
  })));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.status', () => { log('status', { runtime: runtime.status(), models: config().providers.map(p => ({ name: p.name, models: p.models.length })) }); output.show(true); }));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.disable', run(runtime.disable)));
}

module.exports = { installCommands };
