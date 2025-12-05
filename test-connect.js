import { verifyConnection } from "./src/blockchain.js";
async function main() {
  console.log("--- BẮT ĐẦU KIỂM TRA KẾT NỐI ---");
  const isConnected = await verifyConnection();

  if (isConnected) {
    console.log("--- KẾT QUẢ: TỐT ✅ ---");
    console.log("Worker đã sẵn sàng giao tiếp với Smart Contract.");
  } else {
    console.log("--- KẾT QUẢ: THẤT BẠI ❌ ---");
    console.log("Vui lòng kiểm tra lại file .env (RPC, Private Key, Address)");
  }
}

main();
