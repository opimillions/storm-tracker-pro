/** Dates for Ryan: MM-DD-YYYY, Central time. */
const TZ = 'America/Chicago';

function day(iso) { // 'YYYY-MM-DD' (a storm day) -> 'MM-DD-YYYY'
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${m}-${d}-${y}`;
}

function time(iso) { // ISO timestamp -> 'MM-DD-YYYY 7:08 AM CT'
  if (!iso) return '—';
  const t = new Date(iso);
  if (isNaN(t)) return '—';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(t).map(x => [x.type, x.value]));
  return `${p.month}-${p.day}-${p.year} ${p.hour}:${p.minute} ${p.dayPeriod} CT`;
}

function ago(iso, now = Date.now()) {
  if (!iso) return 'never';
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

module.exports = { day, time, ago, TZ };
