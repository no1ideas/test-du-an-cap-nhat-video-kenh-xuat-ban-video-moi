// Serverless function do CRON gọi định kỳ
// Kiểm tra danh sách kênh, nếu có video mới => gửi email qua Resend và cập nhật KV

import fetch from 'node-fetch';
import { Resend } from 'resend';
import { kv } from '@vercel/kv';

// ─── Helpers ───────────────────────────────────────────────────────────────
function log(...args) { console.log('[check-channels]', ...args); }

async function resolveChannelId(input, API_KEY) {
  const raw = (input || '').trim();
  if (!raw) return null;

  // 1️⃣ Có sẵn UCID
  const mUC = raw.match(/(UC[0-9A-Za-z_-]{20,})/);
  if (mUC) return mUC[1];

  // 2️⃣ Link /channel/UC...
  const mChannel = raw.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})/i);
  if (mChannel) return mChannel[1];

  // 3️⃣ Link /user/<name> (cũ)
  const mUser = raw.match(/youtube\.com\/user\/([A-Za-z0-9._-]+)/i);
  if (mUser) {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(mUser[1])}&key=${API_KEY}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.items?.[0]) return j.items[0].id;
  }

  // 4️⃣ Handle @username hoặc /c/<name>
  const mHandle = raw.match(/@([A-Za-z0-9._-]+)/);
  const mCustom = raw.match(/youtube\.com\/c\/([A-Za-z0-9._-]+)/i);
  const keyword = mHandle ? mHandle[1] : mCustom ? mCustom[1] : null;

  // 4a) API chính thức cho handle (2023+)
  if (keyword) {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(keyword)}&key=${API_KEY}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.items?.[0]?.id) return j.items[0].id;
  }

  // 4b) Nếu thất bại → fallback search
  const q = raw.replace(/^https?:\/\/(www\.)?youtube\.com\//, '');
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(q)}&key=${API_KEY}`;
  const s = await fetch(searchUrl);
  const j = await s.json();
  if (j.items?.[0]?.id?.channelId) return j.items[0].id.channelId;

  // 5️⃣ Scrape HTML trang YouTube (cuối cùng)
  const scraped = await scrapeChannelIdFromPage(raw);
  if (scraped) return scraped;

  return null;
}

async function scrapeChannelIdFromPage(urlOrHandle) {
  let url = urlOrHandle;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://www.youtube.com/${url.replace(/^@/, '@')}`;
  }
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'accept-language': 'en-US,en;q=0.9',
      },
      redirect: 'follow'
    });
    const html = await r.text();
    const m = html.match(/"channelId":"(UC[0-9A-Za-z_-]{20,})"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function getLatestVideos(channelId, API_KEY, maxResults = 3) {
  const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${API_KEY}`;
  const chRes = await fetch(chUrl);
  if (!chRes.ok) throw new Error(`channels: ${chRes.status} ${chRes.statusText}`);
  const chData = await chRes.json();
  if (!chData.items?.[0]) throw new Error('Không tìm thấy kênh');

  const title = chData.items[0].snippet?.title || channelId;
  const uploads = chData.items[0].contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { channelTitle: title, videos: [] };

  const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=${maxResults}&key=${API_KEY}`;
  const plRes = await fetch(plUrl);
  if (!plRes.ok) throw new Error(`playlistItems: ${plRes.status} ${plRes.statusText}`);
  const plData = await plRes.json();

  const videos = (plData.items || []).map(it => ({
    id: it?.snippet?.resourceId?.videoId,
    title: it?.snippet?.title,
    publishedAt: it?.snippet?.publishedAt
  })).filter(v => !!v.id);

  return { channelTitle: title, videos };
}

function fmtVN(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${hh}:${mm} ${dd}/${mo}/${yy}`;
}

// ─── Main handler (cron) ────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  const EMAIL_TO = process.env.NOTIFY_EMAIL_TO;
  const EMAIL_FROM = process.env.NOTIFY_EMAIL_FROM;
  const CHANNELS = process.env.CHANNELS || '';

  if (!API_KEY) return res.status(500).json({ error: 'Thiếu YOUTUBE_API_KEY' });
  if (!EMAIL_TO || !EMAIL_FROM) return res.status(500).json({ error: 'Thiếu NOTIFY_EMAIL_TO/FROM' });
  if (!CHANNELS.trim()) return res.status(400).json({ error: 'Thiếu CHANNELS' });

  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Thiếu RESEND_API_KEY' });
  }

  const inputs = CHANNELS.split(',').map(s => s.trim()).filter(Boolean);
  const results = [];
  let sentCount = 0;

  for (const input of inputs) {
    try {
      const channelId = await resolveChannelId(input, API_KEY);
      if (!channelId) {
        results.push({ input, error: 'Không xác định được channelId' });
        continue;
      }

      const { channelTitle, videos } = await getLatestVideos(channelId, API_KEY, 3);
      if (!videos.length) {
        results.push({ input, channelId, channelTitle, status: 'No videos' });
        continue;
      }

      const kvKey = `yt:last:${channelId}`;
      const lastSaved = await kv.get(kvKey);
      const newest = videos[0];

      if (lastSaved && lastSaved === newest.id) {
        results.push({ input, channelId, channelTitle, status: 'No new video' });
        continue;
      }

      const html = `
        <div style="font-family:Arial,sans-serif">
          <h2>🔔 Kênh ${channelTitle} vừa đăng video mới</h2>
          <p><b>${newest.title}</b></p>
          <p>Thời gian: ${fmtVN(newest.publishedAt)}</p>
          <p><a href="https://www.youtube.com/watch?v=${newest.id}">Mở video trên YouTube</a></p>
          <hr/>
          <p>Hai video gần nhất tiếp theo:</p>
          <ul>
            ${videos.slice(1).map(v => `<li>${v.title} — ${fmtVN(v.publishedAt)}</li>`).join('')}
          </ul>
        </div>
      `;

      await resend.emails.send({
        from: EMAIL_FROM,
        to: EMAIL_TO,
        subject: `YouTube: ${channelTitle} có video mới`,
        html
      });

      await kv.set(kvKey, newest.id);
      results.push({ input, channelId, channelTitle, status: 'Email sent', videoId: newest.id });
      sentCount++;
    } catch (e) {
      log('ERR', input, e.message);
      results.push({ input, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, sentCount, results, at: new Date().toISOString() });
}
