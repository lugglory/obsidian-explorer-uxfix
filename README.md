# Explorer UX Fix

[한국어](README.ko.md)

Long-press a file or folder in Obsidian's file explorer to rename it, and keep page previews from covering the explorer.

## Features

- **Long-press a file or folder to rename it** (0.8 s by default, adjustable in the settings). Its name turns into a text field with the whole name selected. File extensions are kept, so you only edit the name.
- **Enter or clicking elsewhere renames; Esc cancels.** While typing Korean, Japanese, or Chinese, the Enter that finishes a character doesn't rename.
- Renaming goes through Obsidian's own file manager, so links to the file are updated according to your "Automatically update internal links" setting.
- A name with a character that can't be used (`\ / : * ? " < > |`) or a name that's already taken is not applied, and a notice says why.
- An edit icon next to the mouse fills from left to right while you hold.
- Moving more than 4 px while pressing starts a normal drag (to move the item) instead. Scrolling or switching windows also cancels the press.
- After a long-press, letting go doesn't open the file or fold the folder.
- Clicks with Ctrl, Shift, Alt, or Cmd held, other mouse buttons, and the vault's top folder are left alone.
- **Page previews opened from the file explorer appear beside it** instead of on top of it (8 px away by default, adjustable in the settings). If the explorer is in the right sidebar, they appear to its left. Only the horizontal position changes; previews of links in notes are left alone. Needs the core plugin "Page preview".
- The settings are in English, or Korean when Obsidian is set to Korean.
- Desktop only. Requires Obsidian 1.13 or later.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` from the latest release into `<vault>/.obsidian/plugins/explorer-uxfix/`, then enable the plugin in Settings → Community plugins.

## Build

```
npm install
npm run build
```
