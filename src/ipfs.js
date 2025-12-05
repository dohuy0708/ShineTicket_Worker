import axios from "axios";
import FormData from "form-data";
import config from "./config.js";

/**
 * Hàm upload JSON Metadata hoặc File lên Pinata
 * @param {Object} data - Dữ liệu JSON cần lưu (Ví dụ: thông tin vé)
 * @returns {string} - Trả về IPFS Hash (CID)
 */
export async function uploadJSONToIPFS(data) {
  try {
    const url = `https://api.pinata.cloud/pinning/pinJSONToIPFS`;

    const response = await axios.post(url, data, {
      headers: {
        pinata_api_key: config.ipfs.pinataApiKey,
        pinata_secret_api_key: config.ipfs.pinataSecretKey,
      },
    });

    console.log("☁️ [IPFS] Upload JSON thành công:", response.data.IpfsHash);
    return response.data.IpfsHash;
  } catch (error) {
    console.error("❌ [IPFS] Lỗi upload Pinata:", error.message);
    return null; // Trả về null để logic chính biết đường xử lý
  }
}

/**
 * (Nâng cao) Hàm upload file ảnh (Buffer) lên IPFS
 * Dùng khi bạn muốn generate ảnh vé dynamic có tên người mua
 */
/*
export async function uploadFileToIPFS(fileBuffer, fileName) {
    // Logic upload file dùng FormData...
    // Để dành làm sau nếu cần tính năng render ảnh vé
}
*/
