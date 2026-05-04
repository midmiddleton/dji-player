# DJI Player

Personal video library, organiser, and edit-prep tool for DJI drone footage. Browse, tag, and organise clips, generate AI titles and descriptions, upload to YouTube and Google Drive, overlay live GPS/fitness data during playback, and assemble edit projects ready for Kdenlive.

---

## Features

**Library**
- Single consolidated video directory (`~/Videos/DJI-camera-files/`) scanned recursively
- Thumbnail grid with lazy loading and deduplication by filename + size
- Sort by date, size, duration, or name
- Search across filenames, AI titles, and transcripts
- Filter by tag or GPS location
- SD card auto-import — when a DJI SD card is mounted, new files are automatically copied to the library

**Playback**
- Canvas-based player with brightness, contrast, saturation, sharpness, and zoom controls
- Auto enhance preset (boosts flat DJI footage)
- Export clip with colour correction applied (re-encodes via FFmpeg)
- TV/smart display fallback (plain `<video>` element for browsers that block canvas)

**Live GPS / Fitness Overlay**
- When a clip belongs to a run project with a linked GPX file, a HUD is overlaid during playback
- Mini route map with position dot and travelled-so-far highlight
- HR zone bar (Karvonen/HRR method) that fills up as heart rate increases — zones per project using configured max HR and resting HR
- Stats: heart rate, pace, grade (200 m smoothing window), air temperature, distance, elapsed run time
- Supports both Garmin and Strava GPX exports; prefers Garmin (has `atemp` temperature field)

**AI descriptions**
- Generates titles and descriptions for every clip using Claude Haiku
- Uses GPS location, date, duration, and Whisper transcript as context
- Editable via the ✏️ Edit modal

**Transcription**
- Per-clip Whisper transcription (Python, `small` model)
- Transcript used as context for AI descriptions and YouTube metadata

**Tags**
- Add/remove tags per clip; filter bar updates live
- Tags can be linked to a YouTube playlist — uploading a tagged clip auto-adds it to the playlist
- ⬆ Sync button on linked tags queues all tagged clips for upload in one click
- Videos tagged `hidden` are stored in a `.hidden/` subfolder (hidden from Linux file managers) and PIN-protected in the app

**Google Drive**
- Per-clip upload via rclone to `gdrive:DJI-footage`
- Card shows live "Uploading…" state, flips to "🗑 Local" automatically when Drive confirms the file
- Archive button: uploads to Drive then deletes local copy to free disk space
- Bulk archive panel: lists old clips already on Drive and removes local copies in one click

**YouTube**
- OAuth2 upload with real-time progress bar
- Title/description pre-filled from AI descriptions
- Playlist management: create, share, delete playlists; add/remove videos
- Bulk sync queue: background worker uploads and adds to playlist, survives server restarts
- Update YouTube title/description/tags from the Edit modal after upload

**Edit Projects**
- Named projects with a storyline/notes field
- Add clips from the library; drag to reorder
- Per-clip trim in/out sliders (auto-save)
- Per-clip notes
- ▶ Preview button — opens clip in player, back button returns to the project editor
- Running projects: link a Strava or Garmin GPX file; project panel shows route map, HR/elevation charts, and per-clip stats
- Export to Kdenlive `.mlt` file

**GPS / Locations**
- Extracts GPS coords from iPhone MOV files (ISO 6709 QuickTime tag)
- Reverse geocodes to suburb/city via Nominatim (OpenStreetMap)
- Location shown on cards and used in AI descriptions

---

## Setup on a new machine

### 1. System dependencies

```bash
# FFmpeg (thumbnails, streaming, export)
sudo apt install ffmpeg

# rclone (Google Drive sync)
sudo apt install rclone
rclone config  # set up a remote named "gdrive"

# Python + Whisper (transcription — optional)
pip install openai-whisper
```

### 2. Clone and install

```bash
git clone https://github.com/midmiddleton/dji-player.git
cd dji-player
npm install
```

### 3. Create `.env`

```
DJI_USER=your_username
DJI_PASS=your_password
DJI_PIN=1234

ANTHROPIC_API_KEY=sk-ant-...

GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

- **Anthropic key** — get one at console.anthropic.com (needs credits for AI descriptions)
- **Google OAuth** — create a project at console.cloud.google.com, enable YouTube Data API v3, create OAuth 2.0 credentials (Web application), add `http://localhost:3000/auth/youtube/callback` as an authorised redirect URI

### 4. Video directory

All footage lives in one place:

```
~/Videos/DJI-camera-files/         ← main library
~/Videos/DJI-camera-files/.hidden/ ← PIN-protected clips (hidden from file manager)
```

Edit `IMPORT_DEST` near the top of `server.js` if you want a different location.

### 5. Run

```bash
node server.js
```

Open [http://localhost:3000](http://localhost:3000) — Basic Auth prompt will appear.

To restart cleanly:

```bash
lsof -ti :3000 | xargs kill 2>/dev/null; sleep 1 && node server.js &
```

### 6. Connect YouTube (optional)

Click **▶ Playlists** → authenticate with Google. The OAuth token is saved to `yt-token.json` (gitignored).

### 7. Connect Google Drive (optional)

Run `rclone config` and set up a remote named `gdrive`. The app uploads to `gdrive:DJI-footage`. The `GDRIVE_REMOTE` constant in `server.js` can be changed if needed.

---

## Architecture

| File | Purpose |
|---|---|
| `server.js` | Entire backend — Express, SQLite (better-sqlite3), FFmpeg, rclone, Claude API, YouTube Data API |
| `public/index.html` | Entire frontend — vanilla JS, no framework, all CSS inline |
| `videos.db` | SQLite database — metadata, tags, transcripts, descriptions, projects, YouTube/Drive state |
| `.env` | Credentials (gitignored) |
| `yt-token.json` | YouTube OAuth token (gitignored) |
| `public/thumbs/` | Generated JPEG thumbnails (gitignored) |

The server is single-file, no build step. Edit `server.js` or `public/index.html` and restart.
