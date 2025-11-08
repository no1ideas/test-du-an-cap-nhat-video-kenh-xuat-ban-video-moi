// api/get-videos.js
// Hỗ trợ đầy đủ: channelId, @handle, /c/username, /user/username, link YouTube đầy đủ
// Yêu cầu biến môi trường: YOUTUBE_API_KEY

import fetch from "node-fetch";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "GET") return res.status(405).json({ error: "Phương thức không hợp lệ" });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "Thiếu API key YouTube" });

  const input = (req.query.channel || "").trim();
  if (!input) return res.status(400).json({ error: "Thiếu tham số channel" });

  try {
    const channelId = await resolveChannelId(input, API_KEY);
    if (!channelId) return res.status(404).json({ error: "Không xác định được channelId" });

    const channelInfo = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${API_KEY}`
    );
    const data = await channelInfo.json();
    if (!data.items?.length) return res.status(404).json({ error: "Không tìm thấy kênh" });

    const uploads = data.items[0].contentDetails.relatedPlaylists.uploads;
    const title = data.items[0].snippet.title;

    const videosRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=3&key=${API_KEY}`
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
    res.status(500).json({ error: "Không thể tải dữ liệu kênh." });
  }
}

// =================== Các hàm phụ ===================

// ✅ Tự động nhận dạng UCID từ mọi dạng URL
async function resolveChannelId(input, API_KEY) {
  // Nếu có UCID sẵn
  const matchUC = input.match(/UC[0-9A-Za-z_-]{20,}/);
  if (matchUC) return matchUC[0];

  // Nếu có dạng channel/UCxxxx
  const matchChannel = input.match(/channel\/(UC[0-9A-Za-z_-]{20,})/);
  if (matchChannel) return matchChannel[1];

  // Nếu là link hoặc @handle -> thử YouTube API search
  const handleMatch = input.match(/@([A-Za-z0-9._-]+)/);
  const query = handleMatch ? handleMatch[1] : input;

  const searchRes = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(
      query
    )}&key=${API_KEY}`
  );
  const searchData = await searchRes.json();
  const apiId = searchData.items?.[0]?.id?.channelId;
  if (apiId) return apiId;

  // Nếu API không trả về, thử bóc trực tiếp từ HTML
  const scraped = await scrapeChannelIdFromPage(input);
  if (scraped) return scraped;

  return null;
}

// ✅ Bóc UCID từ mã HTML của trang YouTube
async function scrapeChannelIdFromPage(urlOrHandle) {
  let url = urlOrHandle.trim();
  if (!url.startsWith("http")) url = `https://www.youtube.com/${url.replace(/^@/, "@")}`;
  try {
    const resp = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      },
    });
    const html = await resp.text();
    const match = html.match(/"channelId":"(UC[0-9A-Za-z_-]{20,})"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ✅ Định dạng giờ Việt Nam
function formatDateVN(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mi} ${dd}/${mm}/${yy}`;
}
