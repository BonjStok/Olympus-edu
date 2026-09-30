/**
 * Layout and typography checks that run inside the page before printing.
 * They only collect messages: nothing is drawn, highlighted or tinted on the slides.
 */
export function pageChecks() {
  const errors = [];
  const warnings = [];
  const slides = [...document.querySelectorAll(".slide")];
  const where = (i, el) => {
    const text = (el.textContent || el.getAttribute("class") || el.tagName)
      .trim()
      .replace(/\s+/g, " ");
    return `слайд ${i + 1}: ${text.slice(0, 70)}`;
  };

  for (const font of [
    '400 20px "Inter"',
    '600 20px "Inter"',
    '700 40px "Inter Display"',
    '800 40px "Inter Display"',
  ]) {
    if (!document.fonts.check(font)) errors.push(`шрифт не загрузился: ${font}`);
  }
  for (const img of document.images) {
    if (!img.complete || !img.naturalWidth)
      errors.push(`картинка не загрузилась: ${img.getAttribute("src")}`);
  }

  // 1. Nothing leaves the slide, nothing is clipped, text keeps a margin from the edges.
  slides.forEach((slide, i) => {
    const box = slide.getBoundingClientRect();
    for (const el of slide.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.closest("svg")) continue;
      const style = getComputedStyle(el);
      const outside =
        r.left < box.left - 1 ||
        r.right > box.right + 1 ||
        r.top < box.top - 1 ||
        r.bottom > box.bottom + 1;
      const tolY = Math.max(2, parseFloat(style.fontSize) * 0.4);
      const leaf = el.children.length === 0 && el.textContent.trim() !== "";
      const clipped =
        leaf &&
        el.clientHeight > 0 &&
        (el.scrollHeight > el.clientHeight + tolY || el.scrollWidth > el.clientWidth + 2);
      const spills = el.classList.contains("grow") && el.scrollHeight > el.clientHeight + 4;
      if (outside && !el.closest(".phone-view, .orb"))
        errors.push(`${where(i, el)} – за краем слайда`);
      if (clipped || spills) errors.push(`${where(i, el)} – не помещается`);
      if (leaf) {
        const near =
          r.left - box.left < 40 ||
          box.right - r.right < 40 ||
          box.bottom - r.bottom < 16 ||
          r.top - box.top < 16;
        if (near && !el.closest(".phone-view"))
          errors.push(`${where(i, el)} – текст касается края`);
      }
    }
  });

  // 2. No debug visuals of any kind. PDF viewers turn blurred shadows, filters and
  //    semi-transparent fills into grey boxes, so print styles must not use them.
  const alpha = (color) => {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length > 3 ? parseFloat(parts[3]) : 1;
  };
  slides.forEach((slide, i) => {
    for (const el of [slide, ...slide.querySelectorAll("*")]) {
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      const s = getComputedStyle(el);
      const cls = String(el.getAttribute("class") || "");
      const bad = [];
      if (/debug|overlay|highlight|outline|fit-|probe/i.test(cls)) bad.push(`класс «${cls}»`);
      if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) bad.push("outline");
      if (
        s.boxShadow !== "none" &&
        /\d+px \d+px [1-9]/.test(s.boxShadow.replace(/rgba?\([^)]*\)/g, ""))
      )
        bad.push(`размытая тень ${s.boxShadow}`);
      if (s.boxShadow !== "none" && alpha(s.boxShadow) < 1) bad.push("полупрозрачная тень");
      if (s.textShadow !== "none") bad.push("text-shadow");
      if (s.filter !== "none") bad.push("filter");
      if (s.backdropFilter && s.backdropFilter !== "none") bad.push("backdrop-filter");
      if (s.mixBlendMode !== "normal") bad.push("mix-blend-mode");
      if (parseFloat(s.opacity) < 1) bad.push("opacity");
      for (const prop of ["backgroundColor", "borderTopColor", "borderBottomColor", "color"]) {
        const a = alpha(s[prop]);
        if (a > 0 && a < 1) bad.push(`${prop} с прозрачностью`);
      }
      if (/rgba|\/\s*0?\.\d/.test(s.backgroundImage)) bad.push("полупрозрачный градиент");
      if (bad.length) errors.push(`${where(i, el)} – ${[...new Set(bad)].join(", ")}`);
    }
  });

  // 3. Russian typography: short dashes only, non-breaking spaces before dashes, after numbers
  //    and short words, and no period at the end of a paragraph, bullet, caption or cell.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || el.closest("script, style, svg")) continue;
    const slide = el.closest(".slide");
    if (!slide) continue;
    const i = slides.indexOf(slide);
    const text = node.textContent;
    const quote = `«${text.trim().slice(0, 50)}»`;
    if (/—/.test(text)) errors.push(`слайд ${i + 1}: длинное тире «—», нужно «–» – ${quote}`);
    if (el.closest(".mono, [data-sub], [data-sub-list], .phone-view")) continue;
    if (/ –/.test(text)) errors.push(`слайд ${i + 1}: обычный пробел перед тире – ${quote}`);
    if (/\d [а-яёa-z%₽«]/i.test(text)) errors.push(`слайд ${i + 1}: пробел после числа – ${quote}`);
    if (/(^|[\s(«])[вксуояиаВКСУОЯИА] /.test(text))
      errors.push(`слайд ${i + 1}: висячий предлог или союз – ${quote}`);
    if (/\s{2,}\S/.test(text.trim()) && !/\n/.test(text))
      warnings.push(`слайд ${i + 1}: двойной пробел`);
  }
  slides.forEach((slide, i) => {
    for (const el of slide.querySelectorAll("*")) {
      if (el.closest("svg, script, style, .phone-view")) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const display = getComputedStyle(el).display;
      if (display === "inline" || display === "contents") continue;
      const text = el.textContent.replace(/\s+/g, " ").trim();
      if (/[^.]\.$/.test(text) && !/(т\. ?[дп]|им|см|тыс|г)\.$/.test(text))
        errors.push(`${where(i, el)} – точка в конце абзаца или пункта`);
    }
  });

  // 4. WCAG AA contrast for text: 4.5:1, or 3:1 for large text (24px+, or 18.7px+ bold).
  const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const background = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== "none") return null; // gradients and images: checked by eye
      const c = rgb(s.backgroundColor);
      if (c.length === 3 || (c.length === 4 && c[3] > 0)) return c.slice(0, 3);
    }
    return [255, 255, 255];
  };
  slides.forEach((slide, i) => {
    for (const el of slide.querySelectorAll("*")) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own || el.closest(".phone-view, svg")) continue;
      const s = getComputedStyle(el);
      const bg = background(el);
      if (!bg) continue;
      const [a, b] = [lum(rgb(s.color)), lum(bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5))
        errors.push(`${where(i, el)} – контраст ${ratio.toFixed(2)}:1`);
    }
  });

  // 5. No single orphan word on the last line of headings.
  slides.forEach((slide, i) => {
    for (const h of slide.querySelectorAll("h1, h2, h3, .title, .lead")) {
      const range = document.createRange();
      const words = [];
      const tw = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
      for (let t = tw.nextNode(); t; t = tw.nextNode()) {
        for (const m of t.textContent.matchAll(/\S+/g)) {
          range.setStart(t, m.index);
          range.setEnd(t, m.index + m[0].length);
          const rect = range.getBoundingClientRect();
          if (rect.width) words.push(Math.round(rect.top));
        }
      }
      if (words.length < 4) continue;
      const last = words[words.length - 1];
      if (words[words.length - 2] !== last)
        errors.push(`${where(i, h)} – одно слово в последней строке`);
    }
  });

  // 5b. The source line at the bottom never overlaps the slide content above it.
  slides.forEach((slide, i) => {
    const source = slide.querySelector(".source");
    if (!source) return;
    const sr = source.getBoundingClientRect();
    for (const el of slide.querySelectorAll(".body *")) {
      if (el === source || source.contains(el) || el.contains(source)) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const painted = getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)";
      if (!own && !painted) continue;
      const r = el.getBoundingClientRect();
      if (
        r.width &&
        r.height &&
        r.bottom > sr.top + 1 &&
        r.top < sr.bottom &&
        r.right > sr.left &&
        r.left < sr.right
      )
        errors.push(`${where(i, el)} – наезжает на строку источников`);
    }
  });

  // 6. Palette of «Сферум»: blue, violet, light blue, turquoise, grey, white and a little black.
  //    Screenshots, photos and the mascot are pictures of real things and are not checked.
  const hsl = ([r, g, b]) => {
    [r, g, b] = [r / 255, g / 255, b / 255];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  };
  const offPalette = (value) =>
    [...String(value).matchAll(/rgba?\(([^)]+)\)/g)].some((m) => {
      const v = m[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      if (v.length > 3 && v[3] === 0) return false;
      const [h, s, l] = hsl(v);
      if (s < 0.18 || l > 0.965 || l < 0.08) return false;
      return h < 175 || h > 285;
    });
  slides.forEach((slide, i) => {
    for (const el of [slide, ...slide.querySelectorAll("*")]) {
      if (el.closest(".phone-view") || el.tagName === "IMG") continue;
      for (const pseudo of [null, "::before", "::after"]) {
        const s = getComputedStyle(el, pseudo);
        if (pseudo && (s.content === "none" || s.content === "normal")) continue;
        const props = ["color", "backgroundColor", "backgroundImage", "fill", "stroke"];
        for (const side of ["Top", "Right", "Bottom", "Left"])
          if (parseFloat(s[`border${side}Width`]) > 0) props.push(`border${side}Color`);
        const bad = props.filter((prop) => offPalette(s[prop]));
        if (bad.length)
          errors.push(`${where(i, el)}${pseudo || ""} – цвет вне палитры: ${bad.join(", ")}`);
      }
    }
  });

  return { slides: slides.length, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
