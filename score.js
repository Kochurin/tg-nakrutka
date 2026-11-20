// Оценка «живости» канала по данным веб-превью t.me/s
// Это эвристика: каждый признак даёт баллы, итог — доля набранных баллов от возможных
// Пороги подобраны на живых публичных каналах (см. README), а не взяты из чужих исследований

const H = 3600e3;
const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const pct = x => x >= 0.1 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(x >= 0.01 ? 1 : 2)}%`;
const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} млн` : n >= 1e4 ? `${Math.round(n / 1e3)} тыс` : String(n).replace(/\B(?=(\d{3})+$)/g, " ");
const days = n => { const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? "день" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "дня" : "дней"}`; };
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; };
const hours = n => { const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? "час" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "часа" : "часов"}`; };

// разброс без 10% самых больших и самых маленьких значений: один вирусный пост не должен спасать канал
function trimmedCv(values) {
  const s = [...values].sort((a, b) => a - b);
  const cut = Math.floor(s.length * 0.1);
  const t = s.slice(cut, s.length - cut);
  const m = mean(t);
  if (!m) return null;
  return Math.sqrt(mean(t.map(x => (x - m) ** 2))) / m;
}

// посты одного альбома выходят в одну минуту: для регулярности считаем их одним постом
function publications(posts) {
  const out = [];
  for (const p of posts) {
    const t = Date.parse(p.date);
    if (out.length && t - out[out.length - 1] < 120e3) continue;
    out.push(t);
  }
  return out;
}

export function analyze(data, nowIso) {
  const now = Date.parse(nowIso || data.fetchedAt || new Date().toISOString());
  const subs = data.header?.subscribers ?? null;
  const posts = (data.posts || []).filter(p => p.views != null);
  const age = p => (now - Date.parse(p.date)) / H;
  const mature = posts.filter(p => age(p) >= 24);   // за сутки пост набирает основную часть просмотров
  const checks = [];
  const add = (id, title, max, points, text, level) => checks.push({ id, title, max, points, text, level });
  const lvl = (p, max) => p >= max * 0.8 ? "ok" : p >= max * 0.4 ? "warn" : "bad";

  const views = mature.map(p => p.views);
  const medViews = views.length ? median(views) : null;

  // 1. Охват: сколько подписчиков видит обычный пост
  if (subs && views.length >= 5) {
    const err = medViews / subs;
    let p, t;
    if (err < 0.02) { p = 0; t = `Обычный пост видит ${pct(err)} подписчиков. Так выглядят каналы с купленной или давно мёртвой аудиторией`; }
    else if (err < 0.04) { p = 8; t = `Обычный пост видит ${pct(err)} подписчиков. Это мало: часть аудитории, похоже, не читает канал`; }
    else if (err < 0.08) { p = 17; t = `Обычный пост видит ${pct(err)} подписчиков. Низковато, но встречается у больших старых каналов`; }
    else if (err <= 0.8) { p = 25; t = `Обычный пост видит ${pct(err)} подписчиков. Нормальный охват`; }
    else if (err <= 1.2) { p = 15; t = `Обычный пост видит ${pct(err)} подписчиков. Очень высоко: бывает у маленьких активных каналов, у постов из поиска и репостов, а ещё при накрутке просмотров`; }
    else { p = 5; t = `Просмотров у обычного поста в ${(err).toFixed(1)} раза больше, чем подписчиков. Без репостов в крупные каналы так бывает редко`; }
    if (subs < 500 && p < 25) t += ". У каналов меньше 500 подписчиков этот признак шумный";
    add("err", "Охват (ERR)", 25, p, t, lvl(p, 25));
  } else {
    add("err", "Охват (ERR)", 0, 0, subs ? "Мало постов старше суток, охват не посчитать" : "Telegram не показал число подписчиков", "na");
  }

  // 2. Ровность просмотров: у живых каналов посты набирают по-разному
  // В Telegram просмотр засчитывается, когда пост появился на экране. Кто листает частый новостной канал,
  // тот «смотрит» подряд все посты, поэтому у каналов с десятком постов в день кривая ровнее и пороги ниже
  const pubsAll = publications(posts);
  const spanDays = pubsAll.length > 1 ? (pubsAll[pubsAll.length - 1] - pubsAll[0]) / 864e5 : 0;
  const perDay = spanDays >= 0.5 ? pubsAll.length / spanDays : 0;
  const busy = perDay >= 8;
  if (views.length >= 8) {
    const cv = trimmedCv(views);
    const [hi, mid, lo] = busy ? [0.08, 0.045, 0.025] : [0.15, 0.09, 0.05];
    let p, t;
    const spread = `Разброс просмотров между постами ${pct(cv)}`;
    if (cv >= hi) { p = 25; t = `${spread}. Посты набирают по-разному, как и бывает у живой аудитории`; }
    else if (cv >= mid) { p = 16; t = `${spread}. Довольно ровно, но для больших каналов со стабильной аудиторией это ещё норма`; }
    else if (cv >= lo) { p = 6; t = `${spread}. Почти одинаковые просмотры у разных постов: частый след накрутки пакетами`; }
    else { p = 0; t = `${spread}. Просмотры почти одинаковые на всех постах, живая аудитория так не читает`; }
    if (busy) t += `. Канал выпускает около ${Math.round(perDay)} ${plural(Math.round(perDay), "поста", "постов", "постов")} в день, у таких каналов кривая ровнее, и пороги здесь мягче`;
    add("flat", "Ровность просмотров", 25, p, t, lvl(p, 25));
  } else {
    add("flat", "Ровность просмотров", 0, 0, "Нужно хотя бы 8 постов старше суток", "na");
  }

  // 3. Скорость набора: свежий пост редко сразу набирает столько же, сколько старые за двое суток
  const fresh = posts.filter(p => age(p) >= 0.5 && age(p) < 6 && !p.forwarded);
  if (medViews >= 300 && fresh.length) {
    const fast = fresh.filter(p => p.views >= medViews * 0.95);
    if (fast.length) {
      const f = fast[0];
      add("speed", "Скорость набора", 10, 2, `Пост ${hours(Math.max(1, Math.round(age(f))))} назад уже набрал ${fmt(f.views)} просмотров, столько же, сколько обычный пост за сутки и больше. Живые просмотры так быстро не приходят`, "bad");
    } else {
      add("speed", "Скорость набора", 10, 10, `Свежие посты (младше 6 часов) набирают просмотры постепенно`, "ok");
    }
  } else {
    add("speed", "Скорость набора", 0, 0, medViews && medViews < 300 ? "У канала слишком мало просмотров, чтобы судить о скорости набора" : "Нет постов младше 6 часов, проверить скорость набора не на чем", "na");
  }

  // 4. Реакции к просмотрам: ботам для просмотров реакции не заказывают, а заказанные реакции видны по перекосу
  const withR = mature.filter(p => p.reactions > 0);
  if (mature.length >= 5 && withR.length >= mature.length * 0.3) {
    const r = median(mature.map(p => p.reactions / Math.max(p.views, 1)));
    let p, t;
    if (r < 0.0008) { p = 3; t = `Реакций всего ${pct(r)} от просмотров. Просмотров много, а реагировать некому`; }
    else if (r < 0.002) { p = 10; t = `Реакций ${pct(r)} от просмотров. Мало, такое бывает и у живых новостных каналов`; }
    else if (r <= 0.08) { p = 20; t = `Реакций ${pct(r)} от просмотров. Обычное соотношение`; }
    else if (r <= 0.15) { p = 10; t = `Реакций ${pct(r)} от просмотров. Много: либо очень вовлечённая аудитория, либо реакции докручены`; }
    else { p = 3; t = `Реакций ${pct(r)} от просмотров. Это слишком много для живых людей`; }
    add("react", "Реакции", 20, p, t, lvl(p, 20));
  } else if (mature.length >= 5) {
    add("react", "Реакции", 0, 0, "Реакций почти нет или они выключены в канале", "na");
  } else {
    add("react", "Реакции", 0, 0, "Мало постов для оценки реакций", "na");
  }

  // 5. Скачки подписчиков: сервис сам сохраняет число подписчиков раз в сутки при проверке
  const hist = data.history || [];
  if (hist.length >= 2) {
    let worst = null;
    for (let i = 1; i < hist.length; i++) {
      const d = Math.max(1, (Date.parse(hist[i].day) - Date.parse(hist[i - 1].day)) / 864e5);
      const rel = (hist[i].n - hist[i - 1].n) / hist[i - 1].n / d;
      const abs = Math.abs(hist[i].n - hist[i - 1].n);
      if (abs >= 300 && Math.abs(rel) >= 0.05 && (!worst || Math.abs(rel) > Math.abs(worst.rel))) worst = { rel, abs, day: hist[i].day };
    }
    if (worst) add("jump", "Скачки подписчиков", 10, 2, worst.rel > 0
      ? `${worst.day} подписчиков стало больше на ${fmt(worst.abs)} (${pct(worst.rel)} в сутки). Резкий рост без вирусного поста часто значит покупку`
      : `${worst.day} ушло ${fmt(worst.abs)} подписчиков (${pct(-worst.rel)} в сутки). Так Telegram чистит ботов после накрутки`, "bad");
    else add("jump", "Скачки подписчиков", 10, 10, `За ${days(hist.length)} наблюдений резких скачков нет`, "ok");
  } else {
    add("jump", "Скачки подписчиков", 0, 0, "История подписчиков копится с первой проверки: Telegram не показывает её публично. Загляните через пару дней", "na");
  }

  // 6. Регулярность постинга
  const pubs = pubsAll;
  if (pubs.length >= 5) {
    const last = (now - pubs[pubs.length - 1]) / 864e5;
    const gaps = pubs.slice(1).map((t, i) => (t - pubs[i]) / 864e5);
    const maxGap = Math.max(...gaps);
    const medGap = median(gaps);
    let p, t;
    if (last > 30) { p = 0; t = `Последний пост был ${days(Math.round(last))} назад. Канал почти не ведётся, реклама в нём уйдёт в пустоту`; }
    else if (maxGap > 45 && maxGap > medGap * 10) { p = 6; t = `В ленте перерыв ${days(Math.round(maxGap))}, потом посты снова пошли. После долгих пауз каналы иногда перепродают: проверьте, не сменилась ли тематика`; }
    else if (last > 10) { p = 6; t = `Последний пост был ${days(Math.round(last))} назад, канал пишет редко`; }
    else {
      p = 10;
      const span = (pubs[pubs.length - 1] - pubs[0]) / 864e5;
      t = `${pubs.length} ${plural(pubs.length, "публикация", "публикации", "публикаций")} за ${days(Math.max(1, Math.round(span)))}, без долгих пауз`;
      const ivCv = gaps.length >= 10 ? Math.sqrt(mean(gaps.map(g => (g - mean(gaps)) ** 2))) / mean(gaps) : 1;
      if (ivCv < 0.08) t += ". Посты выходят строго по таймеру: это автопостинг, само по себе не накрутка";
    }
    add("regular", "Регулярность", 10, p, t, lvl(p, 10));
  } else {
    add("regular", "Регулярность", 0, 0, "Слишком мало постов в публичной ленте", "na");
  }

  const max = checks.reduce((s, c) => s + c.max, 0);
  const got = checks.reduce((s, c) => s + c.points, 0);
  const core = checks.filter(c => (c.id === "err" || c.id === "flat") && c.max).length;
  const score = core && max >= 35 ? Math.round(100 * got / max) : null;

  const reposts = posts.length ? posts.filter(p => p.forwarded).length / posts.length : 0;
  const notes = [];
  if (reposts >= 0.3) notes.push(`${pct(reposts)} постов — репосты из других каналов`);
  if (posts.some(p => p.paid > 0)) notes.push("Под постами есть платные реакции звёздами");
  if (data.header?.verified) notes.push("У канала галочка верификации Telegram");

  let verdict = null;
  if (score != null) verdict = score >= 75 ? { level: "ok", text: "Похоже на живой канал" } : score >= 50 ? { level: "warn", text: "Есть странности" } : { level: "bad", text: "Много признаков накрутки" };
  return { score, verdict, checks, notes, stats: { subs, posts: posts.length, mature: mature.length, medViews } };
}
