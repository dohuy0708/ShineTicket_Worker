import axios from "axios";
import config from "../src/config.js";

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function joinUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = String(path || "").replace(/^\/+/, "");

  if (!normalizedBaseUrl) {
    return `/${normalizedPath}`;
  }

  if (normalizedBaseUrl.endsWith("/api") && normalizedPath.startsWith("api/")) {
    return `${normalizedBaseUrl.slice(0, -4)}/${normalizedPath}`;
  }

  return `${normalizedBaseUrl}/${normalizedPath}`;
}

function resolveCallbackUrl() {
  const callbackPath = config.relayerApi?.resultPath;

  if (!callbackPath) {
    throw new Error("Thiếu RELAYER_RESULT_PATH trong config");
  }

  if (isAbsoluteUrl(callbackPath)) {
    return callbackPath;
  }

  return joinUrl(config.backend.beApiUrl || config.backend.url, callbackPath);
}

function resolveCallbackSecret() {
  return (
    config.backend?.internalWebhookSecret ||
    config.webhook?.internalWebhookSecret
  );
}

async function main() {
  const callbackUrl = resolveCallbackUrl();
  const callbackSecret = resolveCallbackSecret();
  const timeoutMs = Number(process.env.RELAYER_CALLBACK_TIMEOUT_MS || 15000);

  console.log(`[PRECHECK] callbackUrl=${callbackUrl}`);
  console.log(`[PRECHECK] hasCallbackSecret=${Boolean(callbackSecret)}`);
  console.log(`[PRECHECK] timeoutMs=${timeoutMs}`);

  const payload = {
    orderId: `precheck-${Date.now()}`,
    orderCode: "PRECHECK",
    eventIds: [0],
    quantities: [0],
    buyerAddress: "0x0000000000000000000000000000000000000000",
    status: "success",
    txHash: "0xprecheck",
    tokenIds: [],
    source: "worker-relayer-precheck",
  };

  const startedAt = Date.now();

  try {
    const response = await axios.post(callbackUrl, payload, {
      headers: {
        "x-relayer-callback-secret": callbackSecret,
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    const durationMs = Date.now() - startedAt;

    console.log(`[PRECHECK] status=${response.status}`);
    console.log(`[PRECHECK] durationMs=${durationMs}`);
    console.log(`[PRECHECK] body=${JSON.stringify(response.data)}`);

    if (response.status >= 200 && response.status < 300) {
      console.log(
        "[PRECHECK] OK: callback endpoint reachable và phản hồi thành công.",
      );
      process.exit(0);
    }

    console.error(
      "[PRECHECK] FAIL: endpoint reachable nhưng trả về status lỗi.",
    );
    process.exit(2);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    console.error(`[PRECHECK] ERROR message=${error.message}`);
    console.error(`[PRECHECK] ERROR code=${error.code || "unknown"}`);
    console.error(`[PRECHECK] durationMs=${durationMs}`);
    process.exit(1);
  }
}

main();
