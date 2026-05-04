const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFile, spawn } = require('child_process');
const Database = require('better-sqlite3');
const { google } = require('googleapis');

const app = express();
const PORT = 3000;

const VIDEO_DIRS = [
  '/home/midders/Videos/DJI-camera-files',
];

const MEDIA_ROOT  = `/media/${require('os').userInfo().username}`;
const IMPORT_DEST = '/home/midders/Videos/DJI-camera-files';
const HIDDEN_DIR  = path.join(IMPORT_DEST, '.hidden');
if (!fs.existsSync(HIDDEN_DIR)) fs.mkdirSync(HIDDEN_DIR, { recursive: true });

// Dynamically find any mounted SD card under /media/<user>/*/DCIM
function findSdPath() {
  if (!fs.existsSync(MEDIA_ROOT)) return null;
  for (const vol of fs.readdirSync(MEDIA_ROOT)) {
    const dcim = path.join(MEDIA_ROOT, vol, 'DCIM');
    if (fs.existsSync(dcim)) return dcim;
  }
  return null;
}

// Keep VIDEO_DIRS in sync so the library scanner picks up card files too
function syncSdToVideoDirs() {
  const sdPath = findSdPath();
  // Remove any stale /media entries
  for (let i = VIDEO_DIRS.length - 1; i >= 0; i--) {
    if (VIDEO_DIRS[i].startsWith(MEDIA_ROOT)) VIDEO_DIRS.splice(i, 1);
  }
  if (sdPath) VIDEO_DIRS.push(sdPath);
}

const THUMB_DIR = path.join(__dirname, 'public', 'thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// --- Database ---
const db = new Database(path.join(__dirname, 'videos.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS video_meta (
    path        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    size        INTEGER,
    mtime       TEXT,
    duration    REAL,
    codec       TEXT,
    gps_lat     REAL,
    gps_lon     REAL,
    location    TEXT,
    gps_checked INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tags (
    path TEXT NOT NULL,
    tag  TEXT NOT NULL,
    PRIMARY KEY (path, tag)
  );
  CREATE TABLE IF NOT EXISTS migrations (
    key TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS drive_files (
    filename   TEXT PRIMARY KEY,
    size       INTEGER,
    synced_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS transcriptions (
    path       TEXT PRIMARY KEY,
    text       TEXT,
    language   TEXT,
    status     TEXT DEFAULT 'pending',
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS descriptions (
    path        TEXT PRIMARY KEY,
    title       TEXT,
    description TEXT,
    status      TEXT DEFAULT 'pending',
    updated_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    created_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS playlist_videos (
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    position    INTEGER DEFAULT 0,
    PRIMARY KEY (playlist_id, path)
  );
  CREATE TABLE IF NOT EXISTS yt_uploads (
    path       TEXT NOT NULL,
    video_id   TEXT NOT NULL,
    channel_id TEXT,
    uploaded_at TEXT,
    PRIMARY KEY (path, video_id)
  );
  CREATE TABLE IF NOT EXISTS tag_yt_links (
    tag          TEXT PRIMARY KEY,
    playlist_id  TEXT NOT NULL,
    playlist_name TEXT,
    playlist_url  TEXT,
    privacy       TEXT DEFAULT 'unlisted'
  );
  CREATE TABLE IF NOT EXISTS yt_playlists (
    playlist_id  TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    privacy      TEXT NOT NULL DEFAULT 'unlisted',
    description  TEXT,
    url          TEXT,
    created_at   TEXT
  );
  CREATE TABLE IF NOT EXISTS yt_playlist_items (
    playlist_id  TEXT NOT NULL REFERENCES yt_playlists(playlist_id) ON DELETE CASCADE,
    video_id     TEXT NOT NULL,
    PRIMARY KEY  (playlist_id, video_id)
  );
  CREATE TABLE IF NOT EXISTS edit_projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    storyline   TEXT,
    created_at  TEXT,
    updated_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS edit_project_clips (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES edit_projects(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    trim_in     REAL NOT NULL DEFAULT 0,
    trim_out    REAL,
    note        TEXT,
    UNIQUE(project_id, path)
  );
  CREATE TABLE IF NOT EXISTS yt_sync_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL,
    playlist_id TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    yt_video_id TEXT,
    error       TEXT,
    created_at  TEXT
  );
`);

// Schema migrations (run before prepared statements)
try { db.prepare("ALTER TABLE edit_projects ADD COLUMN project_type TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE edit_projects ADD COLUMN gpx_path TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE edit_projects ADD COLUMN garmin_gpx_path TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE edit_projects ADD COLUMN max_hr INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE edit_projects ADD COLUMN rest_hr INTEGER").run(); } catch {}

// Prepared statements
const q = {
  getMeta:        db.prepare('SELECT * FROM video_meta WHERE path = ?'),
  upsertBase:     db.prepare(`INSERT INTO video_meta (path, name, size, mtime) VALUES (?, ?, ?, ?)
                              ON CONFLICT(path) DO UPDATE SET name=excluded.name, size=excluded.size, mtime=excluded.mtime`),
  setDuration:    db.prepare('UPDATE video_meta SET duration = ?, mtime = ? WHERE path = ?'),
  setCodec:       db.prepare('UPDATE video_meta SET codec = ? WHERE path = ?'),
  setGPS:         db.prepare('UPDATE video_meta SET gps_lat = ?, gps_lon = ?, location = ?, gps_checked = 1 WHERE path = ?'),
  setLocation:    db.prepare('UPDATE video_meta SET location = ? WHERE path = ?'),
  markGPSDone:    db.prepare('UPDATE video_meta SET gps_checked = 1 WHERE path = ?'),
  getTags:        db.prepare('SELECT tag FROM tags WHERE path = ?'),
  allTags:        db.prepare('SELECT path, tag FROM tags'),
  deleteTags:     db.prepare('DELETE FROM tags WHERE path = ?'),
  insertTag:      db.prepare('INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)'),
  deleteVideo:    db.prepare('DELETE FROM video_meta WHERE path = ?'),
  migrated:       db.prepare('SELECT key FROM migrations WHERE key = ?'),
  setMigrated:    db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)'),
  getTranscript:    db.prepare('SELECT text, language, status FROM transcriptions WHERE path = ?'),
  upsertTranscript: db.prepare(`INSERT INTO transcriptions (path, text, language, status, updated_at) VALUES (?, ?, ?, ?, ?)
                                ON CONFLICT(path) DO UPDATE SET text=excluded.text, language=excluded.language, status=excluded.status, updated_at=excluded.updated_at`),
  nextTranscript:   db.prepare("SELECT path FROM transcriptions WHERE status='pending' ORDER BY rowid LIMIT 1"),
  deleteTranscript:   db.prepare('DELETE FROM transcriptions WHERE path = ?'),
  allTranscriptsDone: db.prepare("SELECT path, text FROM transcriptions WHERE status='done'"),
  getDesc:            db.prepare('SELECT title, description, status FROM descriptions WHERE path = ?'),
  upsertDesc:         db.prepare(`INSERT INTO descriptions (path, title, description, status, updated_at) VALUES (?, ?, ?, ?, ?)
                                  ON CONFLICT(path) DO UPDATE SET title=excluded.title, description=excluded.description, status=excluded.status, updated_at=excluded.updated_at`),
  nextDesc:           db.prepare("SELECT path FROM descriptions WHERE status='pending' ORDER BY rowid LIMIT 1"),
  allDescsDone:       db.prepare("SELECT path, title, description FROM descriptions WHERE status='done'"),
  deleteDesc:         db.prepare('DELETE FROM descriptions WHERE path = ?'),
  allPlaylists:       db.prepare('SELECT id, name, created_at FROM playlists ORDER BY id'),
  insertPlaylist:     db.prepare('INSERT INTO playlists (name, created_at) VALUES (?, ?)'),
  deletePlaylist:     db.prepare('DELETE FROM playlists WHERE id = ?'),
  playlistVideos:     db.prepare('SELECT path, position FROM playlist_videos WHERE playlist_id = ? ORDER BY position'),
  addToPlaylist:      db.prepare('INSERT OR IGNORE INTO playlist_videos (playlist_id, path, position) VALUES (?, ?, ?)'),
  removeFromPlaylist: db.prepare('DELETE FROM playlist_videos WHERE playlist_id = ? AND path = ?'),
  videoPlaylists:     db.prepare('SELECT playlist_id FROM playlist_videos WHERE path = ?'),
  insertYTUpload:     db.prepare('INSERT OR REPLACE INTO yt_uploads (path, video_id, channel_id, uploaded_at) VALUES (?, ?, ?, ?)'),
  getYTUploads:       db.prepare('SELECT video_id, channel_id FROM yt_uploads WHERE path = ?'),
  allYTUploads:       db.prepare('SELECT path, video_id FROM yt_uploads'),
  allTagLinks:        db.prepare('SELECT * FROM tag_yt_links ORDER BY tag'),
  getTagLink:         db.prepare('SELECT * FROM tag_yt_links WHERE tag = ?'),
  upsertTagLink:      db.prepare('INSERT OR REPLACE INTO tag_yt_links (tag, playlist_id, playlist_name, playlist_url, privacy) VALUES (?, ?, ?, ?, ?)'),
  deleteTagLink:      db.prepare('DELETE FROM tag_yt_links WHERE tag = ?'),
  allYTPlaylists:     db.prepare('SELECT * FROM yt_playlists ORDER BY created_at DESC'),
  upsertYTPlaylist:   db.prepare('INSERT OR REPLACE INTO yt_playlists (playlist_id, name, privacy, description, url, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  deleteYTPlaylist:   db.prepare('DELETE FROM yt_playlists WHERE playlist_id = ?'),
  playlistItems:      db.prepare('SELECT video_id FROM yt_playlist_items WHERE playlist_id = ?'),
  addPlaylistItem:    db.prepare('INSERT OR IGNORE INTO yt_playlist_items (playlist_id, video_id) VALUES (?, ?)'),
  removePlaylistItem: db.prepare('DELETE FROM yt_playlist_items WHERE playlist_id = ? AND video_id = ?'),
  videoInPlaylists:   db.prepare('SELECT playlist_id FROM yt_playlist_items WHERE video_id = ?'),
  allProjects:        db.prepare('SELECT id, name, storyline, project_type, gpx_path, garmin_gpx_path, max_hr, rest_hr, created_at, updated_at FROM edit_projects ORDER BY updated_at DESC'),
  insertProject:      db.prepare('INSERT INTO edit_projects (name, storyline, project_type, gpx_path, garmin_gpx_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateProject:      db.prepare('UPDATE edit_projects SET name=?, storyline=?, project_type=?, gpx_path=?, garmin_gpx_path=?, updated_at=? WHERE id=?'),
  deleteProject:      db.prepare('DELETE FROM edit_projects WHERE id=?'),
  projectClips:       db.prepare('SELECT * FROM edit_project_clips WHERE project_id=? ORDER BY position'),
  insertClip:         db.prepare('INSERT OR IGNORE INTO edit_project_clips (project_id, path, position, trim_in, trim_out) VALUES (?, ?, ?, ?, ?)'),
  updateClip:         db.prepare('UPDATE edit_project_clips SET position=?, trim_in=?, trim_out=?, note=? WHERE id=?'),
  deleteClip:         db.prepare('DELETE FROM edit_project_clips WHERE id=?'),
  reorderClips:       db.prepare('UPDATE edit_project_clips SET position=? WHERE id=?'),
  insertSyncItem:     db.prepare("INSERT INTO yt_sync_queue (path, playlist_id, status, created_at) VALUES (?, ?, 'pending', ?)"),
  nextSyncItem:       db.prepare("SELECT * FROM yt_sync_queue WHERE status='pending' ORDER BY id LIMIT 1"),
  updateSyncItem:     db.prepare('UPDATE yt_sync_queue SET status=?, yt_video_id=?, error=? WHERE id=?'),
  countSyncQueue:     db.prepare("SELECT status, COUNT(*) as n FROM yt_sync_queue GROUP BY status"),
  syncQueueForTag:    db.prepare("SELECT path FROM yt_sync_queue WHERE playlist_id=? AND status IN ('pending','processing')"),
};

// --- Transcription worker ---
let transcribing = false;

function transcribeNext() {
  if (transcribing) return;
  const row = q.nextTranscript.get();
  if (!row) return;
  transcribing = true;
  q.upsertTranscript.run(row.path, null, null, 'processing', new Date().toISOString());
  console.log(`Transcribing: ${path.basename(row.path)}`);
  execFile('python3', [path.join(__dirname, 'transcribe.py'), row.path, 'small'],
    { timeout: 7200000, maxBuffer: 10 * 1024 * 1024 },
    (err, stdout, stderr) => {
      transcribing = false;
      if (err) {
        console.error(`Transcription failed for ${path.basename(row.path)}:`, err.message, (stderr || '').slice(0, 400));
        q.upsertTranscript.run(row.path, null, null, 'error', new Date().toISOString());
      } else {
        try {
          const lastLine = stdout.trim().split('\n').pop();
          const { text, language } = JSON.parse(lastLine);
          q.upsertTranscript.run(row.path, text, language, 'done', new Date().toISOString());
          console.log(`Transcribed: ${path.basename(row.path)}`);
        } catch (e) {
          console.error(`Transcript parse error for ${path.basename(row.path)}:`, e.message, stdout?.slice(0, 200));
          q.upsertTranscript.run(row.path, null, null, 'error', new Date().toISOString());
        }
      }
      transcribeNext();
    }
  );
}

// --- One-time migration from JSON files ---
function migrateJSON() {
  if (q.migrated.get('v1')) return;

  // meta-cache.json: { "path:mtime": duration }
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'meta-cache.json'), 'utf8'));
    const run = db.transaction(() => {
      for (const [key, duration] of Object.entries(cache)) {
        const split = key.lastIndexOf(':');
        const p = key.slice(0, split);
        const mtime = key.slice(split + 1);
        q.upsertBase.run(p, path.basename(p), null, mtime);
        if (duration !== null) q.setDuration.run(duration, mtime, p);
      }
    });
    run();
    console.log(`Migrated ${Object.keys(cache).length} duration entries`);
  } catch {}

  // location-cache.json
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'location-cache.json'), 'utf8'));
    const coordLabels = {};
    for (const [k, v] of Object.entries(cache)) {
      if (!k.startsWith('gps:')) coordLabels[k] = v;
    }
    const run = db.transaction(() => {
      for (const [k, gps] of Object.entries(cache)) {
        if (!k.startsWith('gps:')) continue;
        const p = k.slice(4);
        if (!gps) { q.markGPSDone.run(p); continue; }
        const coordKey = `${gps.lat.toFixed(3)},${gps.lon.toFixed(3)}`;
        const label = coordLabels[coordKey] || null;
        q.setGPS.run(gps.lat, gps.lon, label, p);
      }
    });
    run();
    console.log('Migrated GPS/location data');
  } catch {}

  // tags.json: { "path_or_encoded_path": ["tag", ...] }
  try {
    const tags = JSON.parse(fs.readFileSync(path.join(__dirname, 'tags.json'), 'utf8'));
    const run = db.transaction(() => {
      for (const [rawPath, tagList] of Object.entries(tags)) {
        let p = rawPath;
        try { if (rawPath.includes('%2F') || rawPath.includes('%20')) p = decodeURIComponent(rawPath); } catch {}
        for (const tag of (tagList || [])) q.insertTag.run(p, tag);
      }
    });
    run();
    console.log('Migrated tags');
  } catch {}

  q.setMigrated.run('v1');
}

migrateJSON();

// --- Env / Auth ---
const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
  .split('\n').reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return acc;
    const eq = trimmed.indexOf('=');
    if (eq < 0) return acc;
    const k = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k) acc[k] = v;
    return acc;
  }, {});

const AUTH_USER = env.DJI_USER;
const AUTH_PASS = env.DJI_PASS;
const AUTH_PIN  = env.DJI_PIN || '1234';

// --- YouTube OAuth ---
const YT_TOKEN_FILE = path.join(__dirname, 'yt-token.json');
const REDIRECT_URI  = `http://localhost:${3000}/auth/youtube/callback`;

function makeOAuth2() {
  const clientId     = env.GOOGLE_OAUTH_CLIENT_ID     || '';
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

function loadYTToken() {
  try { return JSON.parse(fs.readFileSync(YT_TOKEN_FILE, 'utf8')); } catch { return null; }
}

function saveYTToken(tokens) {
  fs.writeFileSync(YT_TOKEN_FILE, JSON.stringify(tokens));
}

function getAuthenticatedYT() {
  const tokens = loadYTToken();
  if (!tokens) return null;
  const auth = makeOAuth2();
  auth.setCredentials(tokens);
  auth.on('tokens', t => { if (t.refresh_token || tokens.refresh_token) saveYTToken({ ...tokens, ...t }); });
  return google.youtube({ version: 'v3', auth });
}

// Parse date from DJI filename or fall back to mtime
function parseDateFromVideo(filePath, mtime) {
  const name = path.basename(filePath);
  const m = name.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  return mtime ? new Date(mtime) : new Date();
}

function buildYTMeta(filePath, row) {
  const date  = parseDateFromVideo(filePath, row?.mtime);
  const loc   = row?.location || null;
  const tx    = db.prepare("SELECT text FROM transcriptions WHERE path=? AND status='done'").get(filePath)?.text || null;

  const day   = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const parts = [loc, day].filter(Boolean);
  const title = parts.join(' · ') || path.basename(filePath, path.extname(filePath));

  const descLines = [];
  if (loc)  descLines.push(`📍 ${loc}`);
  descLines.push(`📅 ${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`);
  if (tx)   descLines.push('', tx.slice(0, 1000));

  return { title: title.slice(0, 100), description: descLines.join('\n') };
}

const SESSION_COOKIE = 'dji_session';
const sessions = new Set();

function validSession(req) {
  const cookie = (req.headers.cookie || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith(SESSION_COOKIE + '='));
  return cookie && sessions.has(cookie.split('=')[1]);
}

app.use((req, res, next) => {
  if (validSession(req)) return next();
  const header = req.headers.authorization;
  if (header && header.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    if (user === AUTH_USER && pass === AUTH_PASS) {
      const token = crypto.randomBytes(24).toString('hex');
      sessions.add(token);
      res.set('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${90 * 24 * 3600}; HttpOnly; SameSite=Strict`);
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="DJI Player"');
  res.status(401).send('Unauthorized');
});

app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Video scanning ---
function scanVideos(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...scanVideos(fullPath));
    else if (/\.(mp4|mov|avi|mkv)$/i.test(entry.name)) {
      const stat = fs.statSync(fullPath);
      results.push({ name: entry.name, fullPath, size: stat.size, mtime: stat.mtime.toISOString() });
    }
  }
  return results;
}

// --- Duration ---
function getDuration(fullPath, mtime) {
  const row = q.getMeta.get(fullPath);
  if (row && row.mtime === mtime && row.duration !== null && row.duration !== undefined) {
    return Promise.resolve(row.duration);
  }
  return new Promise(resolve => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', fullPath],
      (err, stdout) => {
        let duration = null;
        if (!err) {
          try {
            const stream = JSON.parse(stdout).streams.find(s => s.codec_type === 'video');
            duration = stream ? parseFloat(stream.duration) : null;
          } catch {}
        }
        q.upsertBase.run(fullPath, path.basename(fullPath), null, mtime);
        q.setDuration.run(duration, mtime, fullPath);
        resolve(duration);
      });
  });
}

// --- GPS / Location ---
function extractGPS(fullPath) {
  return new Promise(resolve => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', fullPath],
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const tags = JSON.parse(stdout).format.tags || {};
          const iso = tags['com.apple.quicktime.location.ISO6709'];
          if (!iso) return resolve(null);
          const m = iso.match(/([+-]\d+\.\d+)([+-]\d+\.\d+)/);
          resolve(m ? { lat: parseFloat(m[1]), lon: parseFloat(m[2]) } : null);
        } catch { resolve(null); }
      });
  });
}

let lastGeocode = 0;
const geocodeCache = {};  // in-memory coord→label cache to avoid duplicate DB writes mid-run

function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (key in geocodeCache) return Promise.resolve(geocodeCache[key]);
  return new Promise(resolve => {
    const wait = Math.max(0, 1100 - (Date.now() - lastGeocode));
    setTimeout(() => {
      lastGeocode = Date.now();
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14`;
      https.get(url, { headers: { 'User-Agent': 'dji-player/1.0' } }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const a = JSON.parse(body).address || {};
            const area = a.suburb || a.neighbourhood || a.quarter || a.village || a.hamlet;
            const city = a.city || a.town || a.municipality || a.county;
            const label = [area, city || a.state].filter(Boolean).join(', ') || a.country || null;
            geocodeCache[key] = label;
            resolve(label);
          } catch { geocodeCache[key] = null; resolve(null); }
        });
      }).on('error', () => resolve(null));
    }, wait);
  });
}

// --- API: Videos ---
app.get('/api/videos', async (_req, res) => {
  const videos = VIDEO_DIRS.flatMap(scanVideos);
  const seen = new Set();
  const unique = videos.filter(v => {
    const key = v.name + v.size;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Upsert all scanned files into DB (name/size/mtime)
  const upsertAll = db.transaction(() => {
    for (const v of unique) q.upsertBase.run(v.fullPath, v.name, v.size, v.mtime);
  });
  upsertAll();

  // Fetch durations in batches
  const withDuration = [];
  for (let i = 0; i < unique.length; i += 8) {
    const batch = unique.slice(i, i + 8);
    withDuration.push(...await Promise.all(
      batch.map(async v => ({ ...v, duration: await getDuration(v.fullPath, v.mtime) }))
    ));
  }

  // Build tag map from DB
  const tagMap = {};
  for (const { path: p, tag } of q.allTags.all()) {
    if (!tagMap[p]) tagMap[p] = [];
    tagMap[p].push(tag);
  }

  // Build transcript map
  const txMap = {};
  for (const { path: p, text } of q.allTranscriptsDone.all()) txMap[p] = text;

  // Build description map
  const descMap = {};
  for (const { path: p, title, description } of q.allDescsDone.all()) descMap[p] = { title, description };

  // Build YouTube upload map
  const ytMap = {};
  for (const { path: p, video_id } of q.allYTUploads.all()) {
    if (!ytMap[p]) ytMap[p] = [];
    ytMap[p].push(video_id);
  }

  // Build playlist-membership map: path → [{playlistId, name}]
  const playlistRows = db.prepare(`
    SELECT u.path, p.playlist_id, p.name
    FROM yt_uploads u
    JOIN yt_playlist_items i ON i.video_id = u.video_id
    JOIN yt_playlists p      ON p.playlist_id = i.playlist_id
  `).all();
  const ytPlaylistMap = {};
  for (const { path: p, playlist_id, name } of playlistRows) {
    if (!ytPlaylistMap[p]) ytPlaylistMap[p] = [];
    ytPlaylistMap[p].push({ id: playlist_id, name });
  }

  res.json(
    withDuration
      .filter(v => !v.duration || v.duration >= 3)
      .map(v => {
        const row = q.getMeta.get(v.fullPath);
        return {
          name:       v.name,
          path:       encodeURIComponent(v.fullPath),
          size:       v.size,
          modified:   v.mtime,
          duration:   v.duration,
          location:   row?.location || null,
          tags:        tagMap[v.fullPath] || [],
          transcript:  txMap[v.fullPath] || null,
          aiTitle:     descMap[v.fullPath]?.title || null,
          aiDesc:      descMap[v.fullPath]?.description || null,
          ytVideoIds:  ytMap[v.fullPath] || [],
          ytPlaylists: ytPlaylistMap[v.fullPath] || [],
        };
      })
  );
});

// --- API: Tags ---
app.get('/api/tags', (_req, res) => {
  const out = {};
  for (const { path: p, tag } of q.allTags.all()) {
    const encoded = encodeURIComponent(p);
    if (!out[encoded]) out[encoded] = [];
    out[encoded].push(tag);
  }
  res.json(out);
});

const PATH_TABLES = ['video_meta', 'tags', 'transcriptions', 'descriptions', 'playlist_videos', 'yt_uploads', 'edit_project_clips', 'yt_sync_queue'];
const moveVideoPath = db.transaction((oldP, newP) => {
  fs.renameSync(oldP, newP);
  for (const table of PATH_TABLES) {
    try { db.prepare(`UPDATE ${table} SET path = ? WHERE path = ?`).run(newP, oldP); } catch {}
  }
});

app.post('/api/tags/:encodedPath', (req, res) => {
  let resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  const tags = (req.body.tags || []).map(t => t.trim().toLowerCase()).filter(Boolean);
  const wasHidden = resolved.startsWith(HIDDEN_DIR);
  const willBeHidden = tags.includes('hidden');

  if (!wasHidden && willBeHidden && fs.existsSync(resolved)) {
    const dest = path.join(HIDDEN_DIR, path.basename(resolved));
    moveVideoPath(resolved, dest);
    resolved = dest;
  } else if (wasHidden && !willBeHidden && fs.existsSync(resolved)) {
    const dest = path.join(IMPORT_DEST, path.basename(resolved));
    moveVideoPath(resolved, dest);
    resolved = dest;
  }

  db.transaction(() => {
    q.deleteTags.run(resolved);
    for (const tag of tags) q.insertTag.run(resolved, tag);
  })();
  res.json({ ok: true, path: resolved });
});

// --- API: Unlock ---
app.post('/api/unlock', (req, res) => {
  if (req.body.pin === AUTH_PIN) res.json({ ok: true });
  else res.status(401).json({ ok: false });
});

// --- API: Delete video ---
app.delete('/api/video/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');
  try {
    fs.unlinkSync(resolved);
    q.deleteVideo.run(resolved);
    q.deleteTags.run(resolved);
    q.deleteTranscript.run(resolved);
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.message); }
});

// --- YouTube OAuth routes ---
app.get('/auth/youtube', (_req, res) => {
  const auth = makeOAuth2();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
    ],
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const auth = makeOAuth2();
    const { tokens } = await auth.getToken(code);
    saveYTToken(tokens);
    res.send('<script>window.opener?.postMessage("yt-authed","*");window.close();</script>YouTube connected! You can close this tab.');
  } catch (e) {
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

app.get('/api/youtube/status', (_req, res) => {
  res.json({ connected: !!loadYTToken() });
});

// --- API: YouTube meta suggestion ---
app.get('/api/yt-meta/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  const row = q.getMeta.get(resolved);
  res.json(buildYTMeta(resolved, row));
});

// --- API: YouTube upload ---
const uploads = {};  // uploadId → { status, progress, url, error }

app.post('/api/upload/:encodedPath', async (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');

  const yt = getAuthenticatedYT();
  if (!yt) return res.status(401).json({ error: 'not_connected' });

  const { title, description, privacy = 'unlisted', channelId } = req.body;
  const uploadId = crypto.randomBytes(8).toString('hex');
  uploads[uploadId] = { status: 'uploading', progress: 0 };
  res.json({ uploadId });

  // YouTube rejects < and > in title/description
  const safeTitle = (title || 'Untitled').replace(/[<>]/g, '').slice(0, 100).trim() || 'Untitled';
  const safeDesc  = (description || '').replace(/[<>]/g, '').slice(0, 5000);

  const stat = fs.statSync(resolved);
  try {
    const response = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title: safeTitle, description: safeDesc, categoryId: '22' },
        status:  { privacyStatus: privacy },
      },
      media: {
        mimeType: 'video/*',
        body: fs.createReadStream(resolved),
      },
    }, {
      onUploadProgress: evt => {
        uploads[uploadId].progress = Math.round((evt.bytesRead / stat.size) * 100);
      },
    });
    const videoId = response.data.id;
    uploads[uploadId] = { status: 'done', progress: 100, url: `https://youtu.be/${videoId}` };
    q.insertYTUpload.run(resolved, videoId, channelId || null, new Date().toISOString());
    console.log(`Uploaded to YouTube: ${title} → https://youtu.be/${videoId}`);
    // Auto-add to any YouTube playlists linked to this video's tags
    const videoTags = q.getTags.all(resolved).map(r => r.tag);
    for (const tag of videoTags) {
      const link = q.getTagLink.get(tag);
      if (link) {
        try {
          await yt.playlistItems.insert({
            part: ['snippet'],
            requestBody: { snippet: { playlistId: link.playlist_id, resourceId: { kind: 'youtube#video', videoId } } },
          });
          q.addPlaylistItem.run(link.playlist_id, videoId);
          console.log(`Auto-added to playlist "${link.playlist_name}" (tag: ${tag})`);
        } catch (e) { console.error(`Auto-add to playlist failed (${tag}):`, e.message); }
      }
    }
  } catch (e) {
    uploads[uploadId] = { status: 'error', progress: 0, error: e.message };
    console.error('YouTube upload failed:', e.message);
  }
});

app.get('/api/upload-status/:uploadId', (req, res) => {
  const u = uploads[req.params.uploadId];
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(u);
});

// --- Codec detection ---
const codecCache = {};

function detectCodecAsync(fullPath) {
  return new Promise(resolve => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', fullPath],
      (err, stdout) => {
        if (err) return resolve('unknown');
        try {
          const stream = JSON.parse(stdout).streams.find(s => s.codec_type === 'video');
          resolve(stream ? stream.codec_name : 'unknown');
        } catch { resolve('unknown'); }
      });
  });
}

async function predetectCodecs() {
  const videos = VIDEO_DIRS.flatMap(scanVideos);
  const unseen = videos.filter(v => {
    const row = q.getMeta.get(v.fullPath);
    if (row?.codec) { codecCache[v.fullPath] = row.codec; return false; }
    return !(v.fullPath in codecCache);
  });
  for (let i = 0; i < unseen.length; i += 8) {
    await Promise.all(unseen.slice(i, i + 8).map(async v => {
      const codec = await detectCodecAsync(v.fullPath);
      codecCache[v.fullPath] = codec;
      q.setCodec.run(codec, v.fullPath);
    }));
  }
}

// --- Video streaming ---
app.get('/video/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');

  const codec = codecCache[resolved] ?? q.getMeta.get(resolved)?.codec ?? 'h264';

  // Only transcode HEVC for TV clients — desktop Chrome/Firefox support HEVC natively
  // and fake byte-range mapping breaks seeking on transcoded streams.
  const TV_UA = /SMART-TV|Tizen|WebOS|NetCast|NETTV|AppleTV|HbbTV|BRAVIA|Roku|DTV|Android.*TV|Television/i;
  const needsTranscode = codec === 'hevc' && TV_UA.test(req.headers['user-agent'] || '');

  if (needsTranscode) {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    const ff = spawn('ffmpeg', [
      '-i', resolved, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    ff.stdout.pipe(res);
    res.on('close', () => ff.kill());
    return;
  }

  const stat = fs.statSync(resolved);
  const fileSize = stat.size;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start, end;
    if (parts[0] === '') {
      const suffixLen = parseInt(parts[1], 10);
      start = Math.max(0, fileSize - suffixLen);
      end = fileSize - 1;
    } else {
      start = parseInt(parts[0], 10);
      end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(resolved, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(resolved).pipe(res);
  }
});

// --- Thumbnails ---
function thumbName(resolved) { return Buffer.from(resolved).toString('base64url') + '.jpg'; }

const thumbQueue = [];
let activeJobs = 0;
const MAX_JOBS = 4;

function runThumbJob(resolved, thumbPath) {
  return new Promise(resolve => {
    const row = q.getMeta.get(resolved);
    const duration = row?.duration;
    const seek = duration
      ? Math.min(Math.round(duration * 0.2), Math.max(0, Math.floor(duration) - 1))
      : 5;
    execFile('ffmpeg', ['-ss', String(seek), '-i', resolved, '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '4', thumbPath], resolve);
  });
}

function drainQueue() {
  while (activeJobs < MAX_JOBS && thumbQueue.length > 0) {
    const { resolved, thumbPath, resolve } = thumbQueue.shift();
    activeJobs++;
    runThumbJob(resolved, thumbPath).then(() => { activeJobs--; drainQueue(); resolve(); });
  }
}

function enqueueThumb(resolved, thumbPath, priority = false) {
  return new Promise(resolve => {
    const job = { resolved, thumbPath, resolve };
    if (priority) thumbQueue.unshift(job); else thumbQueue.push(job);
    drainQueue();
  });
}

app.get('/thumb/:encodedPath', async (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');
  const tPath = path.join(THUMB_DIR, thumbName(resolved));
  if (!fs.existsSync(tPath)) await enqueueThumb(resolved, tPath, true);
  if (!fs.existsSync(tPath)) return res.status(500).send('Thumb failed');
  res.sendFile(tPath);
});

// --- API: Transcription ---
app.get('/api/transcript/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  res.json(q.getTranscript.get(resolved) || { text: null, language: null, status: 'none' });
});

app.post('/api/transcript/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');
  const existing = q.getTranscript.get(resolved);
  if (existing?.status === 'pending' || existing?.status === 'processing') {
    return res.json({ queued: false, status: existing.status });
  }
  q.upsertTranscript.run(resolved, null, null, 'pending', new Date().toISOString());
  transcribeNext();
  res.json({ queued: true });
});

// --- Claude API / AI description ---
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

async function claudeChat(prompt) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response: ' + text);
  return JSON.parse(jsonMatch[0]);
}

let describing = false;

function describeNext() {
  if (describing) return;
  const row = q.nextDesc.get();
  if (!row) return;
  describing = true;
  q.upsertDesc.run(row.path, null, null, 'processing', new Date().toISOString());
  console.log(`Describing: ${path.basename(row.path)}`);

  const meta = q.getMeta.get(row.path);
  const tx   = db.prepare("SELECT text FROM transcriptions WHERE path=? AND status='done'").get(row.path);
  const date = parseDateFromVideo(row.path, meta?.mtime);
  const dayStr = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  // Only use transcript if it looks like real speech (not wind noise / TV in background).
  // Heuristics: at least 4 words, average word length reasonable, not suspiciously long for a short clip.
  function transcriptUsable(text, duration) {
    if (!text) return false;
    const words = text.trim().split(/\s+/);
    if (words.length < 4) return false;
    // If transcript is very long relative to duration it's probably TV/background audio
    const wordsPerSecond = words.length / (duration || 60);
    if (wordsPerSecond > 3) return false;
    const avgLen = words.join('').length / words.length;
    if (avgLen < 2 || avgLen > 12) return false;
    return true;
  }

  const useTx = tx?.text && transcriptUsable(tx.text, meta?.duration);
  const dur = meta?.duration ? Math.round(meta.duration) : null;
  const isShort = dur && dur < 30;

  const context = [
    meta?.location && `Location filmed: ${meta.location}`,
    `Date: ${dayStr} at ${timeStr}`,
    dur && `Duration: ${dur} seconds${isShort ? ' (short clip)' : ''}`,
    useTx && `What was said: "${tx.text.slice(0, 500)}"`,
  ].filter(Boolean).join('\n');

  const prompt = `You are writing titles and descriptions for someone's personal video collection (drone footage, family moments, travel clips).

Video info:
${context}

Write a natural, specific title and description for this video.

Rules:
- Title: 3-8 words, natural English, based on location and what happened. Examples: "Morning at Runcorn Park", "Kids at the Pool", "Sydney Harbour Drone Footage", "Birthday Lunch Brisbane"
- If there is no transcript or location, use the date and make a simple descriptive title
- Description: 1-3 sentences describing the moment naturally, as if writing a photo caption
- Do NOT mention file names, timestamps, or technical details
- Do NOT invent details not supported by the info above

Respond with JSON only: {"title": "...", "description": "..."}`;

  claudeChat(prompt)
    .then(({ title, description }) => {
      q.upsertDesc.run(row.path, title, description, 'done', new Date().toISOString());
      console.log(`Described: ${path.basename(row.path)} → "${title}"`);
    })
    .catch(e => {
      console.error(`Describe failed for ${path.basename(row.path)}:`, e.message);
      q.upsertDesc.run(row.path, null, null, 'error', new Date().toISOString());
    })
    .finally(() => { describing = false; describeNext(); });
}

// --- YouTube sync worker ---
// --- SD card import ---
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv']);

let sdState = {
  detected: false, sdPath: null,
  newFiles: [],    // [{name, src, size}] files on card not yet on laptop
  importing: false, done: 0, total: 0, current: '',
  copied: [],      // src paths successfully copied (ready to delete)
  errors: [],
  syncing: false,  // true while rclone upload is running
};

function scanSdCard() {
  syncSdToVideoDirs();
  const sdPath = findSdPath();
  if (!sdPath) { sdState.detected = false; sdState.sdPath = null; sdState.newFiles = []; return; }

  // Build set of filenames already on laptop (all non-SD dirs)
  const localDirs = VIDEO_DIRS.filter(d => !d.startsWith('/media/'));
  const existing  = new Set();
  for (const dir of localDirs) {
    if (!fs.existsSync(dir)) continue;
    (function walk(d) {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(path.join(d, f.name));
        else if (VIDEO_EXTS.has(path.extname(f.name).toLowerCase())) existing.add(f.name);
      }
    })(dir);
  }

  // Find new files on card
  const newFiles = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name));
      else if (VIDEO_EXTS.has(path.extname(f.name).toLowerCase()) && !existing.has(f.name)) {
        const src = path.join(d, f.name);
        newFiles.push({ name: f.name, src, size: fs.statSync(src).size });
      }
    }
  })(sdPath);

  sdState.detected = true;
  sdState.sdPath   = sdPath;
  sdState.newFiles = newFiles;
}

async function runImport() {
  if (sdState.importing || !sdState.detected) return;
  sdState.importing = true;
  sdState.done      = 0;
  sdState.total     = sdState.newFiles.length;
  sdState.copied    = [];
  sdState.errors    = [];

  for (const file of sdState.newFiles) {
    sdState.current = file.name;
    const dest = path.join(IMPORT_DEST, file.name);
    try {
      await fs.promises.copyFile(file.src, dest);
      const destSize = fs.statSync(dest).size;
      if (destSize !== file.size) throw new Error(`size mismatch (${destSize} vs ${file.size})`);
      sdState.copied.push(file.src);
    } catch (e) {
      sdState.errors.push({ name: file.name, error: e.message });
    }
    sdState.done++;
  }

  sdState.importing = false;
  sdState.current   = '';
  scanSdCard(); // refresh new-file count
  // Drive sync is no longer triggered automatically — push to Drive is per-file
  // via the upload button, and bulk archiving is handled by /api/archive/*.
}

app.get('/api/sdcard', (_req, res) => {
  scanSdCard();
  res.json({
    detected:  sdState.detected,
    sdPath:    sdState.sdPath,
    newFiles:  sdState.newFiles.length,
    newList:   sdState.newFiles.map(f => ({ name: f.name, size: f.size })),
    importing: sdState.importing,
    done:      sdState.done,
    total:     sdState.total,
    current:   sdState.current,
    copied:    sdState.copied.length,
    errors:    sdState.errors,
    syncing:   sdState.syncing,
  });
});

app.post('/api/sdcard/import', (_req, res) => {
  if (!sdState.detected)  return res.status(400).json({ error: 'No SD card detected' });
  if (sdState.importing)  return res.status(400).json({ error: 'Already importing' });
  if (!sdState.newFiles.length) return res.status(400).json({ error: 'No new files' });
  runImport();
  res.json({ ok: true, total: sdState.newFiles.length });
});

app.post('/api/sdcard/delete', (_req, res) => {
  if (sdState.importing) return res.status(400).json({ error: 'Import still running' });
  const toDelete = [...sdState.copied];
  let deleted = 0, failed = 0;
  for (const src of toDelete) {
    try { fs.unlinkSync(src); deleted++; }
    catch { failed++; }
  }
  sdState.copied = [];
  res.json({ deleted, failed });
});

// --- Google Drive index ---
const GDRIVE_REMOTE = 'gdrive:DJI-footage';

const driveQ = {
  upsert: db.prepare('INSERT OR REPLACE INTO drive_files (filename, size, synced_at) VALUES (?, ?, ?)'),
  all:    db.prepare('SELECT filename, size FROM drive_files'),
  has:    db.prepare('SELECT 1 FROM drive_files WHERE filename = ?'),
  clear:  db.prepare('DELETE FROM drive_files'),
};

async function refreshDriveIndex() {
  return new Promise((resolve, reject) => {
    execFile('rclone', ['lsjson', GDRIVE_REMOTE, '--recursive', '--files-only'], (err, stdout) => {
      if (err && !err.message?.includes('directory not found')) return reject(err);
      if (err) return resolve(0); // folder not created yet
      try {
        const files = JSON.parse(stdout || '[]');
        const now   = new Date().toISOString();
        const insert = db.transaction(() => {
          driveQ.clear.run();
          for (const f of files) driveQ.upsert.run(f.Name, f.Size, now);
        });
        insert();
        console.log(`Drive index refreshed: ${files.length} files`);
        resolve(files.length);
      } catch (e) { reject(e); }
    });
  });
}

app.post('/api/drive/refresh', async (_req, res) => {
  try { const n = await refreshDriveIndex(); res.json({ ok: true, files: n }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/drive/index', (_req, res) => {
  const files = driveQ.all.all();
  res.json(files); // [{filename, size}]
});

app.post('/api/drive/upload', (req, res) => {
  const filePath = req.body.path ? decodeURIComponent(req.body.path) : null;
  if (!filePath || !fs.existsSync(filePath)) {
    console.log(`Drive upload rejected: file not found — ${filePath}`);
    return res.status(400).json({ error: 'File not found' });
  }
  if (!VIDEO_DIRS.some(d => filePath.startsWith(path.resolve(d)))) {
    console.log(`Drive upload rejected: forbidden — ${filePath}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  const filename = path.basename(filePath);
  console.log(`Drive upload starting: ${filename}`);
  res.json({ ok: true, filename });
  const child = spawn('rclone', ['copy', filePath, GDRIVE_REMOTE, '--transfers=4'], { stdio: 'pipe' });
  let rcloneErr = '';
  child.stderr.on('data', d => { rcloneErr += d.toString(); });
  child.on('close', async code => {
    if (code === 0) {
      try { await refreshDriveIndex(); } catch {}
      console.log(`Drive upload done: ${filename}`);
    } else {
      console.error(`Drive upload failed: ${filename} (code ${code}) — ${rcloneErr.slice(0, 200)}`);
    }
  });
});

app.delete('/api/drive/local', (req, res) => {
  const filePath = req.body.path ? decodeURIComponent(req.body.path) : null;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'File not found' });
  if (!VIDEO_DIRS.some(d => filePath.startsWith(path.resolve(d)))) return res.status(403).json({ error: 'Forbidden' });
  const filename = path.basename(filePath);
  if (!driveQ.has.get(filename)) return res.status(400).json({ error: 'Not confirmed on Drive — refusing to delete' });
  fs.unlinkSync(filePath);
  // Remove from DB metadata
  db.prepare('DELETE FROM video_meta WHERE path = ?').run(filePath);
  db.prepare('DELETE FROM tags WHERE path = ?').run(filePath);
  res.json({ ok: true });
});

// --- Archive: bulk-delete old local files that are safely on Drive ---
function listArchiveCandidates(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const videos = VIDEO_DIRS.flatMap(scanVideos);
  const seen = new Set();
  const unique = videos.filter(v => {
    const key = v.name + v.size;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const hiddenSet     = new Set(db.prepare("SELECT path FROM tags WHERE tag = 'hidden'").all().map(r => r.path));
  const projectClipSet = new Set(db.prepare('SELECT path FROM edit_project_clips').all().map(r => r.path));

  return unique
    .filter(v => {
      const date = parseDateFromVideo(v.fullPath, v.mtime).getTime();
      if (date > cutoff) return false;
      if (!driveQ.has.get(v.name)) return false;
      if (hiddenSet.has(v.fullPath)) return false;
      if (projectClipSet.has(v.fullPath)) return false;
      return true;
    })
    .map(v => ({
      path: v.fullPath,
      name: v.name,
      size: v.size,
      date: parseDateFromVideo(v.fullPath, v.mtime).toISOString(),
    }))
    .sort((a, b) => a.date.localeCompare(b.date)); // oldest first
}

app.get('/api/archive/candidates', (req, res) => {
  const days = Math.max(1, parseInt(req.query.days || '60', 10));
  const candidates = listArchiveCandidates(days);
  const totalSize = candidates.reduce((s, c) => s + c.size, 0);
  res.json({ days, candidates, totalSize });
});

app.post('/api/archive/run', (req, res) => {
  const { paths } = req.body;
  if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'paths array required' });

  let deleted = 0, failed = 0, freedBytes = 0;
  const errors = [];

  for (const filePath of paths) {
    try {
      if (!VIDEO_DIRS.some(d => filePath.startsWith(path.resolve(d)))) throw new Error('Forbidden path');
      if (!fs.existsSync(filePath)) throw new Error('Not found');
      const filename = path.basename(filePath);
      if (!driveQ.has.get(filename)) throw new Error('Not on Drive');
      if (db.prepare("SELECT 1 FROM tags WHERE path=? AND tag='hidden'").get(filePath)) throw new Error('Hidden');
      if (db.prepare('SELECT 1 FROM edit_project_clips WHERE path=?').get(filePath)) throw new Error('In active project');

      const size = fs.statSync(filePath).size;
      fs.unlinkSync(filePath);
      db.prepare('DELETE FROM video_meta WHERE path=?').run(filePath);
      db.prepare('DELETE FROM tags WHERE path=?').run(filePath);
      deleted++;
      freedBytes += size;
    } catch (e) {
      failed++;
      errors.push({ path: filePath, error: e.message });
    }
  }
  res.json({ deleted, failed, freedBytes, errors });
});

let syncing = false;

async function syncNext() {
  if (syncing) return;
  const yt = getAuthenticatedYT();
  if (!yt) return;
  const row = q.nextSyncItem.get();
  if (!row) return;
  syncing = true;
  q.updateSyncItem.run('processing', null, null, row.id);

  try {
    // If already uploaded, skip straight to adding to playlist
    const existing = db.prepare('SELECT video_id FROM yt_uploads WHERE path=? LIMIT 1').get(row.path);
    let videoId = existing?.video_id;

    if (!videoId) {
      if (!fs.existsSync(row.path)) throw new Error('File not found: ' + row.path);
      const desc = q.getDesc.get(row.path);
      const safeTitle = ((desc?.title || path.basename(row.path)).replace(/[<>]/g, '')).slice(0, 100).trim() || 'Untitled';
      const safeDesc  = (desc?.description || '').replace(/[<>]/g, '').slice(0, 5000);
      const response  = await yt.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: { title: safeTitle, description: safeDesc, categoryId: '22' },
          status:  { privacyStatus: 'unlisted' },
        },
        media: { mimeType: 'video/*', body: fs.createReadStream(row.path) },
      });
      videoId = response.data.id;
      q.insertYTUpload.run(row.path, videoId, null, new Date().toISOString());
      console.log(`Sync-uploaded: ${path.basename(row.path)} → ${videoId}`);
    }

    // Add to playlist (ignore "already in playlist" errors)
    try {
      await yt.playlistItems.insert({
        part: ['snippet'],
        requestBody: { snippet: { playlistId: row.playlist_id, resourceId: { kind: 'youtube#video', videoId } } },
      });
      q.addPlaylistItem.run(row.playlist_id, videoId);
    } catch (e) {
      if (!e.message?.includes('duplicate') && !e.message?.includes('already')) throw e;
    }

    q.updateSyncItem.run('done', videoId, null, row.id);
    console.log(`Sync done: ${path.basename(row.path)}`);
  } catch (e) {
    q.updateSyncItem.run('error', null, e.message?.slice(0, 500), row.id);
    console.error(`Sync failed for ${path.basename(row.path)}:`, e.message);
  }
  syncing = false;
  syncNext();
}

// --- API: Descriptions ---
app.get('/api/describe/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  res.json(q.getDesc.get(resolved) || { title: null, description: null, status: 'none' });
});

app.post('/api/describe/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');
  const existing = q.getDesc.get(resolved);
  if (existing?.status === 'pending' || existing?.status === 'processing') return res.json({ queued: false, status: existing.status });
  q.upsertDesc.run(resolved, null, null, 'pending', new Date().toISOString());
  describeNext();
  res.json({ queued: true });
});

app.post('/api/describe-all', (req, res) => {
  const videos = VIDEO_DIRS.flatMap(scanVideos);
  const seen = new Set();
  const unique = videos.filter(v => { const k = v.name + v.size; if (seen.has(k)) return false; seen.add(k); return true; });
  let queued = 0;
  for (const v of unique) {
    const existing = q.getDesc.get(v.fullPath);
    if (!existing || existing.status === 'error') {
      q.upsertDesc.run(v.fullPath, null, null, 'pending', new Date().toISOString());
      queued++;
    }
  }
  describeNext();
  res.json({ queued, total: unique.length });
});

app.get('/api/describe-progress', (_req, res) => {
  const pending    = db.prepare("SELECT COUNT(*) as n FROM descriptions WHERE status='pending'").get().n;
  const processing = db.prepare("SELECT COUNT(*) as n FROM descriptions WHERE status='processing'").get().n;
  const done       = db.prepare("SELECT COUNT(*) as n FROM descriptions WHERE status='done'").get().n;
  res.json({ pending, processing, done });
});

app.put('/api/describe/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  const { title, description } = req.body;
  q.upsertDesc.run(resolved, title || null, description || null, 'done', new Date().toISOString());
  res.json({ ok: true });
});

// --- API: Playlists ---
app.get('/api/playlists', (_req, res) => {
  const playlists = q.allPlaylists.all().map(pl => ({
    ...pl,
    videos: q.playlistVideos.all(pl.id).map(r => r.path),
  }));
  res.json(playlists);
});

app.post('/api/playlists', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).send('Name required');
  const info = q.insertPlaylist.run(name, new Date().toISOString());
  res.json({ id: info.lastInsertRowid, name });
});

app.delete('/api/playlists/:id', (req, res) => {
  q.deletePlaylist.run(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/playlists/:id/videos', (req, res) => {
  const id = parseInt(req.params.id);
  const resolved = path.resolve(decodeURIComponent(req.body.path || ''));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  const count = q.playlistVideos.all(id).length;
  q.addToPlaylist.run(id, resolved, count);
  res.json({ ok: true });
});

app.delete('/api/playlists/:id/videos/:encodedPath', (req, res) => {
  const id = parseInt(req.params.id);
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  q.removeFromPlaylist.run(id, resolved);
  res.json({ ok: true });
});

// Suggest playlists by clustering videos with same location within 7 days of each other
app.post('/api/playlists/suggest', (_req, res) => {
  const videos = db.prepare(`
    SELECT vm.path, vm.name, vm.mtime, vm.location
    FROM video_meta vm
    WHERE vm.location IS NOT NULL
    ORDER BY vm.location, vm.mtime
  `).all();

  const clusters = [];
  let current = null;

  for (const v of videos) {
    const date = new Date(v.mtime);
    if (!current || current.location !== v.location || (date - current.lastDate) > 7 * 24 * 3600 * 1000) {
      if (current) clusters.push(current);
      current = { location: v.location, firstDate: date, lastDate: date, videos: [v] };
    } else {
      current.lastDate = date;
      current.videos.push(v);
    }
  }
  if (current) clusters.push(current);

  // Name each cluster: "Location - Month Year"
  const suggestions = clusters
    .filter(c => c.videos.length >= 2)
    .map(c => ({
      name: `${c.location} · ${c.firstDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`,
      videos: c.videos.map(v => encodeURIComponent(v.path)),
      count: c.videos.length,
    }));

  res.json(suggestions);
});

// --- API: Edit Projects ---

app.get('/api/projects', (_req, res) => {
  const projects = q.allProjects.all().map(p => ({
    ...p,
    clips: q.projectClips.all(p.id),
  }));
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const { name, storyline, project_type, gpx_path, garmin_gpx_path } = req.body;
  if (!name) return res.status(400).send('Name required');
  const now = new Date().toISOString();
  const info = q.insertProject.run(name, storyline || null, project_type || null, gpx_path || null, garmin_gpx_path || null, now, now);
  res.json({ id: info.lastInsertRowid, name, storyline: storyline || null, project_type: project_type || null, gpx_path: gpx_path || null, garmin_gpx_path: garmin_gpx_path || null, clips: [], created_at: now, updated_at: now });
});

app.put('/api/projects/:id', (req, res) => {
  const { name, storyline, project_type, gpx_path, garmin_gpx_path } = req.body;
  const cur = db.prepare('SELECT * FROM edit_projects WHERE id=?').get(parseInt(req.params.id));
  if (!cur) return res.status(404).send('Not found');
  q.updateProject.run(name, storyline || null, project_type ?? cur.project_type, gpx_path ?? cur.gpx_path, garmin_gpx_path ?? cur.garmin_gpx_path, new Date().toISOString(), parseInt(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  q.deleteProject.run(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/projects/:id/clips', (req, res) => {
  const projectId = parseInt(req.params.id);
  const resolved = path.resolve(decodeURIComponent(req.body.path || ''));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  const clips = q.projectClips.all(projectId);
  const meta = q.getMeta.get(resolved);
  const duration = meta?.duration || null;
  q.insertClip.run(projectId, resolved, clips.length, 0, duration);
  const all = q.projectClips.all(projectId);
  res.json(all);
});

app.put('/api/projects/:id/clips/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).send('order must be array');
  db.transaction(() => { order.forEach((clipId, i) => q.reorderClips.run(i, clipId)); })();
  res.json({ ok: true });
});

app.put('/api/projects/:id/clips/:clipId', (req, res) => {
  const { trim_in, trim_out, note, position } = req.body;
  const clip = db.prepare('SELECT * FROM edit_project_clips WHERE id=?').get(parseInt(req.params.clipId));
  if (!clip || clip.project_id !== parseInt(req.params.id)) return res.status(404).send('Not found');
  q.updateClip.run(
    position ?? clip.position,
    trim_in  ?? clip.trim_in,
    trim_out !== undefined ? trim_out : clip.trim_out,
    note     !== undefined ? note     : clip.note,
    clip.id
  );
  res.json({ ok: true });
});

app.delete('/api/projects/:id/clips/:clipId', (req, res) => {
  q.deleteClip.run(parseInt(req.params.clipId));
  res.json({ ok: true });
});

// --- API: GPX overlay for a single video (player HUD) ---
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function parseGpxFull(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const points = [];
  const trkptRe = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  let m, cumDist = 0;
  while ((m = trkptRe.exec(xml)) !== null) {
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]), inner = m[3];
    const timeM = /<time>([^<]+)<\/time>/.exec(inner);
    const eleM  = /<ele>([^<]+)<\/ele>/.exec(inner);
    const hrM    = /<(?:gpxtpx:hr|ns3:hr|hr)>([^<]+)<\/(?:gpxtpx:hr|ns3:hr|hr)>/.exec(inner);
    const cadM   = /<(?:gpxtpx:cad|ns3:cad|cad)>([^<]+)<\/(?:gpxtpx:cad|ns3:cad|cad)>/.exec(inner);
    const atempM = /<(?:gpxtpx:atemp|ns3:atemp|atemp)>([^<]+)<\/(?:gpxtpx:atemp|ns3:atemp|atemp)>/.exec(inner);
    if (points.length > 0) {
      const prev = points[points.length - 1];
      cumDist += haversineM(prev.lat, prev.lon, lat, lon);
    }
    points.push({
      lat, lon,
      t:     timeM  ? new Date(timeM[1]).getTime() : null,
      ele:   eleM   ? parseFloat(eleM[1])   : null,
      hr:    hrM    ? parseInt(hrM[1])       : null,
      cad:   cadM   ? parseInt(cadM[1])      : null,
      atemp: atempM ? parseFloat(atempM[1])  : null,
      dist:  cumDist,
    });
  }
  return points;
}

app.get('/api/player/gpx-overlay/:encodedPath', (req, res) => {
  const clipPath = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => clipPath.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');

  // Find a run project that contains this clip and has a GPX file
  const projects = q.allProjects.all();
  let gpxFilePath = null, clipStartUtc = null, clipDurationS = null, projMaxHr = null, projRestHr = null;

  for (const proj of projects) {
    const clips = q.projectClips.all(proj.id);
    const clip = clips.find(c => path.resolve(c.path) === clipPath);
    if (!clip) continue;
    // Prefer Garmin (has temperature + more precise data) over Strava
    if (proj.garmin_gpx_path && fs.existsSync(proj.garmin_gpx_path)) gpxFilePath = proj.garmin_gpx_path;
    else if (proj.gpx_path && fs.existsSync(proj.gpx_path)) gpxFilePath = proj.gpx_path;
    if (!gpxFilePath) continue;
    projMaxHr = proj.max_hr || null;
    projRestHr = proj.rest_hr || null;
    // Parse clip start from DJI filename (Brisbane = UTC+10)
    const fname = path.basename(clipPath);
    const fm = /DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(fname);
    if (fm) {
      clipStartUtc = Date.UTC(+fm[1], +fm[2]-1, +fm[3], +fm[4]-10, +fm[5], +fm[6]);
      const meta = q.getMeta.get(clipPath);
      clipDurationS = meta?.duration || null;
    }
    break;
  }

  if (!gpxFilePath) return res.json(null);
  if (!clipStartUtc) return res.json(null);

  try {
    const allPoints = parseGpxFull(gpxFilePath);
    if (!allPoints.length) return res.json(null);

    // Clip window: start to end (with 30s padding each side for smooth transitions)
    const padMs = 30000;
    const clipEndUtc = clipStartUtc + (clipDurationS || 600) * 1000;
    const pts = allPoints.filter(p => p.t >= clipStartUtc - padMs && p.t <= clipEndUtc + padMs);

    // Route bounds for mini-map (use all points for context)
    const lats = allPoints.map(p => p.lat), lons = allPoints.map(p => p.lon);
    const routeBounds = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };

    // Thin full route to ~600 pts for mini-map polyline
    const step = Math.max(1, Math.floor(allPoints.length / 600));
    const routeLine = allPoints.filter((_, i) => i % step === 0).map(p => [p.lat, p.lon]);

    const runStartUtc = allPoints[0].t;
    res.json({ clipStartUtc, pts, routeBounds, routeLine, totalDist: allPoints[allPoints.length-1].dist, maxHr: projMaxHr, restHr: projRestHr, runStartUtc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API: GPX data for project ---
app.get('/api/projects/:id/gpx', (req, res) => {
  const project = db.prepare('SELECT * FROM edit_projects WHERE id=?').get(parseInt(req.params.id));
  if (!project) return res.status(404).send('Not found');
  if (!project.gpx_path) return res.json(null);
  if (!fs.existsSync(project.gpx_path)) return res.status(404).json({ error: 'GPX file not found: ' + project.gpx_path });

  try {
    const xml = fs.readFileSync(project.gpx_path, 'utf8');
    // Parse trkpt elements
    const points = [];
    const trkptRe = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
    let m;
    while ((m = trkptRe.exec(xml)) !== null) {
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      const inner = m[3];
      const timeM = /<time>([^<]+)<\/time>/.exec(inner);
      const eleM  = /<ele>([^<]+)<\/ele>/.exec(inner);
      const hrM   = /<(?:gpxtpx:hr|ns3:hr|hr)>([^<]+)<\/(?:gpxtpx:hr|ns3:hr|hr)>/.exec(inner);
      const cadM  = /<(?:gpxtpx:cad|ns3:cad|cad)>([^<]+)<\/(?:gpxtpx:cad|ns3:cad|cad)>/.exec(inner);
      points.push({
        lat, lon,
        t:   timeM ? new Date(timeM[1]).getTime() : null,
        ele: eleM  ? parseFloat(eleM[1])  : null,
        hr:  hrM   ? parseInt(hrM[1])     : null,
        cad: cadM  ? parseInt(cadM[1])    : null,
      });
    }
    // Thin to max ~2000 points for the frontend (keep every Nth)
    const step = Math.max(1, Math.floor(points.length / 2000));
    const thinned = points.filter((_, i) => i % step === 0);

    // Build clip segments: for each project clip, find which point range covers it
    const clips = q.projectClips.all(project.id);
    const segments = clips.map(clip => {
      // DJI filename encodes local time: DJI_YYYYMMDDHHMMSS_...
      const fname = path.basename(clip.path);
      const fm = /DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(fname);
      if (!fm) return null;
      // Brisbane = UTC+10
      const clipStartUtc = Date.UTC(+fm[1], +fm[2]-1, +fm[3], +fm[4]-10, +fm[5], +fm[6]);
      const duration = (clip.trim_out || 0) - (clip.trim_in || 0);
      const clipEndUtc = clipStartUtc + (duration > 0 ? duration : 600) * 1000;
      const startIdx = thinned.findIndex(p => p.t >= clipStartUtc);
      let endIdx = thinned.findIndex(p => p.t > clipEndUtc);
      if (endIdx === -1) endIdx = thinned.length;
      return { clip_id: clip.id, path: clip.path, startIdx, endIdx };
    }).filter(Boolean);

    res.json({ points: thinned, segments, total: points.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/projects/:id/gpx', (req, res) => {
  const { gpx_path, garmin_gpx_path } = req.body;
  if (gpx_path && !fs.existsSync(gpx_path)) return res.status(400).json({ error: 'Strava GPX file not found' });
  if (garmin_gpx_path && !fs.existsSync(garmin_gpx_path)) return res.status(400).json({ error: 'Garmin GPX file not found' });
  const cur = db.prepare('SELECT * FROM edit_projects WHERE id=?').get(parseInt(req.params.id));
  if (!cur) return res.status(404).send('Not found');
  db.prepare('UPDATE edit_projects SET gpx_path=?, garmin_gpx_path=?, updated_at=? WHERE id=?').run(
    gpx_path !== undefined ? gpx_path || null : cur.gpx_path,
    garmin_gpx_path !== undefined ? garmin_gpx_path || null : cur.garmin_gpx_path,
    new Date().toISOString(), parseInt(req.params.id)
  );
  res.json({ ok: true });
});

// --- API: Export to Kdenlive ---

function xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toTC(seconds) {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sf = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${(sf < 10 ? '0' : '') + sf.toFixed(3)}`;
}

function generateMLT(project, clips, { arrangeTimeline = true } = {}) {
  const FPS = 30;
  const seqUuid  = `{${crypto.randomUUID()}}`;
  const docId    = Date.now().toString();
  const lines    = [];

  const clipMeta = clips.map((clip, i) => {
    const meta    = q.getMeta.get(clip.path);
    const fullDur = meta?.duration || clip.trim_out || 60;
    const trimIn  = clip.trim_in  || 0;
    const trimOut = clip.trim_out != null ? clip.trim_out : fullDur;
    const frames  = Math.ceil(fullDur * FPS);
    const uuid    = `{${crypto.randomUUID()}}`;
    const clipId  = i + 10;
    return { clip, i, fullDur, trimIn, trimOut, frames, uuid, clipId };
  });

  const seqDur = arrangeTimeline
    ? clipMeta.reduce((s, { trimIn, trimOut }) => s + (trimOut - trimIn), 0)
    : 0;

  lines.push(`<?xml version='1.0' encoding='utf-8'?>`);
  lines.push(`<mlt LC_NUMERIC="C" version="7.34.1" title="${xmlEsc(project.name)}" producer="main_bin">`);
  lines.push(` <profile description="HD 1080p 30fps" width="1920" height="1080" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="${FPS}" frame_rate_den="1" colorspace="709"/>`);

  // Black generator (producer, not chain)
  lines.push(` <producer id="black_track" in="00:00:00.000" out="23:59:59.000">`);
  lines.push(`  <property name="length">2147483647</property>`);
  lines.push(`  <property name="eof">continue</property>`);
  lines.push(`  <property name="resource">black</property>`);
  lines.push(`  <property name="aspect_ratio">1</property>`);
  lines.push(`  <property name="mlt_service">color</property>`);
  lines.push(`  <property name="kdenlive:playlistid">black_track</property>`);
  lines.push(`  <property name="mlt_image_format">rgba</property>`);
  lines.push(`  <property name="set.test_audio">0</property>`);
  lines.push(` </producer>`);

  // Audio playlists for the sequence's audio track
  lines.push(` <playlist id="audio_pl0"><property name="kdenlive:audio_track">1</property></playlist>`);
  lines.push(` <playlist id="audio_pl1"><property name="kdenlive:audio_track">1</property></playlist>`);

  // Audio tractor
  lines.push(` <tractor id="audio_tractor" in="00:00:00.000" out="${toTC(seqDur)}">`);
  lines.push(`  <property name="kdenlive:audio_track">1</property>`);
  lines.push(`  <property name="kdenlive:trackheight">69</property>`);
  lines.push(`  <property name="kdenlive:timeline_active">1</property>`);
  lines.push(`  <property name="kdenlive:collapsed">0</property>`);
  lines.push(`  <track hide="video" producer="audio_pl0"/>`);
  lines.push(`  <track hide="video" producer="audio_pl1"/>`);
  lines.push(` </tractor>`);

  // Chains for clips (audio copies — used in the audio playlist)
  clipMeta.forEach(({ clip, i, fullDur, frames, uuid, clipId }) => {
    lines.push(` <chain id="achain${i}" out="${toTC(fullDur)}">`);
    lines.push(`  <property name="length">${frames}</property>`);
    lines.push(`  <property name="eof">pause</property>`);
    lines.push(`  <property name="resource">${xmlEsc(clip.path)}</property>`);
    lines.push(`  <property name="mlt_service">avformat-novalidate</property>`);
    lines.push(`  <property name="seekable">1</property>`);
    lines.push(`  <property name="audio_index">1</property>`);
    lines.push(`  <property name="video_index">0</property>`);
    lines.push(`  <property name="kdenlive:folderid">-1</property>`);
    lines.push(`  <property name="kdenlive:id">${clipId}</property>`);
    lines.push(`  <property name="kdenlive:control_uuid">${uuid}</property>`);
    lines.push(`  <property name="kdenlive:clip_type">0</property>`);
    lines.push(`  <property name="mute_on_pause">0</property>`);
    lines.push(`  <property name="kdenlive:clipname">${xmlEsc(path.basename(clip.path))}</property>`);
    lines.push(` </chain>`);
  });

  // Audio content playlist
  lines.push(` <playlist id="audio_content_pl">`);
  lines.push(`  <property name="kdenlive:audio_track">1</property>`);
  if (arrangeTimeline) {
    clipMeta.forEach(({ i, clipId, trimIn, trimOut }) => {
      lines.push(`  <entry in="${toTC(trimIn)}" out="${toTC(trimOut)}" producer="achain${i}">`);
      lines.push(`   <property name="kdenlive:id">${clipId}</property>`);
      lines.push(`  </entry>`);
    });
  }
  lines.push(` </playlist>`);
  lines.push(` <playlist id="audio_content_pl2"><property name="kdenlive:audio_track">1</property></playlist>`);

  // Audio content tractor
  lines.push(` <tractor id="audio_content_tractor" in="00:00:00.000" out="${toTC(seqDur)}">`);
  lines.push(`  <property name="kdenlive:audio_track">1</property>`);
  lines.push(`  <property name="kdenlive:trackheight">69</property>`);
  lines.push(`  <property name="kdenlive:timeline_active">1</property>`);
  lines.push(`  <property name="kdenlive:collapsed">0</property>`);
  lines.push(`  <track hide="video" producer="audio_content_pl"/>`);
  lines.push(`  <track hide="video" producer="audio_content_pl2"/>`);
  lines.push(` </tractor>`);

  // Chains for clips (video copies — used in video playlist + main_bin)
  const vchainUuids = clipMeta.map(() => `{${crypto.randomUUID()}}`);
  clipMeta.forEach(({ clip, i, fullDur, frames, clipId }, idx) => {
    lines.push(` <chain id="vchain${i}" out="${toTC(fullDur)}">`);
    lines.push(`  <property name="length">${frames}</property>`);
    lines.push(`  <property name="eof">pause</property>`);
    lines.push(`  <property name="resource">${xmlEsc(clip.path)}</property>`);
    lines.push(`  <property name="mlt_service">avformat-novalidate</property>`);
    lines.push(`  <property name="seekable">1</property>`);
    lines.push(`  <property name="audio_index">1</property>`);
    lines.push(`  <property name="video_index">0</property>`);
    lines.push(`  <property name="kdenlive:folderid">-1</property>`);
    lines.push(`  <property name="kdenlive:id">${clipId}</property>`);
    lines.push(`  <property name="kdenlive:control_uuid">${vchainUuids[idx]}</property>`);
    lines.push(`  <property name="kdenlive:clip_type">0</property>`);
    lines.push(`  <property name="mute_on_pause">0</property>`);
    lines.push(`  <property name="kdenlive:clipname">${xmlEsc(path.basename(clip.path))}</property>`);
    lines.push(` </chain>`);
  });

  // Video content playlist
  lines.push(` <playlist id="video_content_pl">`);
  if (arrangeTimeline) {
    clipMeta.forEach(({ i, clipId, trimIn, trimOut }) => {
      lines.push(`  <entry in="${toTC(trimIn)}" out="${toTC(trimOut)}" producer="vchain${i}">`);
      lines.push(`   <property name="kdenlive:id">${clipId}</property>`);
      lines.push(`  </entry>`);
    });
  }
  lines.push(` </playlist>`);
  lines.push(` <playlist id="video_content_pl2"/>`);

  // Video tractor
  lines.push(` <tractor id="video_tractor" in="00:00:00.000" out="${toTC(seqDur)}">`);
  lines.push(`  <property name="kdenlive:trackheight">69</property>`);
  lines.push(`  <property name="kdenlive:timeline_active">1</property>`);
  lines.push(`  <property name="kdenlive:collapsed">0</property>`);
  lines.push(`  <track hide="audio" producer="video_content_pl"/>`);
  lines.push(`  <track hide="audio" producer="video_content_pl2"/>`);
  lines.push(` </tractor>`);

  // Sequence tractor (UUID id)
  lines.push(` <tractor id="${seqUuid}" in="00:00:00.000" out="${toTC(seqDur)}">`);
  lines.push(`  <property name="kdenlive:uuid">${seqUuid}</property>`);
  lines.push(`  <property name="kdenlive:clipname">${xmlEsc(project.name)}</property>`);
  lines.push(`  <property name="kdenlive:id">1</property>`);
  lines.push(`  <property name="kdenlive:folderid">2</property>`);
  lines.push(`  <property name="kdenlive:clip_type">0</property>`);
  lines.push(`  <property name="kdenlive:producer_type">17</property>`);
  lines.push(`  <property name="kdenlive:duration">${toTC(seqDur)}</property>`);
  lines.push(`  <property name="kdenlive:maxduration">${Math.ceil(seqDur * FPS)}</property>`);
  lines.push(`  <property name="kdenlive:control_uuid">${seqUuid}</property>`);
  lines.push(`  <property name="kdenlive:file_size">0</property>`);
  lines.push(`  <property name="kdenlive:sequenceproperties.hasAudio">1</property>`);
  lines.push(`  <property name="kdenlive:sequenceproperties.hasVideo">1</property>`);
  lines.push(`  <property name="kdenlive:sequenceproperties.activeTrack">1</property>`);
  lines.push(`  <property name="kdenlive:sequenceproperties.tracksCount">4</property>`);
  lines.push(`  <property name="kdenlive:sequenceproperties.documentuuid">${seqUuid}</property>`);
  lines.push(`  <property name="kdenlive:sequenceproperties.groups">[]</property>`);
  lines.push(`  <property name="kdenlive:sequenceproperties.guides">[]</property>`);
  lines.push(`  <multitrack>`);
  lines.push(`   <track producer="black_track"/>`);
  lines.push(`   <track producer="audio_tractor"/>`);
  lines.push(`   <track producer="audio_content_tractor"/>`);
  lines.push(`   <track producer="video_tractor"/>`);
  lines.push(`  </multitrack>`);
  lines.push(` </tractor>`);

  // Bin chains (third set — these are what appear in the Project Bin)
  const bchainUuids = clipMeta.map(() => `{${crypto.randomUUID()}}`);
  clipMeta.forEach(({ clip, i, fullDur, frames, clipId }, idx) => {
    lines.push(` <chain id="bchain${i}" out="${toTC(fullDur)}">`);
    lines.push(`  <property name="length">${frames}</property>`);
    lines.push(`  <property name="eof">pause</property>`);
    lines.push(`  <property name="resource">${xmlEsc(clip.path)}</property>`);
    lines.push(`  <property name="mlt_service">avformat-novalidate</property>`);
    lines.push(`  <property name="seekable">1</property>`);
    lines.push(`  <property name="audio_index">1</property>`);
    lines.push(`  <property name="video_index">0</property>`);
    lines.push(`  <property name="kdenlive:folderid">-1</property>`);
    lines.push(`  <property name="kdenlive:id">${clipId}</property>`);
    lines.push(`  <property name="kdenlive:control_uuid">${bchainUuids[idx]}</property>`);
    lines.push(`  <property name="kdenlive:clip_type">0</property>`);
    lines.push(`  <property name="mute_on_pause">0</property>`);
    lines.push(`  <property name="kdenlive:clipname">${xmlEsc(path.basename(clip.path))}</property>`);
    lines.push(` </chain>`);
  });

  // Main bin playlist
  lines.push(` <playlist id="main_bin">`);
  lines.push(`  <property name="kdenlive:folder.-1.2">Sequences</property>`);
  lines.push(`  <property name="kdenlive:sequenceFolder">2</property>`);
  lines.push(`  <property name="kdenlive:docproperties.audioChannels">2</property>`);
  lines.push(`  <property name="kdenlive:docproperties.documentid">${docId}</property>`);
  lines.push(`  <property name="kdenlive:docproperties.enableTimelineZone">0</property>`);
  lines.push(`  <property name="kdenlive:docproperties.enableproxy">0</property>`);
  lines.push(`  <property name="kdenlive:docproperties.generateimageproxy">0</property>`);
  lines.push(`  <property name="kdenlive:docproperties.generateproxy">0</property>`);
  lines.push(`  <property name="kdenlive:docproperties.profile">HD 1080p 30fps</property>`);
  lines.push(`  <property name="kdenlive:docproperties.version">1.1</property>`);
  lines.push(`  <property name="xml_retain">1</property>`);
  lines.push(`  <entry in="00:00:00.000" out="${toTC(seqDur)}" producer="${seqUuid}"/>`);
  clipMeta.forEach(({ i, trimIn, trimOut }) => {
    lines.push(`  <entry in="${toTC(trimIn)}" out="${toTC(trimOut)}" producer="bchain${i}"/>`);
  });
  lines.push(` </playlist>`);

  // Project tractor
  lines.push(` <tractor id="main_tractor" in="00:00:00.000" out="${toTC(seqDur)}">`);
  lines.push(`  <property name="kdenlive:projectTractor">1</property>`);
  lines.push(`  <track in="00:00:00.000" out="${toTC(seqDur)}" producer="${seqUuid}"/>`);
  lines.push(` </tractor>`);
  lines.push(`</mlt>`);
  return lines.join('\n');
}

app.post('/api/projects/:id/open-folder', (req, res) => {
  const project = db.prepare('SELECT * FROM edit_projects WHERE id=?').get(parseInt(req.params.id));
  if (!project) return res.status(404).send('Not found');
  const clips = q.projectClips.all(project.id).filter(c => fs.existsSync(c.path));
  if (!clips.length) return res.status(400).send('No clips found');
  const safeName  = project.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const folderPath = path.join(os.homedir(), 'Documents', 'kdenlive-projects', safeName);
  fs.mkdirSync(folderPath, { recursive: true });
  // Remove stale symlinks from previous runs
  for (const f of fs.readdirSync(folderPath)) {
    fs.rmSync(path.join(folderPath, f), { force: true });
  }
  clips.forEach((clip, i) => {
    const ext      = path.extname(clip.path);
    const base     = path.basename(clip.path, ext);
    const linkName = `${String(i + 1).padStart(2, '0')}_${base}${ext}`;
    fs.symlinkSync(clip.path, path.join(folderPath, linkName));
  });
  const opener = spawn('xdg-open', [folderPath], { detached: true, stdio: 'ignore' });
  opener.unref();
  res.json({ ok: true, clips: clips.length, path: folderPath });
});

app.post('/api/projects/:id/open-in-kdenlive', (req, res) => {
  const project = db.prepare('SELECT * FROM edit_projects WHERE id=?').get(parseInt(req.params.id));
  if (!project) return res.status(404).send('Not found');
  const clips = q.projectClips.all(project.id).filter(c => fs.existsSync(c.path));
  if (!clips.length) return res.status(400).send('No clips found');
  const xml      = generateMLT(project, clips);
  const safeName = project.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const exportDir = path.join(os.homedir(), 'Documents', 'dji-player-exports');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const mltPath  = path.join(exportDir, `${safeName}.mlt`);
  fs.writeFileSync(mltPath, xml, 'utf8');
  const child = spawn('kdenlive', [mltPath], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log(`Opened in Kdenlive: ${mltPath} (${clips.length} clips)`);
  res.json({ ok: true, clips: clips.length, path: mltPath });
});

// Also offer a plain download for non-local access
app.get('/api/projects/:id/export/mlt', (req, res) => {
  const project = db.prepare('SELECT * FROM edit_projects WHERE id=?').get(parseInt(req.params.id));
  if (!project) return res.status(404).send('Not found');
  const clips = q.projectClips.all(project.id).filter(c => fs.existsSync(c.path));
  const xml      = generateMLT(project, clips);
  const filename = project.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.mlt';
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(xml);
});

// --- API: YouTube Playlists ---

app.get('/api/yt-playlists', (_req, res) => {
  const playlists = q.allYTPlaylists.all().map(pl => ({
    ...pl,
    videoIds: q.playlistItems.all(pl.playlist_id).map(r => r.video_id),
  }));
  res.json(playlists);
});

app.post('/api/yt-playlists', async (req, res) => {
  const yt = getAuthenticatedYT();
  if (!yt) return res.status(401).json({ error: 'not_connected' });
  const { name, description, privacy } = req.body;
  if (!name) return res.status(400).send('Name required');
  try {
    const r = await yt.playlists.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title: name, description: description || '' },
        status: { privacyStatus: privacy || 'unlisted' },
      },
    });
    const pl = r.data;
    const url = `https://www.youtube.com/playlist?list=${pl.id}`;
    q.upsertYTPlaylist.run(pl.id, pl.snippet.title, pl.status.privacyStatus, description || null, url, new Date().toISOString());
    res.json({ playlist_id: pl.id, name: pl.snippet.title, privacy: pl.status.privacyStatus, url, videoIds: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/yt-playlists/:playlistId', async (req, res) => {
  const yt = getAuthenticatedYT();
  if (!yt) return res.status(401).json({ error: 'not_connected' });
  try {
    await yt.playlists.delete({ id: req.params.playlistId });
    q.deleteYTPlaylist.run(req.params.playlistId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/yt-playlists/:playlistId/items', async (req, res) => {
  const yt = getAuthenticatedYT();
  if (!yt) return res.status(401).json({ error: 'not_connected' });
  const { videoId } = req.body;
  if (!videoId) return res.status(400).send('videoId required');
  try {
    await yt.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId: req.params.playlistId,
          resourceId: { kind: 'youtube#video', videoId },
        },
      },
    });
    q.addPlaylistItem.run(req.params.playlistId, videoId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/yt-playlists/:playlistId/items/:videoId', async (req, res) => {
  const yt = getAuthenticatedYT();
  if (!yt) return res.status(401).json({ error: 'not_connected' });
  try {
    // Find the playlistItem id first
    const items = await yt.playlistItems.list({
      part: ['id'],
      playlistId: req.params.playlistId,
      videoId: req.params.videoId,
    });
    const itemId = items.data.items?.[0]?.id;
    if (itemId) await yt.playlistItems.delete({ id: itemId });
    q.removePlaylistItem.run(req.params.playlistId, req.params.videoId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API: Update YouTube video metadata ---
app.put('/api/youtube/:videoId', async (req, res) => {
  const yt = getAuthenticatedYT();
  if (!yt) return res.status(401).json({ error: 'not_connected' });
  const { title, description, tags } = req.body;
  try {
    await yt.videos.update({
      part: ['snippet'],
      requestBody: {
        id: req.params.videoId,
        snippet: {
          title,
          description,
          tags: tags || [],
          categoryId: '22',
        },
      },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API: Tag-playlist links ---
app.get('/api/tag-links', (_req, res) => {
  res.json(q.allTagLinks.all());
});

app.post('/api/tag-links', (req, res) => {
  const { tag, playlist_id, playlist_name, playlist_url, privacy } = req.body;
  if (!tag || !playlist_id) return res.status(400).send('tag and playlist_id required');
  q.upsertTagLink.run(tag, playlist_id, playlist_name || null, playlist_url || null, privacy || 'unlisted');
  res.json({ ok: true });
});

app.delete('/api/tag-links/:tag', (req, res) => {
  q.deleteTagLink.run(decodeURIComponent(req.params.tag));
  res.json({ ok: true });
});

app.post('/api/tag-links/:tag/sync', (req, res) => {
  const tag = decodeURIComponent(req.params.tag);
  const link = q.getTagLink.get(tag);
  if (!link) return res.status(404).send('No playlist linked to this tag');

  const paths = db.prepare('SELECT path FROM tags WHERE tag=?').all(tag).map(r => r.path);
  const inPlaylist = new Set(q.playlistItems.all(link.playlist_id).map(r => r.video_id));
  const queuedPaths = new Set(q.syncQueueForTag.all(link.playlist_id).map(r => r.path));

  let queued = 0;
  for (const p of paths) {
    if (queuedPaths.has(p)) continue;
    const upload = db.prepare('SELECT video_id FROM yt_uploads WHERE path=? LIMIT 1').get(p);
    if (upload?.video_id && inPlaylist.has(upload.video_id)) continue;
    q.insertSyncItem.run(p, link.playlist_id, new Date().toISOString());
    queued++;
  }

  syncNext();
  res.json({ queued, total: paths.length, playlist_name: link.playlist_name });
});

app.post('/api/sync-retry', (_req, res) => {
  const info = db.prepare("UPDATE yt_sync_queue SET status='pending', error=NULL WHERE status='error'").run();
  syncNext();
  res.json({ retried: info.changes });
});

app.get('/api/sync-progress', (_req, res) => {
  const counts = {};
  for (const r of q.countSyncQueue.all()) counts[r.status] = r.n;
  res.json({
    pending:    counts.pending    || 0,
    processing: counts.processing || 0,
    done:       counts.done       || 0,
    error:      counts.error      || 0,
  });
});

// --- API: YouTube channels ---
app.get('/api/channels', async (_req, res) => {
  const yt = getAuthenticatedYT();
  if (!yt) return res.status(401).json({ error: 'not_connected' });
  try {
    const r = await yt.channels.list({ part: ['snippet'], mine: true, maxResults: 50 });
    res.json(r.data.items.map(ch => ({ id: ch.id, name: ch.snippet.title, thumb: ch.snippet.thumbnails?.default?.url })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API: Export with colour correction ---
app.get('/api/export/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');

  const bright = parseFloat(req.query.brightness || 100);
  const cont   = parseFloat(req.query.contrast   || 100);
  const sat    = parseFloat(req.query.saturation  || 100);
  const sharp  = parseFloat(req.query.sharpness   || 0);

  const filters = [];
  if (bright !== 100 || cont !== 100 || sat !== 100) {
    filters.push(`eq=brightness=${((bright - 100) / 100).toFixed(3)}:contrast=${(cont / 100).toFixed(3)}:saturation=${(sat / 100).toFixed(3)}`);
  }
  if (sharp > 0) filters.push(`unsharp=luma_amount=${(sharp / 80).toFixed(2)}`);

  const outName = path.basename(resolved, path.extname(resolved)) + '_enhanced.mp4';
  res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
  res.setHeader('Content-Type', 'video/mp4');

  const ff = spawn('ffmpeg', [
    '-i', resolved,
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'copy',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  ff.stdout.pipe(res);
  res.on('close', () => ff.kill());
});

// --- Background tasks ---
async function pregenerateThumbs() {
  const videos = VIDEO_DIRS.flatMap(scanVideos);
  const missing = videos.filter(v => !fs.existsSync(path.join(THUMB_DIR, thumbName(v.fullPath))));
  console.log(`Pre-generating ${missing.length} thumbnails…`);
  await Promise.all(missing.map(v => enqueueThumb(v.fullPath, path.join(THUMB_DIR, thumbName(v.fullPath)), false)));
  console.log('Thumbnails ready.');
}

async function predetectLocations() {
  const videos = VIDEO_DIRS.flatMap(scanVideos);
  const movFiles = videos.filter(v => /\.mov$/i.test(v.name));

  // Extract GPS for MOV files not yet checked
  const needsGPS = movFiles.filter(v => {
    const row = q.getMeta.get(v.fullPath);
    return !row || !row.gps_checked;
  });
  if (needsGPS.length) {
    console.log(`Extracting GPS from ${needsGPS.length} files…`);
    for (const v of needsGPS) {
      const gps = await extractGPS(v.fullPath);
      if (gps) q.setGPS.run(gps.lat, gps.lon, null, v.fullPath);
      else q.markGPSDone.run(v.fullPath);
    }
  }

  // Reverse geocode rows that have GPS coords but no label yet
  const needsLabel = db.prepare(
    'SELECT path, gps_lat, gps_lon FROM video_meta WHERE gps_lat IS NOT NULL AND location IS NULL'
  ).all();
  if (!needsLabel.length) return;
  console.log(`Reverse geocoding ${needsLabel.length} locations…`);
  for (const row of needsLabel) {
    const label = await reverseGeocode(row.gps_lat, row.gps_lon);
    q.setLocation.run(label, row.path);
    if (label) console.log(`  ${path.basename(row.path)} → ${label}`);
  }
  console.log('Location detection done.');
}

// --- Start ---
app.listen(PORT, '0.0.0.0', async () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) { localIP = addr.address; break; }
    }
  }
  console.log(`DJI Player running:`);
  console.log(`  Laptop: http://localhost:${PORT}`);
  console.log(`  Phone:  http://${localIP}:${PORT}`);
  pregenerateThumbs();
  predetectCodecs();
  predetectLocations();
  // Unstick any jobs left in 'processing' state from a previous run
  db.prepare("UPDATE descriptions SET status='pending' WHERE status='processing'").run();
  db.prepare("UPDATE yt_sync_queue SET status='pending' WHERE status='processing'").run();
  // Auto-resume workers if there are pending items
  describeNext();
  syncNext();
  // Poll for SD card; auto-import new files when detected
  setInterval(() => {
    scanSdCard();
    if (sdState.detected && sdState.newFiles.length > 0 && !sdState.importing) {
      console.log(`SD card: ${sdState.newFiles.length} new file(s) — auto-importing to ${IMPORT_DEST}`);
      runImport();
    }
  }, 5000);
  // Seed Traitors Night tag-playlist link
  if (!q.getTagLink.get('traitors night')) {
    q.upsertTagLink.run('traitors night', 'PLqKrCZEhNJSJgoQWmb1I6VMb3TB1LDCzh', 'Traitors Night',
      'https://www.youtube.com/playlist?list=PLqKrCZEhNJSJgoQWmb1I6VMb3TB1LDCzh', 'unlisted');
    console.log('Seeded Traitors Night tag-playlist link');
  }
});
