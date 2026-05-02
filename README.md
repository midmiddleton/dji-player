# DJI Player

Personal video library and editor prep tool for DJI drone and iPhone footage. Browse, tag, and organise clips, generate AI titles and descriptions, upload to YouTube, and assemble edit projects ready for Kdenlive.

---

## Features

**Library**
- Scans multiple directories recursively for video files (MP4, MOV, AVI, MKV)
- Thumbnail grid with lazy loading, deduplication by filename + size
- Sort by date, size, duration, or name
- Search across filenames, AI titles, and transcripts
- Filter by tag or GPS location

**Playback**
- Canvas-based player with brightness, contrast, saturation, sharpness, and zoom controls
- Auto enhance preset (boosts flat DJI footage)
- Export clip with colour correction applied (re-encodes via FFmpeg)
- TV/smart display fallback (plain `<video>` element for browsers that block canvas)

**AI descriptions**
- Generates titles and descriptions for every clip using Claude Haiku
- Uses GPS location, date, duration, and Whisper transcript as context
- Bulk "Describe All" with live progress bar; resumes after restart
- Editable via the ✏️ Edit modal

**Transcription**
- Per-clip Whisper transcription (Python, `small` model)
- Transcript used as context for AI descriptions and YouTube metadata

**Tags**
- Add/remove tags per clip; filter bar updates live
- Tags can be linked to a YouTube playlist — uploading a tagged clip auto-adds it to the playlist
- ⬆ Sync button on linked tags queues all tagged clips for upload + playlist add in one click
- Private videos tagged `hidden` are hidden by default (PIN-protected unlock)

**YouTube**
- OAuth2 upload with real-time progress bar
- Title/description pre-filled from AI descriptions
- Playlist management: create, share, delete playlists; add/remove videos
- Bulk sync queue: background worker uploads and adds to playlist, survives server restarts
- Update YouTube title/description/tags from the Edit modal after upload

**Edit Projects** *(Phase 1 of Kdenlive pipeline)*
- Named projects with a storyline/notes field
- Add clips from the library; drag to reorder
- Per-clip trim in/out sliders (auto-save)
- Per-clip notes
- ▶ Preview button — opens clip in player, back button returns to the project editor
- Phase 2 (planned): silence detection + transcript-guided auto-trim suggestions
- Phase 3 (planned): export to Kdenlive `.mlt` file

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

### 4. Configure video directories

Edit `VIDEO_DIRS` near the top of `server.js` to point at wherever your footage lives:

```js
const VIDEO_DIRS = [
  path.join(__dirname, 'videos'),           // local test clips
  '/home/you/Documents/DJI Camera files',
  '/home/you/Pictures/camera vids',
  // ...
];
```

### 5. Run

```bash
node server.js
```

Open [http://localhost:3000](http://localhost:3000) — Basic Auth prompt will appear (use `DJI_USER` / `DJI_PASS` from `.env`).

To restart cleanly:

```bash
lsof -ti :3000 | xargs kill 2>/dev/null; sleep 1 && node server.js &
```

### 6. Connect YouTube (optional)

Click **▶ Playlists** → authenticate with Google. The OAuth token is saved to `yt-token.json` (gitignored). If you get scope errors, delete `yt-token.json` and re-authenticate.

---

## Architecture

| File | Purpose |
|---|---|
| `server.js` | Entire backend — Express 5, SQLite (better-sqlite3), FFmpeg, Claude API, YouTube Data API |
| `public/index.html` | Entire frontend — vanilla JS, no framework, all CSS inline |
| `videos.db` | SQLite database — metadata, tags, transcripts, descriptions, projects, YouTube state |
| `.env` | Credentials (gitignored) |
| `yt-token.json` | YouTube OAuth token (gitignored) |
| `public/thumbs/` | Generated JPEG thumbnails (gitignored) |
| `meta-cache.json` | Legacy ffprobe cache — migrated to DB on first run |

The server is single-file, no build step. Edit `server.js` or `public/index.html` and restart.
