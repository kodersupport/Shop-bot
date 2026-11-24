require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const BIN_ID = process.env.BIN_ID;
const MASTER_KEY = process.env.MASTER_KEY;

if (!BOT_TOKEN || !BIN_ID || !MASTER_KEY) {
  console.error('Thiếu BOT_TOKEN, BIN_ID hoặc MASTER_KEY');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;
const headers = {
  'Content-Type': 'application/json',
  'X-Master-Key': MASTER_KEY
};

async function getData() {
  try {
    const res = await axios.get(`${JSONBIN_URL}/latest`, { headers });
    return res.data.record;
  } catch (err) {
    console.error('Lỗi đọc JSONBin:', err.message);
    return null;
  }
}

async function saveData(data) {
  try {
    await axios.put(JSONBIN_URL, data, { headers });
    return true;
  } catch (err) {
    console.error('Lỗi ghi JSONBin:', err.message);
    return false;
  }
}

function formatMoney(n) {
  return Number(n).toLocaleString('vi-VN') + 'đ';
}

function generateOrderId() {
  return 'ORD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function createVietQRUrl(bank, amount, addInfo) {
  const base = `https://img.vietqr.io/image/${bank.bin}-${bank.accountNo}-compact2.png`;
  const params = new URLSearchParams({
    amount: String(amount),
    addInfo: addInfo || 'Thanh toan don hang',
    accountName: bank.accountName || ''
  });
  return `${base}?${params.toString()}`;
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const data = await getData();
  if (!data) return bot.sendMessage(chatId, 'Hệ thống đang bảo trì, vui lòng thử lại sau.');

  const products = data.products || [];
  if (products.length === 0) {
    return bot.sendMessage(chatId, 'Hiện chưa có sản phẩm nào.');
  }

  let text = '🛒 *DANH SÁCH SẢN PHẨM*\n\n';
  const keyboard = [];

  products.forEach((p) => {
    const totalStock = (p.variants || []).reduce((s, v) => s + (v.stock || 0), 0);
    text += `• *${p.name}* (còn ${totalStock})\n`;
    keyboard.push([{ text: `${p.name} (còn ${totalStock})`, callback_data: `prod_${p.id}` }]);
  });

  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.onText(/\/checkid/, (msg) => {
  bot.sendMessage(msg.chat.id, `🆔 Telegram User ID của bạn là:\n\n\`${msg.from.id}\``, {
    parse_mode: 'Markdown'
  });
});

bot.onText(/\/orders/, async (msg) => {
  const data = await getData();
  if (!data) return;

  const adminIds = (data.adminIds || []).map(String);
  if (!adminIds.includes(String(msg.from.id))) {
    return bot.sendMessage(msg.chat.id, 'Bạn không phải Admin.');
  }

  const pending = (data.orders || []).filter(o => o.status === 'pending');
  if (pending.length === 0) {
    return bot.sendMessage(msg.chat.id, 'Không có đơn nào đang chờ duyệt.');
  }

  let text = `📋 *Đơn chờ duyệt (${pending.length})*\n\n`;
  pending.slice(0, 10).forEach((o, i) => {
    text += `${i + 1}. ${o.id}\n${o.productName} - ${o.variantName}\n${formatMoney(o.price)}\n\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const dataCb = query.data;
  const data = await getData();
  if (!data) {
    bot.answerCallbackQuery(query.id, { text: 'Lỗi hệ thống' });
    return;
  }

  if (dataCb.startsWith('prod_')) {
    const prodId = dataCb.replace('prod_', '');
    const product = (data.products || []).find(p => p.id === prodId);
    if (!product) return bot.answerCallbackQuery(query.id, { text: 'Sản phẩm không tồn tại' });

    const variants = product.variants || [];
    let text = `📦 *${product.name}*\n\nChọn loại:\n\n`;
    const keyboard = [];

    variants.forEach(v => {
      text += `• ${v.name}: ${formatMoney(v.price)} (còn ${v.stock})\n`;
      if (v.stock > 0) {
        keyboard.push([{ text: `${v.name} - ${formatMoney(v.price)}`, callback_data: `var_${prodId}_${v.id}` }]);
      } else {
        keyboard.push([{ text: `${v.name} (Hết hàng)`, callback_data: 'noop' }]);
      }
    });

    keyboard.push([{ text: '« Quay lại', callback_data: 'back_start' }]);

    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (dataCb.startsWith('var_')) {
    const parts = dataCb.split('_');
    const prodId = parts[1];
    const varId = parts[2];

    const product = (data.products || []).find(p => p.id === prodId);
    const variant = product ? (product.variants || []).find(v => v.id === varId) : null;

    if (!product || !variant || variant.stock <= 0) {
      return bot.answerCallbackQuery(query.id, { text: 'Sản phẩm hết hàng' });
    }

    const bank = data.bank || {};
    if (!bank.bin || !bank.accountNo) {
      return bot.answerCallbackQuery(query.id, { text: 'Chưa cấu hình ngân hàng' });
    }

    const orderId = generateOrderId();
    const addInfo = `DH ${orderId}`;
    const qrUrl = createVietQRUrl(bank, variant.price, addInfo);

    const newOrder = {
      id: orderId,
      userId: userId,
      username: query.from.username || '',
      firstName: query.from.first_name || '',
      productId: prodId,
      variantId: varId,
      productName: product.name,
      variantName: variant.name,
      price: variant.price,
      status: 'waiting_payment',
      key: null,
      createdAt: new Date().toISOString()
    };

    data.orders = data.orders || [];
    data.orders.push(newOrder);
    await saveData(data);

    const caption = `💳 *THANH TOÁN ĐƠN HÀNG*\n\n` +
      `📦 Sản phẩm: *${product.name} - ${variant.name}*\n` +
      `💰 Số tiền: *${formatMoney(variant.price)}*\n` +
      `🆔 Mã đơn: \`${orderId}\`\n\n` +
      `Ngân hàng: ${bank.bankName || ''}\n` +
      `STK: \`${bank.accountNo}\`\n` +
      `Chủ TK: ${bank.accountName || ''}\n\n` +
      `Nội dung CK: \`${addInfo}\`\n\n` +
      `Quét mã QR bên dưới, sau đó bấm *Đã thanh toán*.`;

    bot.sendPhoto(chatId, qrUrl, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '✅ Đã thanh toán', callback_data: `paid_${orderId}` }]]
      }
    });

    bot.answerCallbackQuery(query.id);
    return;
  }

  if (dataCb.startsWith('paid_')) {
    const orderId = dataCb.replace('paid_', '');
    const order = (data.orders || []).find(o => o.id === orderId);

    if (!order || order.status !== 'waiting_payment') {
      return bot.answerCallbackQuery(query.id, { text: 'Đơn đã được xử lý' });
    }

    order.status = 'pending';
    order.paidAt = new Date().toISOString();
    await saveData(data);

    bot.editMessageCaption(
      `⏳ *VUI LÒNG CHỜ ADMIN DUYỆT TRONG ÍT PHÚT…*\n\nMã đơn: \`${orderId}\`\nSản phẩm: ${order.productName} - ${order.variantName}\nSố tiền: ${formatMoney(order.price)}`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      }
    ).catch(() => {});

    const adminIds = data.adminIds || [];
    const notifyText = `🔔 *ĐƠN HÀNG MỚI CẦN DUYỆT*\n\n` +
      `🆔 Mã: \`${order.id}\`\n` +
      `👤 ${order.firstName} (@${order.username || 'none'}) - ID: ${order.userId}\n` +
      `📦 ${order.productName} - ${order.variantName}\n` +
      `💰 ${formatMoney(order.price)}`;

    for (const aid of adminIds) {
      try {
        await bot.sendMessage(aid, notifyText, { parse_mode: 'Markdown' });
      } catch (e) {}
    }

    bot.answerCallbackQuery(query.id, { text: 'Đã gửi yêu cầu duyệt' });
    return;
  }

  if (dataCb === 'back_start') {
    const products = data.products || [];
    let text = '🛒 *DANH SÁCH SẢN PHẨM*\n\n';
    const keyboard = [];
    products.forEach((p) => {
      const totalStock = (p.variants || []).reduce((s, v) => s + (v.stock || 0), 0);
      text += `• *${p.name}* (còn ${totalStock})\n`;
      keyboard.push([{ text: `${p.name} (còn ${totalStock})`, callback_data: `prod_${p.id}` }]);
    });
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    bot.answerCallbackQuery(query.id);
  }

  if (dataCb === 'noop') {
    bot.answerCallbackQuery(query.id, { text: 'Hết hàng' });
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('Bot đã khởi động thành công!');
