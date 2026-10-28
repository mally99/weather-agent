// סוכן מזג אוויר: בודק תחזית (Open-Meteo), מנסח המלצת לבוש, ושולח התראה לטלפון (ntfy)
// הרצה: npx tsx weather-agent.ts   (Node 20+)

const TZ = "Asia/Jerusalem";
const LAT = process.env.LAT ?? "32.0853"; // תל אביב
const LON = process.env.LON ?? "34.7818";
const CITY = process.env.CITY ?? "תל אביב";

const NTFY_TOPIC = process.env.NTFY_TOPIC; // שם נושא ארוך וייחודי, למשל maly-weather-8f3k
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY; // אופציונלי
const FORCE_MODE = process.env.FORCE_MODE as Mode | undefined; // morning | evening

type Mode = "morning" | "evening";

interface Day {
  tMax: number;
  tMin: number;
  feelsMax: number;
  feelsMin: number;
  rainProb: number;
  rainMm: number;
  wind: number;
  uv: number;
}

// --- איזה מצב להריץ, לפי שעון ישראל ---
function getMode(): Mode | null {
  if (FORCE_MODE) return FORCE_MODE;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  const mins = h * 60 + m;
  if (mins >= 6 * 60 + 25 && mins < 7 * 60 + 30) return "morning";
  if (mins >= 21 * 60 && mins < 22 * 60) return "evening";
  return null;
}

// --- תחזית ---
async function getWeather(mode: Mode): Promise<Day> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: LAT,
    longitude: LON,
    timezone: TZ,
    forecast_days: "2",
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "apparent_temperature_max",
      "apparent_temperature_min",
      "precipitation_probability_max",
      "precipitation_sum",
      "wind_speed_10m_max",
      "uv_index_max",
    ].join(","),
  }).toString();

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo: ${res.status}`);
  const d = (await res.json()).daily;
  const i = mode === "morning" ? 0 : 1; // בערב מציגים את מחר
  return {
    tMax: d.temperature_2m_max[i],
    tMin: d.temperature_2m_min[i],
    feelsMax: d.apparent_temperature_max[i],
    feelsMin: d.apparent_temperature_min[i],
    rainProb: d.precipitation_probability_max[i] ?? 0,
    rainMm: d.precipitation_sum[i] ?? 0,
    wind: d.wind_speed_10m_max[i],
    uv: d.uv_index_max[i],
  };
}

// --- המלצת לבוש לפי חוקים (גיבוי) ---
function outfitByRules(w: Day): string {
  const items: string[] = [];
  const feel = (w.feelsMax + w.feelsMin) / 2;

  if (feel < 12) items.push("מעיל חם");
  else if (feel < 17) items.push("מעיל או ג'קט + שכבה ארוכה");
  else if (feel < 22) items.push("סווטשירט או שכבה אחת נוספת");
  else if (feel < 28) items.push("חולצה קצרה");
  else items.push("בגדים קלים ונושמים");

  if (w.tMax - w.tMin >= 8) items.push("כדאי שכבה שאפשר להסיר בצהריים");
  if (w.rainProb >= 40 || w.rainMm >= 1) items.push("מטרייה או מעיל גשם ☔");
  if (w.uv >= 7) items.push("משקפי שמש וקרם הגנה 🕶️");
  if (w.wind >= 30) items.push("משהו חוסם רוח");
  return items.join(", ");
}

// --- ניסוח עם Claude (אופציונלי) ---
async function composeWithLLM(w: Day, mode: Mode): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: `כתוב הודעת וואטסאפ קצרה בעברית (עד 5 שורות, עם אימוג'י מעטים) על מזג האוויר ${
              mode === "morning" ? "להיום" : "למחר"
            } ב${CITY}, כולל המלצה מה ללבוש. אל תמציא נתונים.\nנתונים: ${JSON.stringify(w)}\n(טמפרטורות במעלות צלזיוס, רוח בקמ"ש, גשם במ"מ)`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.find((b: any) => b.type === "text")?.text;
    return text?.trim() || null;
  } catch {
    return null;
  }
}

function composeByRules(w: Day, mode: Mode): string {
  const title = mode === "morning" ? "בוקר טוב ☀️ מזג האוויר להיום" : "ערב טוב 🌙 התחזית למחר";
  return [
    `${title} ב${CITY}:`,
    `🌡️ ${Math.round(w.tMin)}°–${Math.round(w.tMax)}° (מרגיש ${Math.round(w.feelsMin)}°–${Math.round(w.feelsMax)}°)`,
    `🌧️ סיכוי לגשם: ${Math.round(w.rainProb)}%`,
    `💨 רוח עד ${Math.round(w.wind)} קמ"ש | UV ${Math.round(w.uv)}`,
    `👕 ללבוש: ${outfitByRules(w)}`,
  ].join("\n");
}

// --- שליחת התראה דרך ntfy ---
async function sendNotification(text: string, mode: Mode) {
  if (!NTFY_TOPIC) throw new Error("חסר NTFY_TOPIC");
  const res = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title: mode === "morning" ? "מזג האוויר להיום" : "מזג האוויר למחר",
      message: text,
      tags: [mode === "morning" ? "sunny" : "crescent_moon"],
    }),
  });
  if (!res.ok) throw new Error(`ntfy: ${res.status} ${await res.text()}`);
}

async function main() {
  const mode = getMode();
  if (!mode) {
    console.log("לא בחלון הזמן המתאים, יוצא.");
    return;
  }
  const weather = await getWeather(mode);
  const message = (await composeWithLLM(weather, mode)) ?? composeByRules(weather, mode);
  console.log(message);
  await sendNotification(message, mode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});