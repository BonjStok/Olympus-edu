// Собирает общие части слайдов: шапку с вкладками, телефоны, данные «Для проверки»,
// QR-код и неразрывные пробелы. Ничего не рисует поверх слайдов.

const TABS = [
  ["intro", "Введение"],
  ["summary", "Executive Summary"],
  ["analysis", "Анализ"],
  ["solution", "Решение"],
  ["tech", "Архитектура"],
  ["growth", "Развитие"],
  ["risks", "Риски"],
  ["sources", "Источники"],
];

const STATUS = `<div class="phone-status">
  <span class="phone-time">9:41</span>
  <span class="phone-island"></span>
  <span class="phone-icons">
    <svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0.5" width="3" height="11.5" rx="1"/></svg>
    <svg viewBox="0 0 26 12"><path d="M4 1h14a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3zm0 1.2A1.8 1.8 0 0 0 2.2 4v4A1.8 1.8 0 0 0 4 9.8h14A1.8 1.8 0 0 0 19.8 8V4A1.8 1.8 0 0 0 18 2.2z"/><rect x="3.4" y="3.4" width="13" height="5.2" rx="1.2"/><path d="M22.8 4.4v3.2a1.8 1.8 0 0 0 0-3.2z"/></svg>
  </span>
</div>`;

const ARROW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

function phones() {
  for (const figure of document.querySelectorAll(".phone")) {
    const { shot, caption } = figure.dataset;
    const inner = shot ? `<img src="assets/screens/${shot}.jpg" alt="">` : figure.innerHTML;
    figure.innerHTML =
      `<div class="phone-body"><div class="phone-screen">${STATUS}` +
      `<div class="phone-view">${inner}</div></div></div>` +
      (caption ? `<figcaption>${caption}</figcaption>` : "");
  }
  for (const node of document.querySelectorAll("i.to")) {
    node.outerHTML = `<span class="arrow">${ARROW}</span>`;
  }
}

function heads() {
  const slides = [...document.querySelectorAll(".slide")];
  slides.forEach((slide) => {
    const block = slide.dataset.block;
    if (!block) return;
    const tabs =
      block === "check"
        ? '<span class="on">Техническая информация</span>'
        : TABS.map(
            ([key, title]) => `<span${key === block ? ' class="on"' : ""}>${title}</span>`,
          ).join("");
    const head = document.createElement("header");
    head.className = "head";
    head.innerHTML =
      '<div class="brand"><img src="assets/brand/icon.png" alt=""><span>Олимпус</span></div>' +
      `<nav class="tabs">${tabs}</nav>`;
    slide.prepend(head);
  });
}

// Значения вида «<вставьте …>» ещё не заполнены: показываем их заметно, но аккуратно.
const isTodo = (value) => /^<[^>]+>$/.test(String(value).trim());
const esc = (value) =>
  String(value).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const show = (value) =>
  isTodo(value) ? `<span class="ph">${esc(String(value).trim().slice(1, -1))}</span>` : esc(value);

function submission() {
  const data = window.SUBMISSION || {};
  for (const node of document.querySelectorAll("[data-sub]")) {
    const value = node.dataset.sub.split(".").reduce((v, k) => (v == null ? v : v[k]), data);
    node.innerHTML =
      value == null || value === "" ? '<span class="ph">не заполнено</span>' : show(value);
  }
  for (const node of document.querySelectorAll("[data-sub-list]")) {
    const rows = data[node.dataset.subList] || [];
    node.innerHTML = rows
      .map((row) =>
        typeof row === "string"
          ? `<li>${row
              .split(" | ")
              .map((part, i) => (i ? `<span>${show(part)}</span>` : `<b>${show(part)}</b>`))
              .join("")}</li>`
          : `<tr>${Object.values(row)
              .map((v) => `<td>${show(v)}</td>`)
              .join("")}</tr>`,
      )
      .join("");
  }
  // Фото команды лежат локально (assets/team/, не в Git); без фото – инициалы в круге.
  const initials = (name) =>
    isTodo(name || "<>")
      ? "?"
      : String(name)
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0])
          .join("");
  for (const node of document.querySelectorAll("[data-team]")) {
    node.innerHTML = (data.team || [])
      .map(
        (m) =>
          `<div class="member">` +
          (m.photo
            ? `<img class="avatar" src="${esc(m.photo)}" alt="">`
            : `<span class="avatar">${esc(initials(m.name))}</span>`) +
          `<b>${show(m.name || "<Фамилия Имя Отчество>")}</b>` +
          `<span>${show(m.role || "<роль>")}</span><em>${show(m.org || "<вуз>")}</em></div>`,
      )
      .join("");
  }
  for (const node of document.querySelectorAll("[data-qr]")) {
    if (window.BOT_QR) node.innerHTML = window.BOT_QR;
    else {
      node.classList.add("empty");
      node.textContent = "QR появится после вставки ссылки на бота";
    }
  }
}

// Неразрывные пробелы: перед тире, после чисел, коротких слов и внутри больших чисел.
// Длинные тире не заменяются: их ловит проверка при сборке.
const SHORT =
  "[А-Яа-яЁё]{1,2}|для|без|при|про|над|под|что|как|или|все|это|так|его|их|чем|где|кто|раз|нет|уже|вне|до";
const TYPO = [
  [/ –(?=[\s\u00a0])/g, "\u00a0–"],
  [/(\d) (?=\d{3}(?!\d))/g, "$1 "],
  [/(\d) (?=[А-Яа-яЁёA-Za-z%₽«])/g, "$1 "],
  [new RegExp(`(^|[\\s\\u00a0«(„])(${SHORT}) (?=\\S)`, "g"), "$1$2 "],
];

function typograph() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || el.closest("script, style, svg, .mono, .phone-view, [data-raw]")) continue;
    nodes.push(node);
  }
  for (const node of nodes) {
    let text = node.textContent;
    for (let pass = 0; pass < 2; pass++) {
      for (const [re, to] of TYPO) text = text.replace(re, to);
    }
    if (text !== node.textContent) node.textContent = text;
  }
}

// В заголовках последние два слова не разрываются: одно слово в последней строке не остаётся.
function widows() {
  for (const heading of document.querySelectorAll(".title, h3, .lead")) {
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent.trim() && !node.parentElement.closest("sup")) last = node;
    }
    if (last) last.textContent = last.textContent.replace(/\s+(\S+\s*)$/, "\u00a0$1");
  }
}

// Диапазоны вроде «4–6» и «2026/27» не переносятся.
function ranges() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (/\d[–/]\d/.test(node.textContent) && !node.parentElement.closest("script, style, svg"))
      nodes.push(node);
  }
  for (const node of nodes) {
    const html = esc(node.textContent).replace(
      /\d+[–/]\d+(?:\u00a0[а-яё]+)?/g,
      (m) => `<nobr>${m}</nobr>`,
    );
    const span = document.createElement("span");
    span.innerHTML = html;
    node.replaceWith(...span.childNodes);
  }
}

phones();
heads();
submission();
typograph();
widows();
ranges();
document.body.dataset.ready = "1";
