# Sonora

A small Windows app for saving songs and playlists from YouTube and YouTube Music as audio files that play anywhere, including car stereos.

- Lists every track in a song, album or playlist link before downloading, so you pick what to keep
- MP3, M4A or Opus, with tags and cover art
- Car stereo mode: MP3 files with names, numbering and cover art that car stereos read reliably
- Sorts songs into folders by playlist, artist, genre, language or your own folders
- Tops up a USB drive with only the songs it doesn't have yet
- Liked songs and private playlists after signing in to YouTube
- Themes: nine built-in themes, plus your own made from a background, panel, text and accent colour

Built with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [pywebview](https://pywebview.flowrl.com/).

## Running from source

Requires Windows 10 or 11 and Python 3.12 or newer.

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

Sonora needs `ffmpeg.exe`, `ffprobe.exe` (with their DLLs) and `deno.exe` in `vendor\bin`. They are too large to keep in git, so download them yourself:

- ffmpeg shared build: https://www.gyan.dev/ffmpeg/builds/ (copy everything in its `bin` folder)
- deno: https://github.com/denoland/deno/releases (`deno-x86_64-pc-windows-msvc.zip`)

Then start it:

```bash
.venv\Scripts\python app.py
```

Add `--debug` to open the WebView developer tools.

## Building the app

```bash
.venv\Scripts\pyinstaller --noconfirm Sonora.spec
```

The app lands in `dist\Sonora`.

## Where Sonora keeps things

- Settings, custom themes and the log: `%APPDATA%\Sonora`
- YouTube sign-in cookies: `%APPDATA%\Sonora\cookies.txt`, on this PC only
- Each music folder gets a hidden `.sonora.json` that remembers which songs are already there
