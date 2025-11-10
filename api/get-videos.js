// --- Helpers robust ---

// Bóc "channelId":"UC..." từ HTML trang YouTube (fallback cuối)
async function scrapeChannelIdFromPage(input) {
  // Chấp nhận @handle, đường dẫn rút gọn, hoặc full URL
  let url = (input || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    // Nếu chỉ là @handle hoặc đoạn đường dẫn, chuẩn hóa thành URL
    url = `https://www.youtube.com/${url.replace(/^@/, '@')}`;
  }
  // Gọt bớt đuôi /videos, /featured, /streams… nếu có
  url = url.replace(/\/(videos|featured|streams|shorts|live)(\/)?$/i, '');

  try {
    const r = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    const html = await r.text();

    // Cách 1: tìm trong JSON big script "channelId":"UC..."
    let m = html.match(/"channelId":"(UC[0-9A-Za-z_-]{20,})"/);
    if (m) return m[1];

    // Cách 2: đôi khi có trong link canonical
    m = html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})/i);
    if (m) return m[1];

    return null;
  } catch {
    return null;
  }
}

// Nâng cấp: nhận @handle (forHandle), /user/, /c/, UCID, URL… + fallback scrape
async function resolveChannelId(input, API_KEY) {
  const raw = (input || '').trim();
  if (!raw) return null;

  // 0) Nếu đã là UCID
  const mUC = raw.match(/(UC[0-9A-Za-z_-]{20,})/);
  if (mUC) return mUC[1];

  // 1) URL /channel/UC...
  const mChannel = raw.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})/i);
  if (mChannel) return mChannel[1];

  // 2) /user/<name> (legacy username)
  const mUser = raw.match(/youtube\.com\/user\/([A-Za-z0-9._-]+)/i);
  if (mUser) {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(
      mUser[1]
    )}&key=${API_KEY}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.items?.[0]?.id) return j.items[0].id;
  }

  // 3) @handle hoặc /c/<name> hoặc URL @handle
  const mHandle = raw.match(/@([A-Za-z0-9._-]+)/); // match cả HOA/thường
  const mCustom = raw.match(/youtube\.com\/c\/([A-Za-z0-9._-]+)/i);
  const handle = mHandle ? `@${mHandle[1].toLowerCase()}` : null; // handle không phân biệt hoa/thường
  const keyword = mHandle ? mHandle[1] : mCustom ? mCustom[1] : null;

  // 3a) Ưu tiên: forHandle (ổn định hơn search)
  if (handle) {
    const u = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(
      handle
    )}&key=${API_KEY}`;
    const r = await fetch(u);
    const j = await r.json();
    if (j.items?.[0]?.id) return j.items[0].id;
  }

  // 3b) Fallback: search theo handle/custom name
  if (keyword) {
    const s = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(
        keyword
      )}&key=${API_KEY}`
    );
    const sj = await s.json();
    const cid = sj.items?.[0]?.id?.channelId || sj.items?.[0]?.snippet?.channelId;
    if (cid) return cid;
  }

  // 3c) Fallback: scrape HTML từ chính input (URL hoặc @handle)
  const scraped = await scrapeChannelIdFromPage(raw);
  if (scraped) return scraped;

  // 4) Phương án cuối: search toàn chuỗi đầu vào
  const s2 = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(
      raw
    )}&key=${API_KEY}`
  );
  const s2j = await s2.json();
  return s2j.items?.[0]?.id?.channelId || null;
}
