# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the server

```bash
node server.js
```

The server runs on port 3000. Credentials are in `.env` (Basic Auth). To restart cleanly:

```bash
lsof -ti :3000 | xargs kill 2>/dev/null; sleep 1 && node server.js &
```

## Architecture

Single-file Express server (`server.js`) + single-page frontend (`public/index.html`). No build step.

**server.js** handles:
- Basic Auth middleware (credentials from `.env`)
- `GET /api/videos` — scans all `VIDEO_DIRS` recursively, deduplicates by filename+size, runs ffprobe for duration (batched 8 at a time, cached to `meta-cache.json`)
- `GET /video/:encodedPath` — range-request streaming for any video in an allowed dir
- `GET /thumb/:encodedPath` — on-demand thumbnail via ffmpeg (seeked to 20% of duration), cached in `public/thumbs/`. On-demand requests are priority-queued; background pre-generation runs at startup. All ffmpeg jobs share a global queue capped at 4 concurrent.

**public/index.html** — all CSS and JS inline, no framework. Two views: library grid and player. Player renders via canvas (for brightness/contrast/saturation/sharpness/zoom filters).

**Key files:**
- `server.js` — entire backend
- `public/index.html` — entire frontend
- `.env` — `DJI_USER` / `DJI_PASS`
- `meta-cache.json` — ffprobe duration cache (keyed by `fullPath:mtime`)
- `public/thumbs/` — generated JPEG thumbnails (base64url-encoded path as filename)

## Video sources

`VIDEO_DIRS` in `server.js` lists all scanned directories. Currently includes:
- `videos/` (local)
- `~/Documents/DJI Camera files`
- `~/Pictures/camera vids` (recursive — includes Sydney, Home, Pool, Scooter vids, etc.)
- `~/Desktop/back up`
- `~/Downloads`
- `~/Videos`
- `/media/midders/3561-3031/DCIM` (DJI SD card — only present when plugged in)

## Planned features (not yet implemented)

- Sort controls (by date, name, size, duration)
- Date grouping (by month)
- Tags + descriptions (stored in JSON, filterable)
- GPS/location metadata from DJI video files
