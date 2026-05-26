# Lit Chat

A desktop wrapper for [chat.literotica.com](https://chat.literotica.com) — a candy wrapper, if you will.

Built with [Electron](https://www.electronjs.org/) around the site's existing CandyChat/BOSH-XMPP interface.

## Features

- Persistent login session (no need to log in on every launch)
- BOSH keepalive runs unthrottled even when the window is minimised
- Desktop notifications for incoming DMs
- Presence notifications for watched users
- Dark mode with larger, more readable text
- Chat log viewer — opens to recent DMs; search conversation history by username
- Per-user notes
- Room manager — browse, favourite, and auto-join rooms on startup
- Rooms and Logs shortcuts in the header bar
- User profile pages open in an in-app window instead of the system browser
- Per-room status message toggle — hide join/leave noise in busy rooms without affecting quieter ones
- Ads and site navigation stripped from the chat layout

## Installation

Download the latest release for your platform from the [Releases](../../releases) page.

- **Linux** — download the `.AppImage`, make it executable, and run it
- **Windows** — run the `.exe` installer
- **macOS** — open the `.dmg` and drag to Applications

## User data

Logs, settings, and your `user.css` customisations are stored in:

| Platform | Location |
|----------|----------|
| Linux    | `~/.config/Lit Chat/` |
| Windows  | `%APPDATA%\Lit Chat\` |
| macOS    | `~/Library/Application Support/Lit Chat/` |

## Customisation

The built-in dark theme is applied automatically and stays up to date with each release.

To add your own overrides, edit `user.css` in your user data folder. It is applied on top of the built-in theme on every page load — use Ctrl+R to preview changes without restarting.

You can also place a `user.js` file in the same folder — it will be injected into the page on every load.

## Building from source

```
npm install
npm start          # run in development
npm run build:linux
npm run build:win
npm run build:mac
```
