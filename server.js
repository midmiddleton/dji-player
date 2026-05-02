const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http  = require('http');
const { execFile, spawn } = require('child_process');
const Database = require('better-sqlite3');
const { google } = require('googleapis');

const app = express();
const PORT = 3000;

const VIDEO_DIRS = [
  path.join(__dirname, 'videos'),
  '/home/midders/Documents/DJI Camera files',
  '/home/midders/Pictures/camera vids',
  '/home/midders/Desktop/back up',
  '/home/midders/Downloads',
  '/home/midders/Videos',
  '/media/midders/3561-3031/DCIM',
];

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
`);

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

app.post('/api/tags/:encodedPath', (req, res) => {
  const resolved = path.resolve(decodeURIComponent(req.params.encodedPath));
  if (!VIDEO_DIRS.some(d => resolved.startsWith(path.resolve(d)))) return res.status(403).send('Forbidden');
  const tags = (req.body.tags || []).map(t => t.trim().toLowerCase()).filter(Boolean);
  db.transaction(() => {
    q.deleteTags.run(resolved);
    for (const tag of tags) q.insertTag.run(resolved, tag);
  })();
  res.json({ ok: true });
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
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
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

  const stat = fs.statSync(resolved);
  try {
    const response = await yt.videos.insert({
      part: ['snippet', 'status'],
      ...(channelId ? { onBehalfOfContentOwnerChannel: channelId } : {}),
      requestBody: {
        snippet: { title, description, categoryId: '22' },
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

  if (codec === 'hevc' && /\.mov$/i.test(resolved)) {
    const stat = fs.statSync(resolved);
    const range = req.headers.range;
    let seekTime = 0, startByte = 0;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      if (parts[0] !== '') {
        startByte = parseInt(parts[0], 10) || 0;
        if (startByte > 0) {
          const row = q.getMeta.get(resolved);
          if (row?.duration) seekTime = (startByte / stat.size) * row.duration;
        }
      }
    }
    const headers = { 'Content-Type': 'video/mp4' };
    if (startByte > 0) { headers['Content-Range'] = `bytes ${startByte}-${stat.size - 1}/${stat.size}`; res.writeHead(206, headers); }
    else res.writeHead(200, headers);
    const ff = spawn('ffmpeg', [
      ...(seekTime > 0 ? ['-ss', seekTime.toFixed(3)] : []),
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

// --- Ollama / AI description ---
function ollamaChat(prompt) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model: 'llama3.2',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: 'json',
    }));
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(JSON.parse(data).message.content)); }
        catch (e) { reject(new Error('Ollama parse failed: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

  ollamaChat(prompt)
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
});
