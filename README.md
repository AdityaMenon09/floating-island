# Floating Island

A Dynamic Island for the Windows desktop. It hides as a thin line at the top of your screen. Point at
the line and it drops down (pulled open by a character of your choice, if you add one). Then it shows:

- **Music**: whatever's playing (Spotify, YouTube in a browser, any app Windows knows about), with
  album art, play/pause, skip, a seekable timeline and a volume slider. Right-click the timeline to
  loop part of a song.
- **Messages**: WhatsApp messages as they arrive, from your Windows notifications.
- **Calendar**: your Google Calendar's upcoming events, with a heads-up 10 minutes before each.
- **日本語**: kana and simple word flashcards.
- **Notes**: a quick notepad.

Everything stays on your PC. Nothing is sent anywhere.

## What you need

- Windows 10 or 11
- [Node.js](https://nodejs.org) 20 or newer (the LTS version is fine)
- [Git](https://git-scm.com/download/win), or download this repo as a ZIP from GitHub

## Install

Open PowerShell or Terminal and run:

```bash
git clone https://github.com/AdityaMenon09/floating-island.git
```

```bash
cd floating-island
```

```bash
npm install
```

`npm install` downloads Electron (about 100 MB) the first time.

## Start it

```bash
npm start
```

The first time, it asks whether you want a **character**: a little figure that sits beside the island
and pulls it down. It's optional: press Enter for no, and the island works just the same without one.
If you say yes, pick a **PNG with a transparent background** (anything else shows as a rectangle).
You can drag the file into the terminal window to paste its path.

Add or change one any time with:

```bash
npm run character
```

or from the tray icon: **Change character…**. To go back to none:

```bash
npm run character -- --remove
```

After the first time you can start it without a terminal by double-clicking **Floating Island.cmd**.

## Using it

- **Open it**: point at the thin line at the top centre of your screen. Move away and it tucks back.
  `Ctrl+Alt+I` or clicking the tray icon also opens it.
- **Volume**: scroll over the island.
- **Loop part of a song**: on the Music page, right-click the timeline, choose *Loop from here*, then
  right-click again and choose *Loop until here*. Click the pink chip to clear it.
- **Tray icon** (the small pill near the clock): change your character, keep the pill always visible,
  open it when Windows starts, or quit.

### Connect your Google Calendar

1. In [Google Calendar](https://calendar.google.com), open **Settings**, click your calendar under
   *Settings for my calendars*, and scroll to **Integrate calendar**.
2. Copy the **Secret address in iCal format** (the copy button next to the hidden address).
3. In the island, open the Calendar page and click **Paste link**, or use the tray menu.

The island checks for changes every 5 minutes and whenever you open it. Keep that address private:
anyone with it can read your calendar.

### WhatsApp messages

They come from WhatsApp's Windows notifications, so notifications need to be on for WhatsApp, and
apps need to be allowed to read notifications (Settings > Privacy & security > Notifications).

## Troubleshooting

- **The island is a black box**: tray icon > *Safe graphics*.
- **`npm start` says Electron is missing**: run `node node_modules/electron/install.js`.
- **It didn't start with Windows**: tray icon > untick and tick *Open when Windows starts* again.

## Uninstall

Tray icon > untick *Open when Windows starts*, then *Quit Floating Island*. Delete the folder, and
`%APPDATA%\Floating Island` (your character, notes and settings).
