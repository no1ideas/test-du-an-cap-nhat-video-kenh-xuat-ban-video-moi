// api/get-videos.js
// Supports: UCID, @handle, /c/<name>, /user/<name>, full YouTube URLs
// Accepts both ?channelId= and ?channel=
// Env: YOUTUBE_API_KEY, CORS_ORIGIN (optional)

export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Missing YOUTUBE_API_KEY' });

  const inputRaw = (req.query.channel ?? req.query.channelId ?? '').trim();
  if (!inputRaw) return res.status(400).json({ error: 'Missing channel or channelId' });

  try {
    const channelId = await resolveChannelId(inputRaw, API_KEY);
    if (!channelId) return res.status(404).json({ error: 'Cannot resolve channelId from input' });

    const chInfo = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${channelId}&key=${API_KEY}`
    );
    if (!chInfo.ok) throw new Error(`channels: ${chInfo.status} ${chInfo.statusText}`);
    const chData = await chInfo.json();
    if (!chData.items?.length) return res.status(404).json({ error: 'Channel not found' });

    const title = chData.items[0].snippet.title;
    const uploads = chData.items[0].contentDetails.relatedPlaylists.uploads;

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
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

// ---------- Helpers ----------
async function resolveChannelId(input, API_KEY) {
  const raw = input.trim();

  // 1) UCID present
  const mUC = raw.match(/UC[0-9A-Za-z_-]{20,}/);
  if (mUC) return mUC[0];

  // 2) /channel/UC...
  const mCh = raw.match(/channel\/(UC[0-9A-Za-z_-]{20,})/i);
  if (mCh) return mCh[1];

  // 3) /user/<name>
  const mUser = raw.match(/youtube\.com\/user\/([A-Za-z0-9._-]+)/i);
  if (mUser) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(mUser[1])}&key=${API_KEY}`);
    const j = await r.json();
    if (j.items?.[0]?.id) return j.items[0].id;
  }

  // 4) @handle or /c/<name>
  const mHandle = raw.match(/@([A-Za-z0-9._-]+)/);
  const mCustom = raw.match(/youtube\.com\/c\/([A-Za-z0-9._-]+)/i);
  const keyword = mHandle ? mHandle[1] : (mCustom ? mCustom[1] : null);

  if (keyword) {
    const s = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(keyword)}&key=${API_KEY}`);
    const sj = await s.json();
    const cid = sj.items?.[0]?.id?.channelId || sj.items?.[0]?.snippet?.channelId;
    if (cid) return cid;
  }

  // 5) last resort: search whole string
  const s2 = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(raw)}&key=${API_KEY}`);
  const s2j = await s2.json();
  return s2j.items?.[0]?.id?.channelId || null;
}
