# 📋 Queue Names - Hướng dẫn cho Backend Developer

## ⚠️ QUAN TRỌNG: Queue Name PHẢI khớp giữa Backend và Worker

Nếu Backend push job vào queue name **A**, nhưng Worker lắng nghe queue name **B**, job sẽ không bao giờ được xử lý!

---

## 🔧 Queue Names hiện tại

### 1. **Relayer Buy Queue**

- **Tên Queue:** `relayer-buy-queue` (mặc định)
- **Có thể override:** `RELAYER_QUEUE_NAME` env var
- **Mục đích:** Xử lý mua vé hộ khách (VND)
- **Job Data format:**
  ```json
  {
    "orderId": "order-123",
    "eventIds": [1, 2, 3],
    "quantities": [1, 2, 1],
    "buyerAddress": "0x7Aa...",
    "totalPrice": "500000" // ← Bắt buộc!
  }
  ```

### 2. **Check-in Queue**

- **Tên Queue:** `checkin-queue` (mặc định)
- **Có thể override:** `CHECKIN_QUEUE_NAME` env var
- **Mục đích:** Check-in vé (đánh dấu đã sử dụng)
- **Job Data format:**
  ```json
  {
    "ticketId": 123
  }
  ```

### 3. **Expire Queue**

- **Tên Queue:** `expire-queue` (mặc định)
- **Có thể override:** `EXPIRE_QUEUE_NAME` env var
- **Mục đích:** Auto check-in cho vé đã qua ngày diễn
- **Job Data format:**
  ```json
  {
    "ticketIds": [1, 2, 3, 4],
    "showId": "show-456" // Optional
  }
  ```

### 4. **Gas-Fund Queue** ⭐

- **Tên Queue:** `gas-fund-queue` (mặc định)
- **Có thể override:** `GAS_FUND_QUEUE_NAME` env var
- **Mục đích:** Cấp tiền gas (POL) cho khách hàng
- **Job Data format:**
  ```json
  {
    "walletAddress": "0x7Aa045901Ac034121fFEAdD9bfE7B907a5e2B481"
  }
  ```

---

## 🚨 Vấn đề thường gặp

### **Lỗi 1: Job không được xử lý**

**Nguyên nhân:**

- Backend push job vào tên queue khác
- Worker lắng nghe tên queue khác

**Cách khắc phục:**

```bash
# 1. Kiểm tra .env file
cat .env | grep QUEUE_NAME

# 2. Restart Worker
npm run dev

# 3. Kiểm tra log Worker (sẽ in ra queue names):
# 📋 === QUEUE CONFIGURATION ===
# 📨 Gas-Fund Queue: gas-fund-queue
```

### **Lỗi 2: Job bị kẹt (Stalled Job)**

**Nguyên nhân:**

- Worker bị tắt đột ngột khi đang xử lý job
- Job vẫn đánh dấu là "active" trong Redis

**Cách khắc phục:**

- Worker tự động phát hiện stalled jobs (mỗi 5 giây)
- Sẽ log: `⚠️ [GAS-FUND] Phát hiện Job ... bị kẹt (stalled)`
- Job sẽ được xử lý lại tự động (tối đa 2 lần)

---

## 📝 Backend Implementation Example

### **Enqueue Gas-Fund Job** (Node.js + BullMQ)

```javascript
const { Queue } = require("bullmq");
const redis = require("redis");

const client = redis.createClient({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
});

const gasFundQueue = new Queue("gas-fund-queue", {
  connection: client,
});

// Thêm job để cấp gas cho khách
await gasFundQueue.add(
  `gas-${walletAddress}-${Date.now()}`, // Job ID (unique)
  {
    walletAddress: "0x7Aa045901Ac034121fFEAdD9bfE7B907a5e2B481",
  },
  {
    removeOnComplete: true,
    removeOnFail: false,
  },
);
```

### **Listen để webhook callback**

```javascript
// Backend route: POST /api/v1/webhooks/gas-callback
app.post("/api/v1/webhooks/gas-callback", (req, res) => {
  const { jobId, walletAddress, status, reason, txHash } = req.body;

  console.log(`Gas Fund Job ${jobId}: ${status}`);
  // Update database, notify FE, etc.

  res.json({ success: true });
});
```

---

## 🎯 Checklist trước khi deploy

- [ ] Backend sử dụng đúng tên queue: `gas-fund-queue`
- [ ] Backend gửi đủ fields: `walletAddress`
- [ ] Worker env vars khớp với Backend
- [ ] Webhook endpoint được implement: `/api/v1/webhooks/gas-callback`
- [ ] Webhook nhận được `jobId` + `status` từ Worker
- [ ] Test end-to-end: Backend → Queue → Worker → Webhook → FE

---

## 📞 Support

Nếu gặp vấn đề:

1. Kiểm tra Worker logs (terminal)
2. Kiểm tra Redis (dùng Redis CLI hoặc GUI tool)
3. Kiểm tra Backend webhook endpoint
4. Liên hệ: [Developer Email]
