// Tệp này PHẢI được đặt tên là 'get-videos.js' 
// và nằm TRONG một thư mục tên là 'api'
// Đường dẫn đầy đủ sẽ là: [thư mục dự án]/api/get-videos.js

// node-fetch là thư viện để gọi API từ backend
// Chúng ta dùng require() vì package.json không có "type": "module"
const fetch = require('node-fetch');

// Đây là nơi Vercel Serverless Function xử lý yêu cầu
export default async function handler(request, response) {
    
    // 1. Lấy API Key từ Biến Môi trường (AN TOÀN)
    // Bạn phải đặt biến này trong cài đặt dự án Vercel
    const API_KEY = process.env.YOUTUBE_API_KEY;

    if (!API_KEY) {
        // Trả về lỗi nếu bạn quên cài đặt API Key
        // Dùng console.error để ghi log lỗi phía server
        console.error('Lỗi: YOUTUBE_API_KEY chưa được cài đặt trong Vercel Environment Variables.');
        return response.status(500).json({ error: 'Lỗi máy chủ: API Key chưa được cấu hình.' });
    }

    // 2. Lấy channelId từ tham số query (ví dụ: /api/get-videos?channelId=UC...)
    const { channelId } = request.query;

    if (!channelId) {
        return response.status(400).json({ error: 'Yêu cầu không hợp lệ: Thiếu tham số channelId' });
    }

    try {
        // 3. Gọi API YouTube để tìm playlist "uploads" của kênh
        // Chúng ta cần lấy 'snippet' để có tên kênh (channelTitle)
        // và 'contentDetails' để có ID playlist 'uploads'
        const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${API_KEY}`;
        
        const channelRes = await fetch(channelUrl);
        if (!channelRes.ok) {
            // Nếu gọi API thất bại (ví dụ: key sai), ném lỗi
            throw new Error(`Lỗi YouTube API (Channels): ${channelRes.statusText}`);
        }
        
        const channelData = await channelRes.json();

        if (!channelData.items || channelData.items.length === 0) {
            return response.status(404).json({ error: 'Không tìm thấy kênh với ID này' });
        }

        // 4. Lấy thông tin kênh và ID playlist uploads
        const channelTitle = channelData.items[0].snippet.title;
        const uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;

        if (!uploadsPlaylistId) {
             return response.status(404).json({ error: 'Kênh này không có video công khai nào.' });
        }

        // 5. Lấy 3 video mới nhất từ playlist "uploads" đó
        const videoUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=3&key=${API_KEY}`;
        
        const videoRes = await fetch(videoUrl);
        if (!videoRes.ok) {
            throw new Error(`Lỗi YouTube API (PlaylistItems): ${videoRes.statusText}`);
        }
        
        const videoData = await videoRes.json();

        // 6. Trích xuất (map) thông tin cần thiết từ kết quả trả về
        const videos = videoData.items.map(item => ({
            id: item.snippet.resourceId.videoId, // ID của video
            title: item.snippet.title,          // Tiêu đề video
            publishedAt: item.snippet.publishedAt // Ngày đăng
        }));

        // 7. Trả dữ liệu về cho trang web (frontend)
        // Set header để cho phép caching phía trình duyệt trong 5 phút (300 giây)
        response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
        response.status(200).json({
            channelTitle: channelTitle,
            videos: videos
        });

    } catch (error) {
        // 8. Bắt và xử lý mọi lỗi xảy ra
        console.error('Lỗi trong Vercel function:', error);
        response.status(500).json({ error: 'Lỗi máy chủ nội bộ. Không thể tải video.' });
    }
}