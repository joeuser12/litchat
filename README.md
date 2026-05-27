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

## Installation

Download the latest release for your platform from the [Releases](../../releases) page.

- **Linux** — download the `.AppImage`, make it executable, and run it
- **Windows** — run the `.exe` installer
- **macOS** — open the `.dmg` and drag to Applications

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
