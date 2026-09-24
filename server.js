// שרת API לשלוחת "בדיקת ברקוד" בימות המשיח
// התקנה:  npm init -y && npm i express yemot-router2
// הרצה:   node server.js   (נדרש Node 18 ומעלה)

const express = require('express');
const { YemotRouter } = require('yemot-router2');

// ---------- הגדרות ----------
const SHEET_ID = '1KivyNuDFy7cDJdg26MQz1IphnJfy60JN5706liLspMA';
const SHEET_URLS = [
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`,
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`,
];
const REFRESH_MS = 5 * 60 * 1000; // רענון הקובץ כל 5 דקות

// נתיבי ההקלטות שלך בשלוחה (בלי סיומת). שנה לפי שמות הקבצים שהעלית
const REC = {
  ENTER_BARCODE: '/1/001', // "נא להקיש ברקוד ובסיום סולמית"
  PLEASE_WAIT: '/1/002',   // "נא להמתין"
  RECOMMEND: '/1/003',     // "אנו ממליצים"
  NOT_RECOMMEND: '/1/004', // "אנו לא ממליצים"
};

// ---------- טעינת הקובץ מגוגל שיטס ----------
let products = new Map(); // ברקוד -> שם מוצר
let lastLoad = 0;

const normalize = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  row.push(cell); rows.push(row);
  return rows;
}

async function loadSheet() {
  if (Date.now() - lastLoad < REFRESH_MS && products.size) return;
  for (const url of SHEET_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = parseCsv(await res.text());
      const map = new Map();
      for (const [barcode, name] of rows) {
        const key = normalize(barcode);
        if (key.length >= 6) map.set(key, (name || '').trim());
      }
      if (map.size === 0) throw new Error('לא נמצאו ברקודים בקובץ');
      products = map;
      lastLoad = Date.now();
      console.log(`נטענו ${map.size} ברקודים`);
      return;
    } catch (e) {
      console.error('שגיאה בטעינת הקובץ:', e.message);
    }
  }
  // אם לא הצלחנו לטעון כלל, לא ממשיכים עם רשימה ריקה
  // (אחרת כל מוצר היה מקבל "אנו לא ממליצים" בטעות)
  if (products.size === 0) throw new Error('לא ניתן לקרוא את קובץ הברקודים מגוגל');
}

// שם המוצר ממאגר חיצוני פתוח (Open Food Facts). אם לא נמצא - מחזיר טקסט ריק
async function lookupNameOnline(barcode) {
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name_he,product_name`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    return data?.product?.product_name_he || data?.product?.product_name || '';
  } catch {
    return '';
  }
}

// ---------- השלוחה ----------
const router = YemotRouter({
  printLog: true,
  // אם קורית שגיאה: רושמים אותה ללוג ב-Render ומשמיעים הודעה במקום "אין מענה משרת API"
  uncaughtErrorHandler: (error, call) => {
    console.error('שגיאה בשיחה:', error);
    try { call.id_list_message([{ type: 'text', data: 'אירעה תקלה, נסו שוב מאוחר יותר' }]); } catch (e) {}
  },
});

router.get('/', async (call) => {
  // 1. הקלטה שלך + קבלת הברקוד (מסתיים בסולמית)
  const barcode = await call.read(
    [{ type: 'file', data: REC.ENTER_BARCODE }],
    'tap',
    { max_digits: 14, min_digits: 6, sec_wait: 15, typing_playback_mode: 'No' }
  );

  // 2. "נא להמתין" - מושמע לפני התוצאה
  await call.id_list_message(
    [{ type: 'file', data: REC.PLEASE_WAIT }],
    { prependToNextAction: true }
  );

  // 3. חיפוש
  await loadSheet();
  const key = normalize(barcode);
  const recommended = products.has(key);
  const name = await lookupNameOnline(key); // שם המוצר תמיד מהמאגר החיצוני

  // 4. שם המוצר (אם נמצא) ואחריו ההמלצה. אם לא נמצא שם - עוברים ישר להמלצה
  const messages = [];
  if (name) messages.push({ type: 'text', data: name.replace(/[.\-'"&]/g, ' ') });
  messages.push({ type: 'file', data: recommended ? REC.RECOMMEND : REC.NOT_RECOMMEND });

  await call.id_list_message(messages, { removeInvalidChars: true });
});

const app = express();
app.get('/health', (req, res) => res.send('ok')); // לבדיקת חיים (UptimeRobot)
app.use('/', router);
app.listen(process.env.PORT || 3000, () => console.log('השרת פועל'));
