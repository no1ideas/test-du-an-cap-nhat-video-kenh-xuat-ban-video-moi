// api/check-channels.mjs
// Cron: kiểm tra list kênh (link /@handle), có video mới thì email qua Resend và lưu KV.

export const config = { runtime: 'nodejs18.x' };

import { Resend } from 'resend';
import { kv } from '@vercel/kv';

const log = (...a) => console.log('[check-channels]', ...a);

function fmtVN(iso) {
  try {
    return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
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

function extractHandleFromUrl(url) {
  const m = url.trim().match(/youtube\.com\/@([\w.\-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function resolveChannelIdFromUrl(url, API_KEY) {
  // /channel/UC...
  const mCh = url.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})/i);
  if (mCh) return mCh[1];

  const handle = extractHandleFromUrl(url);
  if (handle) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(handle)}&key=${API_KEY}`);
    const j = await r.json();
    if (j.items?.[0]?.id) return j.items[0].id;
  }

  const s = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(url)}&key=${API_KEY}`);
  const sj = await s.json();
  if (sj.items?.[0]?.id?.channelId) return sj.items[0].id.channelId;

  // scrape fallback
  try {
    const r = await fetch(url.replace(/\/(videos|featured|shorts|live)\/?$/i, ''), {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'accept-language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });
    const html = await r.text();
    const m = html.match(/"channelId":"(UC[0-9A-Za-z_-]{20,})"/);
    if (m) return m[1];
  } catch {}
  return null;
}

async function getLatestVideos(channelId, API_KEY, maxResults = 3) {
  const chRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${API_KEY}`);
  if (!chRes.ok) throw new Error(`channels: ${chRes.status} ${chRes.statusText}`);
  const chData = await chRes.json();
  const ch = chData.items?.[0];
  if (!ch) throw new Error('Không tìm thấy kênh');

  const title = ch.snippet?.title || channelId;
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { channelTitle: title, videos: [] };

  const plRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=${maxResults}&key=${API_KEY}`);
  if (!plRes.ok) throw new Error(`playlistItems: ${plRes.status} ${plRes.statusText}`);
  const plData = await plRes.json();

  const videos = (plData.items || []).map(it => ({
    id: it?.snippet?.resourceId?.videoId,
    title: it?.snippet?.title,
    publishedAt: it?.snippet?.publishedAt
  })).filter(v => v.id);

  return { channelTitle: title, videos };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const API_KEY    = process.env.YOUTUBE_API_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const EMAIL_TO   = process.env.NOTIFY_EMAIL_TO;
  const EMAIL_FROM = process.env.NOTIFY_EMAIL_FROM;
  const CHANNELS   = process.env.CHANNELS || '';

  if (!API_KEY)     return res.status(500).json({ error: 'Thiếu YOUTUBE_API_KEY' });
  if (!RESEND_KEY)  return res.status(500).json({ error: 'Thiếu RESEND_API_KEY' });
  if (!EMAIL_FROM || !EMAIL_TO) return res.status(500).json({ error: 'Thiếu NOTIFY_EMAIL_FROM/TO' });
  if (!CHANNELS.trim()) return res.status(400).json({ error: 'Thiếu CHANNELS' });

  const resend = new Resend(RESEND_KEY);
  const urls = CHANNELS.split(',').map(s => s.trim()).filter(Boolean);

  const results = [];
  let sentCount = 0;

  for (const url of urls) {
    try {
      const channelId = await resolveChannelIdFromUrl(url, API_KEY);
      if (!channelId) { results.push({ url, error: 'Không xác định được channelId từ link' }); continue; }

      const { channelTitle, videos } = await getLatestVideos(channelId, API_KEY, 3);
      if (!videos.length) { results.push({ url, channelId, channelTitle, status: 'No videos' }); continue; }

      const kvKey = `yt:last:${channelId}`;
      const lastSaved = await kv.get(kvKey);

      const newest = videos[0];
      if (lastSaved && lastSaved === newest.id) {
        results.push({ url, channelId, channelTitle, status: 'No new video' });
        continue;
      }

      const html = `
        <div style="font-family:Arial,sans-serif">
          <h2>🔔 Kênh ${channelTitle} vừa đăng video mới</h2>
          <p><b>${newest.title}</b></p>
          <p>Thời gian: ${fmtVN(newest.publishedAt)}</p>
          <p><a href="https://www.youtube.com/watch?v=${newest.id}">Mở video trên YouTube</a></p>
          <p><img src="https://i.ytimg.com/vi/${newest.id}/hqdefault.jpg" width="480" alt=""></p>
          <hr/>
          <p>Hai video gần nhất tiếp theo:</p>
          <ul>
            ${videos.slice(1).map(v => `<li>${v.title} — ${fmtVN(v.publishedAt)}</li>`).join('')}
          </ul>
        </div>
      `;

      const recipients = EMAIL_TO.includes(',')
        ? EMAIL_TO.split(',').map(s => s.trim()).filter(Boolean)
        : EMAIL_TO;

      await resend.emails.send({
        from: EMAIL_FROM,
        to: recipients,
        subject: `YouTube: ${channelTitle} có video mới`,
        html
      });

      await kv.set(kvKey, newest.id);
      results.push({ url, channelId, channelTitle, status: 'Email sent', videoId: newest.id });
      sentCount++;
    } catch (e) {
      log('ERR', url, e.message);
      results.push({ url, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, sentCount, results, at: new Date().toISOString() });
}
