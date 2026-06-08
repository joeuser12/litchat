# Lit Chat

A desktop wrapper for [chat.literotica.com](https://chat.literotica.com) — a candy wrapper, if you will.

Built with [Electron](https://www.electronjs.org/) around the site's existing CandyChat/BOSH-XMPP interface.

## Features

- Persistent login session: no need to log in on every launch
- BOSH keepalive runs unthrottled which means you shouldn't get booted
- Desktop notifications for incoming DMs
- Presence notifications for watched users
- Multiple built-in themes: Dark, Dark Warm, Dark Teal, Nord, Dracula, Gruvbox, Catppuccin Mocha, Tokyo Night, Rosé Pine, Solarized Dark, Solarized Light, and Light
- Chat log viewer — opens to recent DMs; search conversation history by username
- Per-user notes
- Room manager — browse, favourite, and auto-join rooms on startup
- User profile pages open in an in-app window
- Per-room status message toggle — hide join/leave noise in busy rooms without affecting quieter ones
- Multiple profiles — separate cookie sessions and per-profile theme selection
- **Inline photo sharing in DMs** — upload or link images directly from the chat input; photos are shared via [picpub.art](https://picpub.art) ephemeral albums and appear as inline thumbnails for both users. Recipients without the app see a working browser link. Drag-and-drop or use the 📷 button
- Photo album manager — track active albums, set expiry (1h–7d), enable IP watermarking, or delete albums from the **Photo Albums** menu
- Right-click any sent photo thumbnail to remove that image from the album

## Before you start

**Close the Literotica chat tab in your browser before launching the app.**

Literotica's chat server keeps your session alive for up to a minute after you close a browser tab. If the server still thinks you are connected, the app will be unable to establish its own connection. If the app appears to hang on startup, close any Literotica tabs in your browser, wait about a minute, then try again. The app will show a warning banner if it detects this situation.

## Installation

- **Linux** — [download LitChat-linux.AppImage](../../releases/latest/download/LitChat-linux.AppImage), make it executable, and run it
- **Windows** — [download LitChat-windows.exe](../../releases/latest/download/LitChat-windows.exe) and run the installer
- **macOS** — [download LitChat-mac.dmg](../../releases/latest/download/LitChat-mac.dmg), open it and drag to Applications

All releases: [Releases page](../../releases)

## Profiles

Profiles give each account its own independent cookie session, theme, and settings.

Manage profiles from the **Profile** menu. Switching profiles restarts the app. To run two profiles simultaneously, launch a second instance with `--profile <id>`:

```
# Packaged app
LitChat --profile bob

# Development
npm start -- --profile bob
```

Profile IDs are the slugified version of the name you gave when creating the profile (e.g. "My Alt" → `my-alt`). They are shown in the window title when more than one profile exists.

## User data

Logs, settings, and customisations are stored under a per-profile subdirectory:

| Platform | Location |
|----------|----------|
| Linux    | `~/.config/Lit Chat/profiles/<id>/` |
| Windows  | `%APPDATA%\Lit Chat\profiles\<id>\` |
| macOS    | `~/Library/Application Support/Lit Chat/profiles/<id>/` |

The first profile is always named `default`.

## Customisation

Select a theme from the **Theme** menu. Your choice is saved per profile.

To add your own CSS overrides on top of the active theme, edit `user.css` in your profile's data folder. Changes take effect on Ctrl+R without restarting.

You can also place a `user.js` file in the same folder — it will be injected into the page on every load.

## Building from source

```
npm install
npm start              # run in development
npm run build:linux
npm run build:win
npm run build:mac
```
