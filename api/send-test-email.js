import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  try {
    const data = await resend.emails.send({
      from: process.env.NOTIFY_EMAIL_FROM,
      to: process.env.NOTIFY_EMAIL_TO,
      subject: "✅ Test Email từ YouTube Tracker",
      html: "<p>Xin chào! 🎉 Hệ thống gửi mail bằng Resend đã hoạt động thành công.</p>",
    });

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("❌ Lỗi khi gửi mail:", error);
    res.status(500).json({ success: false, error });
  }
}
