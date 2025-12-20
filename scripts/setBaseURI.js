// scripts/setBaseURI.js
const { ethers } = require("ethers");
require("dotenv").config();

async function main() {
  // 1. Kết nối ví
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  // 2. Kết nối Contract
  // (Cần có ABI của contract, file JSON artifacts)
  const contractABI =
    require("../artifacts/contracts/ShineTicket.sol/ShineTicket.json").abi;
  const contract = new ethers.Contract(
    process.env.CONTRACT_ADDRESS,
    contractABI,
    wallet
  );

  // 3. Đặt URL của Backend (Nhớ dấu / ở cuối)
  // Ví dụ Backend chạy Ngrok: https://abcd-123.ngrok-free.app/api/nft/
  const newBaseURI = "https://YOUR_BACKEND_DOMAIN/api/nft/";

  console.log(`Updating BaseURI to: ${newBaseURI}`);

  const tx = await contract.setBaseURI(newBaseURI);
  await tx.wait();

  console.log("✅ Update BaseURI thành công!");
}

main();
