// api/send-test-email.mjs
import { Resend } from "resend";

export default async function handler(req, res) {
  try {
    // Khởi tạo Resend bằng API Key
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Gửi email test
    const data = await resend.emails.send({
      from: process.env.NOTIFY_EMAIL_FROM,        // vd: "YouTube Tracker <admin@no1ideas.us>"
      to: process.env.NOTIFY_EMAIL_TO,            // vd: "mangomeo.no1ideas@gmail.com"
      subject: "✅ Test Email từ YouTube Tracker",
      html: `
        <h2>Xin chào 👋</h2>
        <p>🎉 Hệ thống gửi mail bằng Resend đã hoạt động thành công.</p>
        <p>Trân trọng,<br><b>Hệ thống YouTube Tracker</b></p>
  _   `
    });

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("❌ Lỗi khi gửi mail:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}