// api/get-videos.js
// Hỗ trợ đầy đủ @handle, /c/username, /user/username, UCID, hoặc link YouTube đầy đủ
// Yêu cầu: biến môi trường YOUTUBE_API_KEY

export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "Thiếu API key YouTube" });

  const input = (req.query.channel || "").trim();
  if (!input) return res.status(400).json({ error: "Thiếu tham số channel" });

  try {
    const channelId = await resolveChannelId(input, API_KEY);
    if (!channelId) return res.status(404).json({ error: "Không xác định được channelId từ URL hoặc @handle" });

    const chInfo = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${channelId}&key=${API_KEY}`
    );
    const chData = await chInfo.json();
    if (!chData.items?.length) return res.status(404).json({ error: "Không tìm thấy kênh trên YouTube API" });

    const uploadsId = chData.items[0].contentDetails.relatedPlaylists.uploads;
    const title = chData.items[0].snippet.title;

    const videosRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=3&key=${API_KEY}`
    );
    const videosData = await videosRes.json();

    const videos = (videosData.items || []).map((v) => ({
      title: v.snippet.title,
      videoId: v.snippet.resourceId.videoId,
      publishedAt: formatDateVN(v.snippet.publishedAt),
    }));

    res.status(200).json({ channelId, title, videos });
  } catch (err) {
    console.error("Lỗi:", err);
    res.status(500).json({ error: "Không thể lấy dữ liệu từ YouTube." });
  }
}

// ====== Các hàm phụ ======

// Nhận dạng ID từ bất kỳ đầu vào nào
async function resolveChannelId(input, API_KEY) {
  // Nếu có UCID
  const ucMatch = input.match(/UC[0-9A-Za-z_-]{20,}/);
  if (ucMatch) return ucMatch[0];

  // Nếu là link chứa UCID
  const chMatch = input.match(/channel\/(UC[0-9A-Za-z_-]{20,})/);
  if (chMatch) return chMatch[1];

  // Nếu là @handle
  const handleMatch = input.match(/@([A-Za-z0-9._-]+)/);
  const handle = handleMatch ? handleMatch[1] : null;

  // Nếu có @handle -> thử API search
  if (handle) {
    const search = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(
        handle
      )}&key=${API_KEY}`
    );
    const data = await search.json();
    const found = data.items?.[0]?.id?.channelId;
    if (found) return found;
  }

  // Nếu vẫn không có -> bóc từ HTML
  const scraped = await scrapeChannelId(input);
  if (scraped) return scraped;

  return null;
}

// Bóc channelId từ HTML của trang
async function scrapeChannelId(urlOrHandle) {
  let url = urlOrHandle.trim();
  if (!url.startsWith("http")) url = `https://www.youtube.com/${url.replace(/^@/, "@")}`;

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await resp.text();
    const match = html.match(/"channelId":"(UC[0-9A-Za-z_-]{20,})"/);
    if (match) return match[1];
  } catch (e) {
    console.error("Lỗi scrapeChannelId:", e);
  }

  return null;
}

// Format giờ VN
function formatDateVN(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mi} ${dd}/${mm}/${yy}`;
}
