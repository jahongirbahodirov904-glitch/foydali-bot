require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = (process.env.WEBAPP_URL || "").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN .env faylida kiritilmagan.");
  process.exit(1);
}
if (!WEBAPP_URL) {
  console.error("WEBAPP_URL .env faylida kiritilmagan.");
  process.exit(1);
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);
const DATA_FILE = path.join(__dirname, "data.json");
app.use(express.json({ limit: "30kb" }));
app.use(express.static(path.join(__dirname, "public")));

function readData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.users) return parsed;
  } catch (_) {}
  return { users: {} };
}
let db = readData();
let saveQueue = Promise.resolve();
function saveData() {
  // Serialize writes to avoid overlapping file writes.
  saveQueue = saveQueue.then(() => fs.promises.writeFile(DATA_FILE, JSON.stringify(db, null, 2)));
  return saveQueue;
}
function userPlans(userId) {
  const key = String(userId);
  if (!db.users[key]) db.users[key] = { plans: [] };
  if (!Array.isArray(db.users[key].plans)) db.users[key].plans = [];
  return db.users[key].plans;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

// Verify Telegram Mini App initData in production.
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400 || authDate > Date.now() / 1000 + 60) return null;
  try {
    const user = JSON.parse(params.get("user") || "{}");
    return user.id ? String(user.id) : null;
  } catch (_) {
    return null;
  }
}

function requireTelegramUser(req, res, next) {
  const initData = req.get("x-telegram-init-data") || "";
  const verifiedId = verifyInitData(initData);
  if (verifiedId) {
    req.userId = verifiedId;
    return next();
  }
  // Local development only. Never enable this fallback in production.
  if (!IS_PRODUCTION && req.get("x-dev-user") === "123456") {
    req.userId = "123456";
    return next();
  }
  return res.status(401).json({ error: "Telegram ichidan oching yoki qayta kiring." });
}

bot.start(async ctx => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.webApp("📅 LIFE MANAGER ni ochish", WEBAPP_URL)]
  ]);
  await ctx.reply(
    "👋 Salom! LIFE MANAGER ga xush kelibsiz.\n\n" +
    "📅 Rejalaringizni yozing, sana va vaqtni tanlang. Belgilangan vaqtda sizga eslatma yuboraman.\n\n" +
    "Mini-ilovani ochish uchun tugmani bosing.",
    keyboard
  );
});
bot.command("plans", async ctx => {
  const plans = userPlans(ctx.from.id).filter(p => !p.done).sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));
  if (!plans.length) return ctx.reply("Hozircha bajarilmagan rejangiz yo‘q. /start orqali mini-ilovani oching.");
  const lines = plans.slice(0, 20).map((p, i) => `${i+1}. ${escapeHtml(p.task)}\n   📅 ${p.date} · ${p.time}`);
  return ctx.reply("📋 Rejalaringiz:\n\n" + lines.join("\n\n"), { parse_mode: "HTML" });
});
bot.help(ctx => ctx.reply("Buyruqlar:\n/start — mini-ilovani ochish\n/plans — rejalaringizni ko‘rish\n\nEslatmalar uchun botni bloklamang."));
bot.catch(err => console.error("Telegram bot xatosi:", err));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api", requireTelegramUser);

app.get("/api/plans", (req, res) => {
  const plans = userPlans(req.userId).sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));
  res.json({ plans });
});

app.post("/api/plans", async (req, res) => {
  const task = String(req.body.task || "").trim();
  const date = String(req.body.date || "");
  const time = String(req.body.time || "");
  if (!task || task.length > 160) return res.status(400).json({ error: "Reja 1–160 ta belgidan iborat bo‘lsin." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: "Sana yoki vaqt noto‘g‘ri." });
  }
  const target = new Date(`${date}T${time}:00`);
  if (Number.isNaN(target.getTime()) || target.getTime() <= Date.now()) {
    return res.status(400).json({ error: "Kelajakdagi sana va vaqtni tanlang." });
  }
  const plan = {
    id: crypto.randomUUID(),
    task, date, time,
    done: false,
    notified: false,
    createdAt: new Date().toISOString()
  };
  userPlans(req.userId).push(plan);
  await saveData();
  res.status(201).json({ plan });
});

app.patch("/api/plans/:id", async (req, res) => {
  const plans = userPlans(req.userId);
  const plan = plans.find(p => p.id === req.params.id);
  if (!plan) return res.status(404).json({ error: "Reja topilmadi." });
  if (typeof req.body.done === "boolean") plan.done = req.body.done;
  await saveData();
  res.json({ plan });
});

app.delete("/api/plans/:id", async (req, res) => {
  const plans = userPlans(req.userId);
  const index = plans.findIndex(p => p.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Reja topilmadi." });
  plans.splice(index, 1);
  await saveData();
  res.json({ ok: true });
});

// Check due reminders regularly. Dates/times use the server's configured timezone.
// Set the hosting environment timezone to Asia/Tashkent for Uzbekistan users.
let checking = false;
async function checkReminders() {
  if (checking) return;
  checking = true;
  try {
    const now = Date.now();
    let changed = false;
    for (const [userId, record] of Object.entries(db.users)) {
      for (const plan of (record.plans || [])) {
        const due = new Date(`${plan.date}T${plan.time}:00`).getTime();
        if (!plan.done && !plan.notified && Number.isFinite(due) && due <= now) {
          // Mark first so restarts are less likely to send duplicates.
          plan.notified = true;
          plan.notifiedAt = new Date().toISOString();
          changed = true;
          await saveData();
          try {
            await bot.telegram.sendMessage(
              userId,
              `🔔 <b>Eslatma!</b>\n\n📝 ${escapeHtml(plan.task)}\n📅 ${plan.date} · ${plan.time}\n\nRejangiz vaqti keldi!`,
              { parse_mode: "HTML", ...Markup.inlineKeyboard([
                [Markup.button.callback("✅ Bajarildi", `done:${plan.id}`)],
                [Markup.button.callback("⏳ 10 daqiqadan keyin", `snooze:${plan.id}`)]
              ]) }
            );
          } catch (err) {
            console.error(`Eslatma yuborilmadi (${userId}):`, err.message);
            // Do not loop forever if the user blocked the bot or Telegram rejects the message.
          }
        }
      }
    }
    if (changed) await saveData();
  } finally {
    checking = false;
  }
}
bot.action(/^done:(.+)$/, async ctx => {
  const planId = ctx.match[1];
  const plans = userPlans(ctx.from.id);
  const plan = plans.find(p => p.id === planId);
  if (plan) { plan.done = true; await saveData(); }
  await ctx.answerCbQuery("Bajarildi deb belgilandi ✅");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(plan ? `✅ “${plan.task}” bajarildi!` : "Reja topilmadi.");
});
bot.action(/^snooze:(.+)$/, async ctx => {
  const plan = userPlans(ctx.from.id).find(p => p.id === ctx.match[1]);
  if (plan) {
    const next = new Date(Date.now() + 10 * 60 * 1000);
    plan.date = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,"0")}-${String(next.getDate()).padStart(2,"0")}`;
    plan.time = `${String(next.getHours()).padStart(2,"0")}:${String(next.getMinutes()).padStart(2,"0")}`;
    plan.notified = false;
    await saveData();
  }
  await ctx.answerCbQuery("10 daqiqaga kechiktirildi ⏳");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
});

app.listen(PORT, () => console.log(`LIFE MANAGER web server ${PORT}-portda ishga tushdi.`));
bot.launch().then(() => console.log("LIFE MANAGER Telegram bot ishga tushdi.")).catch(err => {
  console.error("Botni ishga tushirib bo‘lmadi:", err);
  process.exit(1);
});
setInterval(checkReminders, 15000);
checkReminders().catch(console.error);

async function shutdown(signal) {
  console.log(`${signal}: to‘xtatilmoqda...`);
  bot.stop(signal);
  await saveData().catch(console.error);
  process.exit(0);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
