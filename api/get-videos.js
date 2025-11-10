// Hỗ trợ: UCID, @handle, /c/<name>, /user/<name>, link youtube đầy đủ
// Nhận cả tham số ?channelId= và ?channel=
// Cần biến môi trường: YOUTUBE_API_KEY

export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Thiếu YOUTUBE_API_KEY' });

  // Cho phép dùng ?channel hoặc ?channelId
  const inputRaw = (req.query.channel ?? req.query.channelId ?? '').trim();
  if (!inputRaw) {
    return res.status(400).json({ error: 'Thiếu tham số channel hoặc channelId' });
  }

  console.log('[get-videos] query =', req.query); // xem trong Vercel Logs

  try {
    const channelId = await resolveChannelId(inputRaw, API_KEY);
    if (!channelId) {
      return res.status(404).json({ error: 'Không tìm thấy kênh với ID này' });
    }

    // Lấy thông tin kênh
    const chInfo = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${channelId}&key=${API_KEY}`
    );
    if (!chInfo.ok) throw new Error(`channels: ${chInfo.status} ${chInfo.statusText}`);
    const chData = await chInfo.json();
    if (!chData.items?.length) return res.status(404).json({ error: 'Không tìm thấy kênh' });

    const title = chData.items[0].snippet.title;
    const uploads = chData.items[0].contentDetails.relatedPlaylists.uploads;

    // Lấy 3 video mới nhất
    const vidsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=3&key=${API_KEY}`
    );
    if (!vidsRes.ok) throw new Error(`playlistItems: ${vidsRes.status} ${vidsRes.statusText}`);
    const vidsData = await vidsRes.json();

    const videos = (vidsData.items || []).map((it) => ({
      id: it?.snippet?.resourceId?.videoId,
      title: it?.snippet?.title,
      publishedAt: it?.snippet?.publishedAt
    })).filter(v => v.id);

    return res.status(200).json({ channelTitle: title, videos });
  } catch (e) {
    console.error('[get-videos] error:', e);
    return res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
}

// ---------- Helpers ----------
async function resolveChannelId(input, API_KEY) {
  const raw = input.trim();

  // 1) Có sẵn UCID
  const mUC = raw.match(/UC[0-9A-Za-z_-]{20,}/);
  if (mUC) return mUC[0];

  // 2) Link /channel/UC...
  const mCh = raw.match(/channel\/(UC[0-9A-Za-z_-]{20,})/i);
  if (mCh) return mCh[1];

  // 3) /user/<name> (cũ)
  const mUser = raw.match(/youtube\.com\/user\/([A-Za-z0-9._-]+)/i);
  if (mUser) {
    const u = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(mUser[1])}&key=${API_KEY}`;
    const r = await fetch(u);
    const j = await r.json();
    if (j.items?.[0]?.id) return j.items[0].id;
  }

  // 4) @handle hoặc /c/<name>
  const mHandle = raw.match(/@([A-Za-z0-9._-]+)/);
  const mCustom = raw.match(/youtube\.com\/c\/([A-Za-z0-9._-]+)/i);
  const keyword = mHandle ? mHandle[1] : mCustom ? mCustom[1] : null;

  // 4a) Nếu có handle -> dùng API forHandle (YouTube Data API v3 2023+)
  if (keyword) {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(keyword)}&key=${API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.items?.[0]?.id) return data.items[0].id;
  }

  // 4b) Nếu vẫn chưa có -> fallback search
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(raw)}&key=${API_KEY}`;
  const searchResp = await fetch(searchUrl);
  const searchData = await searchResp.json();
  if (searchData.items?.[0]?.id?.channelId) return searchData.items[0].id.channelId;

  // 5) Cuối cùng: scrape HTML nếu vẫn thất bại
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
