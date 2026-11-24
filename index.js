require("dotenv").config();

const axios = require("axios");

// ==================================================
// CONFIG
// ==================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const BIN_ID = process.env.BIN_ID || process.env.JSONBIN_BIN_ID;
const MASTER_KEY =
  process.env.MASTER_KEY || process.env.JSONBIN_MASTER_KEY;

const SHOP_NAME = process.env.SHOP_NAME || "SHOP";

const BANK_CODE = process.env.BANK_CODE || "";
const BANK_ACCOUNT = process.env.BANK_ACCOUNT || "";
const BANK_ACCOUNT_NAME = process.env.BANK_ACCOUNT_NAME || "";

if (!BOT_TOKEN) throw new Error("Thiếu BOT_TOKEN");
if (!BIN_ID) throw new Error("Thiếu BIN_ID");
if (!MASTER_KEY) throw new Error("Thiếu MASTER_KEY");

// ==================================================
// HTTP CLIENTS
// ==================================================

const telegram = axios.create({
  baseURL: `https://api.telegram.org/bot${BOT_TOKEN}`,
  timeout: 45000
});

const jsonbin = axios.create({
  baseURL: `https://api.jsonbin.io/v3/b/${BIN_ID}`,
  timeout: 20000,
  headers: {
    "Content-Type": "application/json",
    "X-Master-Key": MASTER_KEY
  }
});

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function telegramError(err) {
  return (
    err?.response?.data?.description ||
    err?.message ||
    "Lỗi Telegram"
  );
}

function telegramCode(err) {
  return Number(err?.response?.data?.error_code || 0);
}

function retryAfter(err) {
  return Number(
    err?.response?.data?.parameters?.retry_after || 0
  );
}

// ==================================================
// TELEGRAM API
// ==================================================

async function tg(method, payload = {}) {
  let attempts = 0;

  while (true) {
    try {
      const response = await telegram.post(`/${method}`, payload);

      if (!response.data?.ok) {
        throw new Error(
          response.data?.description || `Telegram ${method} lỗi`
        );
      }

      return response.data.result;
    } catch (err) {
      attempts++;

      const code = telegramCode(err);
      const waitSeconds = retryAfter(err);

      if (code === 429 && waitSeconds > 0) {
        const waitMs = waitSeconds * 1000 + 1500;

        console.warn(
          `Telegram giới hạn 429. Chờ ${waitSeconds + 1} giây.`
        );

        await sleep(waitMs);
        continue;
      }

      if (attempts < 5 && [500, 502, 503, 504].includes(code)) {
        await sleep(attempts * 3000);
        continue;
      }

      throw err;
    }
  }
}

async function sendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function answerCallback(callbackId, text = "") {
  return tg("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text || undefined
  });
}

// ==================================================
// JSONBIN
// ==================================================

function normalizeData(data) {
  if (!data || typeof data !== "object") {
    data = {};
  }

  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.adminTelegramIds)) {
    data.adminTelegramIds = [];
  }

  if (!data.settings || typeof data.settings !== "object") {
    data.settings = {};
  }

  return data;
}

async function getData() {
  const response = await jsonbin.get("/latest");

  return normalizeData(response.data?.record);
}

let writeQueue = Promise.resolve();

function updateData(mutator) {
  const task = writeQueue.then(async () => {
    const data = await getData();

    await mutator(data);

    await jsonbin.put("", data);

    return data;
  });

  writeQueue = task.catch((err) => {
    console.error("JSONBin ghi dữ liệu lỗi:", err.message);
  });

  return task;
}

// ==================================================
// HELPERS
// ==================================================

function money(value) {
  return (Number(value) || 0).toLocaleString("vi-VN") + "đ";
}

function stockOf(type) {
  const stock = Number(type?.stock);
  return Number.isFinite(stock) ? Math.max(0, stock) : 0;
}

function findProduct(data, id) {
  return data.products.find(
    (product) => String(product.id) === String(id)
  );
}

function findType(product, id) {
  return (product?.types || []).find(
    (type) => String(type.id) === String(id)
  );
}

function userName(user) {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ") ||
    user.username ||
    "Khách hàng"
  );
}

function isAdmin(data, userId) {
  return data.adminTelegramIds.some(
    (id) => String(id) === String(userId)
  );
}

function makeOrderId() {
  return (
    Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 6).toUpperCase()
  );
}

function paymentInfo(data, order) {
  const settings = data.settings || {};

  const bankCode =
    settings.bankCode || settings.bank_code || BANK_CODE;

  const account =
    settings.bankAccount || settings.bank_account || BANK_ACCOUNT;

  const accountName =
    settings.bankAccountName ||
    settings.bank_account_name ||
    BANK_ACCOUNT_NAME;

  const amount = Number(order.price) || 0;
  const content = `DH ${order.id}`;

  let qr = "";

  if (bankCode && account) {
    qr =
      `https://img.vietqr.io/image/${encodeURIComponent(bankCode)}-${encodeURIComponent(account)}-compact2.png` +
      `?amount=${amount}` +
      `&addInfo=${encodeURIComponent(content)}` +
      `&accountName=${encodeURIComponent(accountName)}`;
  }

  return {
    bankCode,
    account,
    accountName,
    amount,
    content,
    qr
  };
}

// ==================================================
// ADMIN NOTIFICATION
// ==================================================

async function notifyAdmins(data, text) {
  for (const adminId of data.adminTelegramIds) {
    try {
      await sendMessage(adminId, text);
    } catch (err) {
      console.error(
        "Không gửi được thông báo admin:",
        err.message
      );
    }

    await sleep(1200);
  }
}

// ==================================================
// START MENU
// ==================================================

async function startCommand(message) {
  const chatId = message.chat.id;

  console.log("Đã nhận /start từ Telegram ID:", message.from.id);

  await sendMessage(
    chatId,
    `👋 Xin chào ${message.from.first_name || "bạn"}!\n\n` +
      `Chào mừng đến với ${SHOP_NAME}.\n\n` +
      `🛍 Bấm xem sản phẩm để bắt đầu mua hàng.\n` +
      `📦 Dùng /orders để xem đơn hàng.\n` +
      `🆔 Dùng /checkid để xem Telegram ID.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛍 XEM SẢN PHẨM",
              callback_data: "shop"
            }
          ],
          [
            {
              text: "📦 ĐƠN HÀNG CỦA TÔI",
              callback_data: "myorders"
            }
          ]
        ]
      }
    }
  );
}

// ==================================================
// PRODUCTS
// ==================================================

async function showProducts(chatId) {
  const data = await getData();

  const products = data.products.filter(
    (product) => product.active !== false
  );

  if (!products.length) {
    await sendMessage(chatId, "Hiện shop chưa có sản phẩm.");
    return;
  }

  const keyboard = products.map((product) => {
    const types = product.types || [];

    const prices = types.map((type) => Number(type.price) || 0);
    const minPrice = prices.length ? Math.min(...prices) : 0;

    return [
      {
        text: `${product.name} - từ ${money(minPrice)}`,
        callback_data: `product:${product.id}`
      }
    ];
  });

  await sendMessage(
    chatId,
    `🛍 ${SHOP_NAME}\n\nChọn sản phẩm bạn muốn mua:`,
    {
      reply_markup: {
        inline_keyboard: keyboard
      }
    }
  );
}

async function showTypes(chatId, productId) {
  const data = await getData();
  const product = findProduct(data, productId);

  if (!product || product.active === false) {
    await sendMessage(chatId, "Sản phẩm không tồn tại hoặc đã ngừng bán.");
    return;
  }

  const types = product.types || [];

  if (!types.length) {
    await sendMessage(chatId, "Sản phẩm chưa có loại/gói bán.");
    return;
  }

  const keyboard = types.map((type) => [
    {
      text:
        `${type.name} - ${money(type.price)}` +
        ` (Kho: ${stockOf(type)})`,
      callback_data: `type:${product.id}:${type.id}`
    }
  ]);

  keyboard.push([
    {
      text: "⬅️ Quay lại",
      callback_data: "shop"
    }
  ]);

  await sendMessage(
    chatId,
    `📦 ${product.name}\n\n` +
      `${product.description || "Không có mô tả."}\n\n` +
      `Chọn loại/gói:`,
    {
      reply_markup: {
        inline_keyboard: keyboard
      }
    }
  );
}

// ==================================================
// CREATE ORDER
// ==================================================

async function createOrder(chatId, user, productId, typeId) {
  let order;

  await updateData(async (data) => {
    const product = findProduct(data, productId);

    if (!product || product.active === false) {
      throw new Error("Sản phẩm không tồn tại hoặc đã ngừng bán.");
    }

    const type = findType(product, typeId);

    if (!type) {
      throw new Error("Loại/gói sản phẩm không tồn tại.");
    }

    if (stockOf(type) <= 0) {
      throw new Error("Loại/gói này đã hết hàng.");
    }

    order = {
      id: makeOrderId(),
      userId: user.id,
      username: user.username || "",
      customerName: userName(user),
      productId: product.id,
      productName: product.name,
      typeId: type.id,
      typeName: type.name,
      price: Number(type.price) || 0,
      status: "pending",
      createdAt: new Date().toISOString()
    };

    data.orders.push(order);
  });

  const data = await getData();
  const payment = paymentInfo(data, order);

  let text =
    `🧾 ĐƠN HÀNG ĐÃ TẠO\n\n` +
    `Mã đơn: ${order.id}\n` +
    `Sản phẩm: ${order.productName}\n` +
    `Loại/gói: ${order.typeName}\n` +
    `Số tiền: ${money(order.price)}\n\n`;

  if (payment.account) {
    text +=
      `🏦 Ngân hàng: ${payment.bankCode}\n` +
      `💳 Số tài khoản: ${payment.account}\n` +
      `👤 Chủ tài khoản: ${payment.accountName}\n` +
      `💰 Số tiền: ${money(payment.amount)}\n` +
      `📝 Nội dung: ${payment.content}\n\n` +
      `Chuyển khoản đúng số tiền và nội dung.`;
  } else {
    text += "Vui lòng liên hệ admin để nhận thông tin thanh toán.";
  }

  const buttons = {
    inline_keyboard: [
      [
        {
          text: "✅ ĐÃ THANH TOÁN",
          callback_data: `paid:${order.id}`
        }
      ],
      [
        {
          text: "📦 ĐƠN HÀNG CỦA TÔI",
          callback_data: "myorders"
        }
      ]
    ]
  };

  if (payment.qr) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: payment.qr,
      caption: text,
      reply_markup: buttons
    });
  } else {
    await sendMessage(chatId, text, {
      reply_markup: buttons
    });
  }

  await notifyAdmins(
    data,
    `🆕 ĐƠN HÀNG MỚI\n\n` +
      `Mã đơn: ${order.id}\n` +
      `Khách: ${order.customerName}\n` +
      `Telegram ID: ${order.userId}\n` +
      `Sản phẩm: ${order.productName}\n` +
      `Loại/gói: ${order.typeName}\n` +
      `Giá: ${money(order.price)}\n` +
      `Trạng thái: pending`
  );
}

// ==================================================
// CUSTOMER PAID
// ==================================================

async function markPaid(chatId, userId, orderId) {
  let order;

  await updateData(async (data) => {
    order = data.orders.find(
      (item) => String(item.id) === String(orderId)
    );

    if (!order) throw new Error("Không tìm thấy đơn hàng.");

    if (String(order.userId) !== String(userId)) {
      throw new Error("Bạn không có quyền thao tác đơn này.");
    }

    if (order.status !== "pending") {
      throw new Error("Đơn hàng không ở trạng thái chờ thanh toán.");
    }

    order.status = "waiting_confirm";
    order.paidRequestedAt = new Date().toISOString();
  });

  const data = await getData();

  await sendMessage(
    chatId,
    `✅ Đã gửi yêu cầu xác nhận thanh toán.\n\n` +
      `Mã đơn: ${order.id}\n\n` +
      `Vui lòng chờ admin kiểm tra và duyệt đơn.`
  );

  await notifyAdmins(
    data,
    `🔔 KHÁCH BÁO ĐÃ THANH TOÁN\n\n` +
      `Mã đơn: ${order.id}\n` +
      `Khách Telegram ID: ${order.userId}\n` +
      `Sản phẩm: ${order.productName}\n` +
      `Loại/gói: ${order.typeName}\n` +
      `Số tiền: ${money(order.price)}\n` +
      `Trạng thái: waiting_confirm\n\n` +
      `Vui lòng kiểm tra giao dịch và duyệt trong Admin Shop.`
  );
}

// ==================================================
// MY ORDERS
// ==================================================

async function showOrders(chatId, userId) {
  const data = await getData();

  const orders = data.orders
    .filter((order) => String(order.userId) === String(userId))
    .sort(
      (a, b) =>
        new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    )
    .slice(0, 10);

  if (!orders.length) {
    await sendMessage(chatId, "Bạn chưa có đơn hàng nào.");
    return;
  }

  const statuses = {
    pending: "Chờ thanh toán",
    waiting_confirm: "Chờ admin xác nhận",
    paid: "Đã thanh toán / hoàn tất",
    cancelled: "Đã hủy"
  };

  let text = "📦 ĐƠN HÀNG CỦA BẠN\n\n";

  for (const order of orders) {
    text +=
      `Mã đơn: ${order.id}\n` +
      `Sản phẩm: ${order.productName || ""}\n` +
      `Loại/gói: ${order.typeName || ""}\n` +
      `Giá: ${money(order.price)}\n` +
      `Trạng thái: ${statuses[order.status] || order.status}\n\n`;
  }

  await sendMessage(chatId, text);
}

// ==================================================
// UPDATE HANDLER
// ==================================================

async function handleMessage(message) {
  if (!message?.text) return;

  const text = message.text.trim();
  const chatId = message.chat.id;
  const userId = message.from.id;

  if (/^\/start(?:@\w+)?(?:\s.*)?$/i.test(text)) {
    await startCommand(message);
    return;
  }

  if (/^\/checkid(?:@\w+)?$/i.test(text)) {
    await sendMessage(chatId, `Telegram ID của bạn: ${userId}`);
    return;
  }

  if (/^\/orders(?:@\w+)?$/i.test(text)) {
    await showOrders(chatId, userId);
    return;
  }

  if (/^\/admin(?:@\w+)?$/i.test(text)) {
    const data = await getData();

    if (!isAdmin(data, userId)) {
      await sendMessage(chatId, "Bạn không phải admin.");
      return;
    }

    await sendMessage(
      chatId,
      `👑 Admin\n\nTelegram ID: ${userId}\nShop: ${SHOP_NAME}`
    );
  }
}

async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  const userId = query.from.id;
  const data = query.data || "";

  await answerCallback(query.id);

  if (!chatId) return;

  if (data === "shop") {
    await showProducts(chatId);
    return;
  }

  if (data === "myorders") {
    await showOrders(chatId, userId);
    return;
  }

  if (data.startsWith("product:")) {
    await showTypes(chatId, data.slice("product:".length));
    return;
  }

  if (data.startsWith("type:")) {
    const parts = data.split(":");

    await createOrder(
      chatId,
      query.from,
      parts[1],
      parts[2]
    );

    return;
  }

  if (data.startsWith("paid:")) {
    await markPaid(
      chatId,
      userId,
      data.slice("paid:".length)
    );
  }
}

async function processUpdate(update) {
  if (update.message) {
    await handleMessage(update.message);
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
}

// ==================================================
// POLLING LOOP
// ==================================================

let stopping = false;
let offset = 0;
let polling = false;

async function pollingLoop() {
  if (polling) {
    console.error("Polling đã chạy, không khởi động vòng thứ hai.");
    return;
  }

  polling = true;

  console.log("Bắt đầu nhận update từ Telegram...");

  while (!stopping) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });

      if (!Array.isArray(updates)) {
        await sleep(1000);
        continue;
      }

      for (const update of updates) {
        offset = update.update_id + 1;

        const incoming =
          update.message?.text ||
          update.callback_query?.data ||
          "update";

        console.log("NHẬN UPDATE:", incoming);

        try {
          await processUpdate(update);
        } catch (err) {
          console.error("Xử lý update lỗi:", err.message);
        }
      }
    } catch (err) {
      const code = telegramCode(err);
      const waitSeconds = retryAfter(err);

      if (code === 429 && waitSeconds > 0) {
        console.warn(
          `Telegram 429, chờ ${waitSeconds + 1} giây.`
        );

        await sleep(waitSeconds * 1000 + 1500);
        continue;
      }

      if (code === 409) {
        console.error(
          "Telegram 409: Có bot khác đang nhận update bằng token này. " +
          "Hãy dừng service cũ."
        );

        await sleep(15000);
        continue;
      }

      console.error("Polling lỗi:", telegramError(err));

      await sleep(5000);
    }
  }

  polling = false;
}

// ==================================================
// STARTUP
// ==================================================

async function start() {
  console.log("Đang kiểm tra Telegram...");

  const me = await tg("getMe");

  console.log(
    "Telegram kết nối thành công:",
    me.username ? `@${me.username}` : me.id
  );

  console.log("Đang xóa webhook cũ nếu có...");

  await tg("deleteWebhook", {
    drop_pending_updates: false
  });

  const webhook = await tg("getWebhookInfo");

  if (webhook.url) {
    throw new Error(
      "Webhook vẫn đang được thiết lập. Không thể dùng polling."
    );
  }

  await getData();

  console.log("JSONBin kết nối thành công.");
  console.log("Shop:", SHOP_NAME);
  console.log("Bot sẵn sàng. Hãy nhắn /start.");

  pollingLoop().catch((err) => {
    console.error("Polling dừng bất ngờ:", err.message);
    process.exit(1);
  });
}

process.on("SIGTERM", () => {
  stopping = true;
  console.log("Đang dừng bot...");
});

process.on("SIGINT", () => {
  stopping = true;
  console.log("Đang dừng bot...");
});

start().catch((err) => {
  console.error("KHÔNG KHỞI ĐỘNG ĐƯỢC:", telegramError(err));
  process.exit(1);
});
