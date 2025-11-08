// api/get-videos.js
// Trả về 3 video mới nhất của một kênh YouTube.
// Cách gọi:
//   /api/get-videos?channel=@MrBeast
//   /api/get-videos?channel=https://www.youtube.com/@MrBeast
//   /api/get-videos?channel=UCX6OQ3DkcsbYNE6H8uQQuVA
//   // tương thích cũ:
//   /api/get-videos?channelId=UCX6OQ3DkcsbYNE6H8uQQuVA
//
// Cần biến môi trường: YOUTUBE_API_KEY

const fetch = require('node-fetch');

// ------------ Helpers ------------
function sendJSON(res, status, data) {
  // CORS + cache edge
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (status === 200) {
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate');
  }
  return res.status(status).json(data);
}

// Chuyển mọi dạng đầu vào -> channelId (UC…)
async function resolveChannelId(input, API_KEY) {
  if (!input) return null;
  const raw = input.trim();

  // 1) Nếu chuỗi đã chứa UCID
  const mUC = raw.match(/(UC[0-9A-Za-z_-]{20,})/);
  if (mUC) return mUC[1];

  // 2) Link /channel/UC...
  const mChannel = raw.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})/i);
  if (mChannel) return mChannel[1];

  // 3) Link /user/username (kiểu cũ)
  const mUser = raw.match(/youtube\.com\/user\/([A-Za-z0-9._-]+)/i);
  if (mUser) {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(
      mUser[1]
    )}&key=${API_KEY}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.items && j.items[0]) return j.items[0].id;
  }

  // 4) @handle (có thể nằm trong link hoặc chuỗi)
  const mHandle = raw.match(/@([A-Za-z0-9._-]+)/);
  const q = mHandle ? mHandle[1] : raw;

  // 5) Tìm kênh bằng Search API khi chưa có UC
  const sUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(
    q
  )}&key=${API_KEY}`;
  const sr = await fetch(sUrl);
  const sj = await sr.json();
  if (sj.items && sj.items[0]) {
    return (
      sj.items[0].id?.channelId ||
      sj.items[0].snippet?.channelId ||
      null
    );
  }

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

// ------------ Handler ------------
module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') return sendJSON(res, 200, { ok: true });
  if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) {
    return sendJSON(res, 500, { error: 'Thiếu YOUTUBE_API_KEY trong Environment Variables' });
  }

  // Hỗ trợ cả ?channel= (link/@handle/UCID) và ?channelId=
  const channelInput = (req.query.channel || req.query.channelId || '').trim();
  const maxResults = Number(req.query.maxResults || 3);
  if (!channelInput) {
    return sendJSON(res, 400, { error: 'Yêu cầu không hợp lệ: thiếu tham số channel' });
  }

  try {
    // 1) Chuẩn hoá thành channelId (UC…)
    const channelId = await resolveChannelId(channelInput, API_KEY);
    if (!channelId) {
      return sendJSON(res, 404, { error: 'Không xác định được channelId từ đầu vào' });
    }

    // 2) Lấy playlist uploads + tên kênh
    const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${API_KEY}`;
    const chRes = await fetch(chUrl);
    if (!chRes.ok) throw new Error(`channels: ${chRes.status} ${chRes.statusText}`);
    const chData = await chRes.json();
    if (!chData.items || !chData.items[0]) {
      return sendJSON(res, 404, { error: 'Không tìm thấy kênh' });
    }

    const channelTitle = chData.items[0].snippet?.title || channelId;
    const uploadsId = chData.items[0].contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) {
      return sendJSON(res, 404, { error: 'Kênh không có uploads playlist' });
    }

    // 3) Lấy video mới nhất
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
  } catch (err) {
    console.error('get-videos error:', err);
    return sendJSON(res, 500, { error: 'Lỗi máy chủ nội bộ. Không thể tải video.' });
  }
};
