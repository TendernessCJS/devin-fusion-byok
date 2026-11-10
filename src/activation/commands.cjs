'use strict';

function installCommands({ vscode, context, config, catalog, output, log, run, runtime, selection, panel }) {
  const refresh = async () => {
    panel.open();
    vscode.window.showInformationMessage('请选择供应商，点击「导入模型」，勾选要导入的模型后确认。');
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.refreshModels', run(refresh)));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.openPanel', run(async () => panel.open())));
  require('../fast-context/config-ui.cjs').registerFastContext({ vscode, context });
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.selectFusion', run(async () => {
    const choices = catalog().models.filter(model => model.kind === 'matrix').map(model => ({ label: model.label || model.uid, uid: model.uid }));
    if (!choices.length) { panel.open(); vscode.window.showInformationMessage('Fusion 组合在 Devin 的模型选择器里选（打开 Fusion 卡片）；控制面板的「Fusion」页用来决定哪些模型能出现在那张卡片的下拉里。'); return; }
    const choice = await vscode.window.showQuickPick(choices, { title: '选择 Fusion 组合', matchOnDescription: true }); if (!choice) return;
    await selection.saveFusionChoice(choice.uid);
    vscode.window.showInformationMessage('已保存插件组合设置；请在 Devin 模型选择器确认选择（当前会话可能保留此前选择）。');
  })));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.status', () => { log('status', { runtime: runtime.status(), models: config().providers.map(p => ({ name: p.name, models: p.models.length })) }); output.show(true); }));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.disable', run(runtime.disable)));
}

module.exports = { installCommands };
