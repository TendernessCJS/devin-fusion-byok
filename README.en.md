# Devin Fusion BYOK

[中文](README.md) | English

A Devin user extension that brings your own model APIs (BYOK) into Devin's native model list, and lets you combine them in Devin's official Fusion card (Lead + Sidekick).

> This repository is a fork of [kuobibulaien/devin-fusion-byok](https://github.com/kuobibulaien/devin-fusion-byok). Downloads and self-updates point to this repository's Releases.

- Does not modify the Devin app, needs no re-signing, and installs no certificates or system proxy.
- Supports three API formats: OpenAI Responses, OpenAI Chat Completions and Anthropic Messages.
- Third-party models can be used on their own; once enabled for a Fusion role, they can also be combined with other third-party or official models and picked directly in the Fusion card of Devin's model picker.

This page covers installing, getting started and uninstalling. The full documentation is in Chinese in [README.md](README.md).

## Install

1. Download `devin-fusion-byok-<version>.vsix` from [Releases](https://github.com/TendernessCJS/devin-fusion-byok/releases/latest).
2. In the Devin Command Palette, run **Extensions: Install from VSIX…** and choose the file, or run this in a terminal:

   ```bash
   /Applications/Devin.app/Contents/Resources/app/bin/devin-desktop --install-extension devin-fusion-byok-<version>.vsix
   ```

3. Reload the window (**Developer: Reload Window**) or open a new Devin window.

After that, you can check for and install new versions from **Settings → Extension updates** in the panel (currently macOS only).

## Quick start

Click **Fusion BYOK** in the status bar (bottom right), or run **Fusion BYOK: Open Control Panel** from the Command Palette.

1. **Models** tab: add a provider with a name, base URL and API key, and choose the API type.
   If you enter only a host, `/v1` is appended automatically; a path you enter is used as is (for example `https://your-gateway.example/openai`). The dialog shows the actual request URL.
2. Click **Import models**, select the models you want and click **Import**.
3. **Fusion** tab: choose which models can be a Lead and which can be a Sidekick. Imported models are enabled by default, and the official default Sidekicks are already available, so you don't need to add them.
4. In Devin's model picker, open the **Fusion** card and pick a combination with the Lead / Effort / Sidekick dropdowns.

Devin owns that view; the extension only makes sure every candidate is there. If the list did not update, click **Reload window** at the top right of the panel (other windows are not affected); if that doesn't help, click **Restart Devin** (it closes every window and reopens Devin automatically; diagnostics go to `restart.log` in the extension's global storage directory).

### Language

The extension follows the editor's display language: Chinese display languages get the Chinese UI, everything else gets English. To override it, use **Settings → 语言 / Language** in the panel (Auto, 中文 or English). The change applies right away, without a reload. Command names in the Command Palette always follow the editor's display language.

## Disable and uninstall

First run **Fusion BYOK: Disable and Restore Connection** from the Command Palette, then uninstall the extension. This withdraws the injected models and restores the Devin settings the extension wrote (anything you changed yourself afterwards is left alone). Conversations already in progress keep their original settings, so start a new conversation after disabling.
