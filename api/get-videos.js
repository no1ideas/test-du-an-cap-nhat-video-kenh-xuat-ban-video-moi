// api/get-videos.js — phiên bản nâng cấp hỗ trợ @handle & /c/..., có fallback scraping
// Cách gọi:
//   /api/get-videos?channel=@MrBeast
//   /api/get-videos?channel=https://www.youtube.com/@antvtruyenhinhcongannhandan
//   /api/get-videos?channel=https://www.youtube.com/c/ANTVChannel
//   /api/get-videos?channel=UCX6OQ3DkcsbYNE6H8uQQuVA
//
// Cần biến môi trường: YOUTUBE_API_KEY (YouTube Data API v3)

const fetch = require('node-fetch');

function sendJSON(res, status, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (status === 200) res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate');
  return res.status(status).json(data);
}

// ---------- Fallback: bóc UCID từ HTML của trang YouTube ----------
async function scrapeChannelIdFromPage(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'accept-language': 'en-US,en;q=0.8'
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

// Chuẩn hoá mọi dạng đầu vào -> channelId (UC…)
async function resolveChannelId(input, API_KEY) {
  if (!input) return null;
  const raw = input.trim();

  // 1) Nếu đã chứa UC…
  const mUC = raw.match(/(UC[0-9A-Za-z_-]{20,})/);
  if (mUC) return mUC[1];

  // 2) Link /channel/UC…
  const mChannel = raw.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})/i);
  if (mChannel) return mChannel[1];

  // 3) Link /user/username (kiểu cũ) -> channels?forUsername
  const mUser = raw.match(/youtube\.com\/user\/([A-Za-z0-9._-]+)/i);
  if (mUser) {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(
      mUser[1]
    )}&key=${API_KEY}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.items && j.items[0]) return j.items[0].id;
  }

  // 4) @handle (trong link hoặc chuỗi), hoặc custom URL /c/<name>
  const mHandle = raw.match(/@([A-Za-z0-9._-]+)/);
  const mCustom = raw.match(/youtube\.com\/c\/([A-Za-z0-9._-]+)/i);
  const query = mHandle ? mHandle[1] : mCustom ? mCustom[1] : null;

  // 4a) Thử YouTube Data API (search)
  if (query) {
    const sUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(
      query
    )}&key=${API_KEY}`;
    try {
      const sr = await fetch(sUrl);
      const sj = await sr.json();
      const cid = sj.items && sj.items[0] && (sj.items[0].id?.channelId || sj.items[0].snippet?.channelId);
      if (cid) return cid;
    } catch {}
  }

  // 4b) Fallback: scrape HTML của trang @handle /c/...
  if (mHandle) {
    const url = `https://www.youtube.com/@${mHandle[1]}`;
    const cid = await scrapeChannelIdFromPage(url);
    if (cid) return cid;
  }
  if (mCustom) {
    const url = `https://www.youtube.com/c/${mCustom[1]}`;
    const cid = await scrapeChannelIdFromPage(url);
    if (cid) return cid;
  }

  // 5) Cuối cùng: nếu chuỗi không match gì, thử search trực tiếp toàn chuỗi
  const sUrl2 = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(
    raw
  )}&key=${API_KEY}`;
  try {
    const sr2 = await fetch(sUrl2);
    const sj2 = await sr2.json();
    const cid2 = sj2.items && sj2.items[0] && (sj2.items[0].id?.channelId || sj2.items[0].snippet?.channelId);
    if (cid2) return cid2;
  } catch {}

  return null;
}

function fmtVN(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${hh}:${mm} | ${dd}/${mo}/${yy}`;
}

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') return sendJSON(res, 200, { ok: true });
  if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) return sendJSON(res, 500, { error: 'Thiếu YOUTUBE_API_KEY' });

  const channelInput = (req.query.channel || req.query.channelId || '').trim();
  const maxResults = Number(req.query.maxResults || 3);
  if (!channelInput) return sendJSON(res, 400, { error: 'Thiếu tham số channel' });

  try {
    const channelId = await resolveChannelId(channelInput, API_KEY);
    if (!channelId) return sendJSON(res, 404, { error: 'Không xác định được channelId từ đầu vào' });

    const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${API_KEY}`;
    const chRes = await fetch(chUrl);
    if (!chRes.ok) throw new Error(`channels: ${chRes.status} ${chRes.statusText}`);
    const chData = await chRes.json();
    if (!chData.items || !chData.items[0]) return sendJSON(res, 404, { error: 'Không tìm thấy kênh' });

    const channelTitle = chData.items[0].snippet?.title || channelId;
    const uploadsId = chData.items[0].contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) return sendJSON(res, 404, { error: 'Kênh không có uploads playlist' });

    const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=${maxResults}&key=${API_KEY}`;
    const plRes = await fetch(plUrl);
    if (!plRes.ok) throw new Error(`playlistItems: ${plRes.status} ${plRes.statusText}`);
    const plData = await plRes.json();

    const videos = (plData.items || [])
      .map((it) => ({
        id: it?.snippet?.resourceId?.videoId,
        title: it?.snippet?.title,
        publishedAt: it?.snippet?.publishedAt,
        publishedAtVN: it?.snippet?.publishedAt ? fmtVN(it.snippet.publishedAt) : undefined
      }))
      .filter((v) => !!v.id);

    return sendJSON(res, 200, { channelId, channelTitle, videos });
  } catch (e) {
    console.error('get-videos error:', e);
    return sendJSON(res, 500, { error: 'Lỗi máy chủ nội bộ. Không thể tải video.' });
  }
};
