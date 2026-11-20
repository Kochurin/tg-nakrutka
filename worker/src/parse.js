// Разбор публичного веб-превью канала t.me/s/<username>
// Берём только то, что Telegram сам показывает без входа: шапку канала и последние посты

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", "#33": "!" };
const unescape = s => s.replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? (e[0] === "#" ? String.fromCodePoint(+e.slice(1)) : m));
const strip = s => unescape(s.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")).trim();

// «3.81M», «12.5K», «845», «1 234» → число
export function num(s) {
  if (!s) return null;
  const t = s.replace(/[\s ,]/g, "").trim();
  const m = t.match(/^([\d.]+)([KMB])?$/i);
  if (!m) return null;
  const k = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * k);
}

export function parseHeader(html) {
  const info = html.match(/<div class="tgme_channel_info">([\s\S]*?)<div class="tgme_channel_info_counters">([\s\S]*?)<\/section>/);
  if (!info) return null;
  const title = info[1].match(/tgme_channel_info_header_title"><span dir="auto">([\s\S]*?)<\/span>/);
  const desc = html.match(/<div class="tgme_channel_info_description">([\s\S]*?)<\/div>/);
  const photo = info[1].match(/tgme_page_photo_image[^>]*><img src="([^"]+)"/);
  const counters = {};
  for (const m of info[2].matchAll(/counter_value">([^<]+)<\/span> <span class="counter_type">([^<]+)</g)) counters[m[2]] = num(m[1]);
  return {
    title: title ? strip(title[1]) : null,
    description: desc ? strip(desc[1]).slice(0, 400) : "",
    photo: photo ? photo[1] : null,
    verified: /verified-icon/.test(info[1]),
    subscribers: counters.subscribers ?? counters.subscriber ?? null,
    photos: counters.photos ?? null, videos: counters.videos ?? null, links: counters.links ?? null,
  };
}

export function parsePosts(html) {
  const posts = [];
  const parts = html.split('<div class="tgme_widget_message_wrap');
  for (const p of parts.slice(1)) {
    const id = p.match(/data-post="[^/"]+\/(\d+)"/);
    if (!id) continue;
    // служебные сообщения (сменили название, закрепили) не имеют просмотров
    if (/service_message/.test(p.slice(0, 400))) continue;
    const views = p.match(/tgme_widget_message_views">([^<]+)</);
    const date = p.match(/<time datetime="([^"]+)"/);
    if (!views || !date) continue;
    let reactions = 0, paid = 0;
    const rx = p.match(/tgme_widget_message_reactions[^>]*>([\s\S]*?)<\/div>/);
    if (rx) for (const r of rx[1].matchAll(/<span class="tgme_reaction( tgme_reaction_paid)?">[\s\S]*?([\d.]+[KMB]?)<\/span>/g)) {
      const n = num(r[2]) || 0;
      if (r[1]) paid += n; else reactions += n;
    }
    posts.push({
      id: +id[1],
      date: date[1],
      views: num(views[1]),
      reactions,
      paid,
      forwarded: /tgme_widget_message_forwarded_from/.test(p),
      edited: /,&nbsp;edited/.test(p),
    });
  }
  return posts;
}

// ссылка на предыдущую страницу ленты
export const beforeId = html => {
  const m = html.match(/data-before="(\d+)"/);
  return m ? +m[1] : null;
};
