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

## Install

You need Windows 10 or 11. The first install takes about 10 minutes, mostly downloading.

**Rather have an AI assistant do it?** An assistant that can run commands on your PC (for example
Claude Code or OpenAI Codex) can do the whole install. Open it and say:

> Install Floating Island on this PC by following the "Steps for AI assistants" in
> https://raw.githubusercontent.com/AdityaMenon09/floating-island/main/README.md

You'll still click **Yes** on Windows' install prompts. A chat-only assistant (one that can't run
commands) can't install it for you, but it can walk you through the steps below.

### 1. Open a terminal

Press **Start**, type **Terminal** (on Windows 10: **PowerShell**) and press Enter. Paste each line
below into it and press Enter.

### 2. Install Node.js and Git (skip any you already have)

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

```powershell
winget install -e --id Git.Git
```

The first time, winget may ask you to accept its terms: type **Y**. When Windows asks whether to let
the installer make changes, click **Yes**.

No `winget` on your PC? Download and run the installers instead, keeping the default options:
[Node.js (LTS)](https://nodejs.org) and [Git](https://git-scm.com/download/win). On Node's *Tools for
Native Modules* screen, leave the box unticked: the island doesn't need them.

### 3. Close the terminal and open a new one

The new one finds what you just installed. To check:

```powershell
node -v
```

It should print `v20` or higher.

### 4. Download the island and set it up

```powershell
git clone https://github.com/AdityaMenon09/floating-island.git
```

```powershell
cd floating-island
```

```powershell
npm.cmd install
```

This puts the island in your user folder (`C:\Users\<you>\floating-island`) and downloads Electron,
the engine it runs on (about 100 MB).

Why `npm.cmd` and not `npm`? They're the same program, but PowerShell usually blocks plain `npm`
("running scripts is disabled on this system"). In Command Prompt, plain `npm` works too.

**No Git?** Instead of the `git clone` and `cd` lines, run these three, then `npm.cmd install`:

```powershell
Invoke-WebRequest https://github.com/AdityaMenon09/floating-island/archive/refs/heads/main.zip -OutFile floating-island.zip
```

```powershell
Expand-Archive floating-island.zip .
```

```powershell
cd floating-island-main
```

### 5. Start it

```powershell
npm.cmd start
```

The first time, it asks whether you want a **character**: a little figure that sits beside the island
and pulls it down. It's optional: press Enter for no, and the island works just the same without one.
If you say yes, pick a **PNG with a transparent background** (anything else shows as a rectangle).
You can drag the file into the terminal window to paste its path.

From then on, start it by double-clicking **Floating Island.cmd** in the folder (no terminal), or
tick *Open when Windows starts* in the tray menu.

### Characters later

Choose one (it asks for the picture):

```powershell
npm.cmd run character
```

Or name the picture directly, no questions:

```powershell
npm.cmd run character -- "C:\path\to\picture.png"
```

Go back to none:

```powershell
npm.cmd run character -- --remove
```

The tray icon's **Change character…** works too.

### Updating

In the island's folder (Git installs only; with the ZIP, download it again):

```powershell
git pull
```

```powershell
npm.cmd install
```

Then restart the island: tray icon > *Quit Floating Island*, and start it again.

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
- **"running scripts is disabled on this system"**: type `npm.cmd` instead of `npm`.
- **`'node'` or `'git'` is not recognized**: close the terminal and open a new one after installing.
- **Starting it says Electron is missing**: run `node node_modules/electron/install.js` in the folder.
- **It didn't start with Windows**: tray icon > untick and tick *Open when Windows starts* again.

## Uninstall

Tray icon > untick *Open when Windows starts*, then *Quit Floating Island*. Delete the folder, and
`%APPDATA%\Floating Island` (your character, notes and settings).

## Steps for AI assistants

A checklist for an assistant that can run commands, installing Floating Island at its user's
request. Use PowerShell. Run one command at a time (Windows PowerShell 5.1 has no `&&`), and quote
paths that contain spaces.

1. **Windows only.** If this isn't Windows 10 or 11, stop and tell the user.
2. **Node.js 20+ and Git.** Check with `node -v` and `git --version`. Install what's missing with
   `winget install -e --id OpenJS.NodeJS.LTS` and/or `winget install -e --id Git.Git`. winget may
   ask to accept its terms, and Windows may show an admin prompt: leave those to the user to answer.
   Then reload PATH in the current session and check `node -v` again:
   `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`
3. **Get the code** into `$HOME\floating-island`. Avoid Desktop and Documents: OneDrive often syncs
   them, and opening at sign-in breaks if the folder moves later. If the folder already exists, run
   `git pull` in it; otherwise:
   `git clone https://github.com/AdityaMenon09/floating-island.git "$HOME\floating-island"`
4. **Install.** In that folder run `npm.cmd install`. Use `npm.cmd`, because PowerShell's script
   policy often blocks `npm`; don't change the policy. Then check that
   `node_modules\electron\dist\electron.exe` exists. If it doesn't, run
   `node node_modules/electron/install.js`.
5. **Character (optional).** Ask the user whether they want a character beside the island. If yes,
   ask for the picture's path (a PNG with a transparent background looks best) and run
   `npm.cmd run character -- "<path>"`. If it refuses because the picture has no transparent
   background, tell the user, and add `--anyway` only if they still want it. If no, skip this step.
6. **Start it:** `& "$HOME\floating-island\Floating Island.cmd"`. It returns at once and the island
   keeps running. (`npm.cmd start` would block for as long as the island runs.)
7. **Opening at sign-in (optional).** Ask the user first. If yes, in the folder run
   `& .\node_modules\electron\dist\electron.exe . --set-login=on` (it prints the result and exits).
8. **Hand over.** Tell the user that pointing at the thin line at the top centre of the screen opens
   the island (or `Ctrl+Alt+I`), and that the tray icon near the clock has the menu. Two things are
   theirs to set up:
   - **Calendar:** they copy their calendar's *Secret address in iCal format* (see *Connect your
     Google Calendar* above) and click **Paste link** on the island's Calendar page. Don't ask for
     that address or handle it: anyone who has it can read their calendar.
   - **WhatsApp banners:** WhatsApp's Windows notifications must be on, and *Settings > Privacy &
     security > Notifications* must let apps read them. Tell the user where; don't change settings.
