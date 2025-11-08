// api/check-channels.js
// Scheduled by vercel.json cron (every 10 minutes)
// Checks channels, if a new video appears -> email via Resend and update KV.
//
// Env: YOUTUBE_API_KEY, RESEND_API_KEY, NOTIFY_EMAIL_FROM, NOTIFY_EMAIL_TO, CHANNELS
//      KV_REST_API_URL, KV_REST_API_TOKEN
//
// Optional: CORS_ORIGIN (not used here)

export const config = { runtime: 'nodejs18.x' };

import { Resend } from 'resend';
import { kv } from '@vercel/kv';

const log = (...args) => console.log('[check-channels]', ...args);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function retry(fn, { tries = 3, base = 300 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(base * Math.pow(2, i));
    }
  }
  throw lastErr;
}

function fmtVN(iso) {
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(new Date(iso));
  } catch {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const mo = String(d.getMonth()+1).padStart(2,'0');
    const yy = d.getFullYear();
    return `${hh}:${mm} ${dd}/${mo}/${yy}`;
  }
}

// ---- YouTube helpers ----

async function resolveChannelId(input, API_KEY) {
  const raw = (input || '').trim();
  if (!raw) return null;

  // 0) cache by input (handles, URLs or UCID)
  const cacheKey = `yt:resolve:${raw}`;
  const cached = await kv.get(cacheKey);
  if (cached) return cached;

  const mUC = raw.match(/(UC[0-9A-Za-z_-]{20,})/);
  if (mUC) {
    await kv.set(cacheKey, mUC[1], { ex: 7 * 24 * 3600 });
    return mUC[1];
  }

  const mChannel = raw.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})/i);
  if (mChannel) {
    await kv.set(cacheKey, mChannel[1], { ex: 7 * 24 * 3600 });
    return mChannel[1];
  }

  const mUser = raw.match(/youtube\.com\/user\/([A-Za-z0-9._-]+)/i);
  if (mUser) {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(mUser[1])}&key=${API_KEY}`;
    const j = await retry(() => fetch(url).then(r => r.json()));
    const id = j.items?.[0]?.id;
    if (id) {
      await kv.set(cacheKey, id, { ex: 7 * 24 * 3600 });
      return id;
    }
  }

  const mHandle = raw.match(/@([A-Za-z0-9._-]+)/);
  const q = mHandle ? mHandle[1] : raw;
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(q)}&key=${API_KEY}`;
  const j = await retry(() => fetch(url).then(r => r.json()));
  const id = j.items?.[0]?.id?.channelId || null;

  if (id) await kv.set(cacheKey, id, { ex: 7 * 24 * 3600 });
  return id;
}

async function getLatestVideos(channelId, API_KEY, maxResults = 3) {
  const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${API_KEY}`;
  const chData = await retry(() => fetch(chUrl).then(r => {
    if (!r.ok) throw new Error(`channels: ${r.status} ${r.statusText}`);
    return r.json();
  }));

  const ch = chData.items?.[0];
  if (!ch) throw new Error('Channel not found');

  const title = ch.snippet?.title || channelId;
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { channelTitle: title, videos: [] };

  const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=${maxResults}&key=${API_KEY}`;
  const plData = await retry(() => fetch(plUrl).then(r => {
    if (!r.ok) throw new Error(`playlistItems: ${r.status} ${r.statusText}`);
    return r.json();
  }));

  const videos = (plData.items || [])
    .map(it => ({
      id: it?.snippet?.resourceId?.videoId,
      title: it?.snippet?.title,
      publishedAt: it?.snippet?.publishedAt
    }))
    .filter(v => !!v.id);

  return { channelTitle: title, videos };
}

// ---- Lock helper to prevent double-send within a small window ----
async function withLock(key, ttlSec, fn) {
  const lockKey = `lock:${key}`;
  const got = await kv.set(lockKey, '1', { nx: true, ex: ttlSec });
  if (!got) return { skipped: true };
  try { return await fn(); }
  finally { /* lock expires automatically */ }
}

// ---- Main handler ----
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const API_KEY    = process.env.YOUTUBE_API_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const EMAIL_TO   = process.env.NOTIFY_EMAIL_TO;
  const EMAIL_FROM = process.env.NOTIFY_EMAIL_FROM;
  const CHANNELS   = process.env.CHANNELS || '';

  if (!API_KEY)    return res.status(500).json({ error: 'Missing YOUTUBE_API_KEY' });
  if (!RESEND_KEY) return res.status(500).json({ error: 'Missing RESEND_API_KEY' });
  if (!EMAIL_FROM || !EMAIL_TO) return res.status(500).json({ error: 'Missing NOTIFY_EMAIL_FROM/TO' });
  if (!CHANNELS.trim()) return res.status(400).json({ error: 'Missing CHANNELS' });

  const resend = new Resend(RESEND_KEY);
  const inputs = CHANNELS.split(',').map(s => s.trim()).filter(Boolean);

  const tasks = inputs.map(async (input) => {
    try {
      const channelId = await resolveChannelId(input, API_KEY);
      if (!channelId) return { input, error: 'Cannot resolve channelId' };

      const lockRes = await withLock(`yt:${channelId}`, 90, async () => {
        const { channelTitle, videos } = await getLatestVideos(channelId, API_KEY, 3);
        if (!videos.length) return { input, channelId, channelTitle, status: 'No videos' };

        const kvKey = `yt:last:${channelId}`;
        const lastSaved = await kv.get(kvKey);
        const newest = videos[0];

        // If nothing changed, stop.
        if (lastSaved && lastSaved === newest.id) {
          return { input, channelId, channelTitle, status: 'No new video' };
        }

        // Optionally: include all videos newer than lastSaved
        const newVideos = [];
        for (const v of videos) {
          if (v.id === lastSaved) break;
          newVideos.push(v);
        }
        const listHtml = newVideos.length > 1
          ? `<ul>${newVideos.map(v => `<li>${v.title} — ${fmtVN(v.publishedAt)}</li>`).join('')}</ul>`
          : '';

        const hero = newVideos[0] || newest;

        const html = `
          <div style="font-family:Arial,sans-serif">
            <h2>🔔 ${channelTitle} just posted a new video</h2>
            <p><b>${hero.title}</b></p>
            <p>Time: ${fmtVN(hero.publishedAt)}</p>
            <p><a href="https://www.youtube.com/watch?v=${hero.id}">Open on YouTube</a></p>
            <p><img src="https://i.ytimg.com/vi/${hero.id}/hqdefault.jpg" width="480" alt=""></p>
            ${newVideos.length > 1 ? `<hr/><p>Other new uploads detected:</p>${listHtml}` : ''}
            <hr/>
            <p><a href="https://www.youtube.com/channel/${channelId}">Open channel</a></p>
          </div>
        `;

        const recipients = EMAIL_TO.includes(',')
          ? EMAIL_TO.split(',').map(s => s.trim()).filter(Boolean)
          : EMAIL_TO;

        await resend.emails.send({
          from: EMAIL_FROM,
          to: recipients,
          subject: `YouTube: ${channelTitle} has a new video`,
          html
        });

        await kv.set(kvKey, hero.id); // save last seen (most recent emailed)
        return { input, channelId, channelTitle, status: 'Email sent', videoId: hero.id };
      });

      if (lockRes?.skipped) {
        return { input, status: 'Skipped (locked)' };
      }
      return lockRes;
    } catch (e) {
      log('ERR', input, e.message);
      return { input, error: e.message };
    }
  });

  const results = await Promise.all(tasks);
  const sentCount = results.filter(r => r?.status === 'Email sent').length;

  return res.status(200).json({ ok: true, sentCount, results, at: new Date().toISOString() });
}
