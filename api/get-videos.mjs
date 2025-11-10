// api/get-videos.mjs
// Nhận: ?channel=<full_url_dang_@handle>
// Env: YOUTUBE_API_KEY, (optional) CORS_ORIGIN

export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Thiếu YOUTUBE_API_KEY' });

  const inputRaw = (req.query.channel ?? '').trim();
  if (!inputRaw) return res.status(400).json({ error: 'Thiếu tham số channel (link dạng https://www.youtube.com/@HANDLE)' });

  try {
    const channelId = await resolveChannelIdFromUrl(inputRaw, API_KEY);
    if (!channelId) return res.status(404).json({ error: 'Không tìm thấy kênh với link này' });

    const chInfo = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${channelId}&key=${API_KEY}`);
    if (!chInfo.ok) throw new Error(`channels: ${chInfo.status} ${chInfo.statusText}`);
    const chData = await chInfo.json();
    if (!chData.items?.length) return res.status(404).json({ error: 'Không tìm thấy kênh' });

    const title = chData.items[0].snippet.title;
    const uploads = chData.items[0].contentDetails.relatedPlaylists.uploads;

    const vidsRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=3&key=${API_KEY}`);
    if (!vidsRes.ok) throw new Error(`playlistItems: ${vidsRes.status} ${vidsRes.statusText}`);
    const vidsData = await vidsRes.json();

    const videos = (vidsData.items || [])
      .map(it => ({
        id: it?.snippet?.resourceId?.videoId,
        title: it?.snippet?.title,
        publishedAt: it?.snippet?.publishedAt
      }))
      .filter(v => v.id);

    return res.status(200).json({ channelTitle: title, videos });
  } catch (e) {
    console.error('[get-videos] error:', e);
    return res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
}

// --------- Helpers ---------
function extractHandleFromUrl(url) {
  const m = url.trim().match(/youtube\.com\/@([\w.\-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function resolveChannelIdFromUrl(url, API_KEY) {
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

  const scraped = await scrapeChannelIdFromPage(url);
  return scraped || null;
}

async function scrapeChannelIdFromPage(url) {
  try {
    const r = await fetch(url.replace(/\/(videos|featured|shorts|live)\/?$/i, ''), {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });
    const html = await r.text();
    let m = html.match(/"channelId":"(UC[0-9A-Za-z_-]{20,})"/);
    if (m) return m[1];
    m = html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})/i);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}
