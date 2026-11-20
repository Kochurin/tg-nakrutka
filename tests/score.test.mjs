// node --test tests
// Синтетические каналы: проверяем, что признаки накрутки снижают балл, а живая картина его не роняет
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../score.js";
import { num, parseHeader, parsePosts } from "../worker/src/parse.js";

const NOW = "2026-11-20T12:00:00Z";
const rnd = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(42);

// 40 постов, раз в 12 часов, последний час назад
function channel({ subs = 10000, views, reactions = v => v * 0.01, history = [] }) {
  const posts = Array.from({ length: 40 }, (_, i) => {
    const date = new Date(Date.parse(NOW) - (1 + (39 - i) * 12) * 3600e3).toISOString();
    const v = Math.round(views(i));
    return { id: i + 1, date, views: v, reactions: Math.round(reactions(v)), paid: 0, forwarded: false };
  });
  return { name: "test", fetchedAt: NOW, header: { subscribers: subs }, posts, history };
}

test("живой канал: разные просмотры, обычный охват, реакции", () => {
  const r = analyze(channel({ views: i => (i === 39 ? 600 : 2500 * (0.6 + rnd() * 0.9)) }));
  assert.ok(r.score >= 75, `score ${r.score}`);
  assert.equal(r.verdict.level, "ok");
});

test("плоские просмотры без реакций и мёртвые подписчики", () => {
  const r = analyze(channel({ subs: 200000, views: () => 3000 + rnd() * 60, reactions: () => 0 }));
  assert.ok(r.score < 50, `score ${r.score}`);
  assert.equal(r.checks.find(c => c.id === "flat").level, "bad");
  assert.equal(r.checks.find(c => c.id === "err").level, "bad");
});

test("свежий пост сразу набрал столько же, сколько старые", () => {
  const r = analyze(channel({ views: i => (i === 39 ? 3200 : 2500 * (0.7 + rnd() * 0.6)) }));
  assert.equal(r.checks.find(c => c.id === "speed").level, "bad");
});

test("скачок подписчиков по истории снимков", () => {
  const history = [{ day: "2026-11-17", n: 10000 }, { day: "2026-11-18", n: 10100 }, { day: "2026-11-19", n: 14000 }];
  const r = analyze(channel({ views: i => 2500 * (0.6 + rnd() * 0.9), history }));
  const j = r.checks.find(c => c.id === "jump");
  assert.equal(j.level, "bad");
  assert.match(j.text, /больше на 3 900/);
});

test("числа из веб-превью", () => {
  assert.equal(num("3.81M"), 3810000);
  assert.equal(num("12.5K"), 12500);
  assert.equal(num("845"), 845);
  assert.equal(num("1 234"), 1234);
});

test("разбор шапки и поста", () => {
  const html = `<div class="tgme_channel_info"><div class="tgme_channel_info_header_title"><span dir="auto">Тест &amp; Ко</span></div>
    <div class="tgme_channel_info_counters"><div class="tgme_channel_info_counter"><span class="counter_value">12.3K</span> <span class="counter_type">subscribers</span></div></section>
    <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="test/7">
    <div class="tgme_widget_message_reactions js-message_reactions"><span class="tgme_reaction tgme_reaction_paid"><i class="icon"></i>5</span><span class="tgme_reaction"><tg-emoji emoji-id="123"></tg-emoji>44</span><span class="tgme_reaction"><i class="emoji"><b>👍</b></i>1.2K</span></div>
    <span class="tgme_widget_message_views">3.4K</span><time datetime="2026-11-19T10:00:00+00:00" class="time">10:00</time></div></div>`;
  const h = parseHeader(html);
  assert.equal(h.title, "Тест & Ко");
  assert.equal(h.subscribers, 12300);
  const [p] = parsePosts(html);
  assert.deepEqual({ id: p.id, views: p.views, reactions: p.reactions, paid: p.paid }, { id: 7, views: 3400, reactions: 1244, paid: 5 });
});
