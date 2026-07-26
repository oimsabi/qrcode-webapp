# QR Code Generator & Reader

เว็บแอปสร้างและอ่าน QR Code ทำงานฝั่งไคลเอนต์ทั้งหมด ไม่ต้องมีเซิร์ฟเวอร์หรือฐานข้อมูล
https://oimsabi.github.io/qrcode-webapp/

## ฟีเจอร์

- **สร้าง QR Code** จากข้อความ/ลิงก์ เลือกขนาดและระดับแก้ไขข้อผิดพลาดได้ ดาวน์โหลดเป็น PNG
- **อ่าน QR Code** จากกล้อง (แบบเรียลไทม์) หรือจากไฟล์รูปภาพที่อัปโหลด

## การใช้งาน

เปิด `index.html` ในเบราว์เซอร์ได้โดยตรง หรือรันเซิร์ฟเวอร์ static ง่าย ๆ:

```bash
npx serve .
```

หรือ deploy ผ่าน GitHub Pages โดยเปิดใช้งานใน Settings > Pages ของ repo แล้วเลือก branch ที่ต้องการ

## เทคโนโลยี

- Vanilla HTML/CSS/JavaScript ไม่มี build step
- [qrcode](https://github.com/soldair/node-qrcode) สำหรับสร้าง QR Code
- [jsQR](https://github.com/cozmo/jsQR) สำหรับอ่าน QR Code

หมายเหตุ: การสแกนด้วยกล้องต้องเปิดผ่าน HTTPS หรือ `localhost` เนื่องจาก `getUserMedia` มีข้อจำกัดด้านความปลอดภัยของเบราว์เซอร์
