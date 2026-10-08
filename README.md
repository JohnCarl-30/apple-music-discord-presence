# apple-music-discord-presence

Mirrors Apple Music's now-playing track into your Discord Rich Presence on
macOS — title, artist, album art, and a progress bar that moves.

Discord ships this for Spotify but not for Apple Music. This is a small
background daemon that fills the gap.

## Requirements

- macOS with Music.app
- Node.js 20 or newer
- The Discord desktop client running (presence travels over its local IPC
  socket; the browser client cannot receive it)

## Setup

1. Create an application at
   <https://discord.com/developers/applications>. Its **name** is what
   Discord shows after "Listening to", so name it `Apple Music`.
2. Copy the **Application ID**.
3. Install and build:

   ```bash
   npm install
   npm run build
   ```

4. Check it works:

   ```bash
   DISCORD_CLIENT_ID=<your-app-id> node dist/cli.js --once
   ```

   The first run triggers a macOS prompt to let your terminal control
   Music.app. Approve it. If you miss it, enable it under **System Settings
   → Privacy & Security → Automation**.

## Run it continuously

```bash
DISCORD_CLIENT_ID=<your-app-id> node dist/cli.js
```

Logs go to stderr. `Ctrl-C` clears the presence and exits.

## Start it at login

```bash
INSTALL_DIR="$(pwd)"
CLIENT_ID="<your-app-id>"
PLIST="$HOME/Library/LaunchAgents/com.github.apple-music-discord-presence.plist"

sed -e "s|__NODE__|$(command -v node)|" \
    -e "s|__INSTALL_DIR__|${INSTALL_DIR}|" \
    -e "s|__CLIENT_ID__|${CLIENT_ID}|" \
    -e "s|__HOME__|${HOME}|" \
    scripts/com.github.apple-music-discord-presence.plist > "${PLIST}"

launchctl bootstrap gui/"$(id -u)" "${PLIST}"
```

Check on it, and remove it:

```bash
launchctl print gui/"$(id -u)"/com.github.apple-music-discord-presence
tail -f ~/Library/Logs/apple-music-discord-presence.log
launchctl bootout gui/"$(id -u)"/com.github.apple-music-discord-presence
```

The launchd agent needs its own Automation permission the first time it
runs. If the log shows a `-1743` error, run the foreground command once to
trigger the prompt.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--client-id <id>` | `$DISCORD_CLIENT_ID` | Discord application ID (required) |
| `--poll-interval <ms>` | `2000` | How often to ask Music.app what is playing |
| `--once` | off | Publish a single update and exit |
| `--help` | — | Print usage and exit |

## How it works

A 2-second `osascript` poll reads Music.app. Updates are published only when
something meaningful changes — a new track, a pause, a seek — because the
activity carries start and end timestamps that let Discord animate the
progress bar by itself. That matters: Discord silently drops presence
updates sent more than once per 15 seconds, so a coalescing dispatcher holds
the newest payload and emits it when the window opens.

Album art comes from the public iTunes Search API. Results are verified
against the artist and album Music.app reported before being used — the
API's top hit is not reliable enough (searching NIKI's *Nicole* returns
NICKI NICOLE first) — and are cached for 24 hours, misses included.

## Limitations

- Local files and bootlegs that are not in the iTunes catalog show no cover
  art.
- Live radio streams report no duration, so they get no progress bar.
- Pausing removes the progress bar rather than freezing it; Discord has no
  way to express a stopped bar.
- Discord clients have been inconsistent about rendering activity type 2;
  the profile may read "Playing" rather than "Listening" on some versions.

## Development

```bash
npm test          # vitest, no network and no Music.app needed
npm run typecheck
npm run build
```
