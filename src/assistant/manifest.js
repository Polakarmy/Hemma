// يولّد قائمة الأهداف المتاحة (صفحات / أزرار وروابط / أقسام) من الصفحة الحالية نفسها.
// تُرسل القائمة للسيرفر، ويُحتفظ هنا بربط المعرّفات بالعناصر الحقيقية للتنفيذ المحلي.

const IGNORE = '.va-root, header, footer, .header, .footer';
const BLOCKS = 'h1,h2,h3,h4,p,li,div,section,article,blockquote';
const NOISE =
  '.va-root, header, footer, .header, .footer, nav, script, style, svg, button, input, textarea, select, video, [aria-hidden="true"]';

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const hasWord = (s) => /[\p{L}\p{N}]/u.test(s);
const root = () => document.querySelector('.app-wrapper') || document.body;
const isVisible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

function nearestHeading(el, base) {
  let node = el.parentElement;
  for (let depth = 0; node && node !== base && depth < 5; depth += 1, node = node.parentElement) {
    const h = node.querySelector('h1,h2,h3,h4');
    if (h && !el.contains(h)) return norm(h.textContent);
  }
  return '';
}

export function buildManifest(pages) {
  const base = root();
  const path = window.location.pathname;
  const current = pages.find((p) => p.path === path)?.id ?? null;

  // ----- الأزرار والروابط -----
  const rows = [...base.querySelectorAll('button, a[href], [role="button"]')]
    .filter((el) => {
      if (el.closest(IGNORE)) return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      if (el.getAttribute('aria-hidden') === 'true' || !isVisible(el)) return false;
      if (el.tagName === 'A') {
        // نسمح فقط بروابط نفس الموقع والروابط الداخلية للصفحة، لا الإعلانات والمواقع الخارجية.
        const href = el.getAttribute('href') || '';
        if (!href.startsWith('#') && el.origin !== window.location.origin) return false;
      }
      return true;
    })
    .map((el) => ({
      el,
      own: norm(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title')),
      ctx: nearestHeading(el, base),
    }))
    .filter((r) => hasWord(r.own) && !/^\d+$/.test(r.own));

  const counts = new Map();
  rows.forEach((r) => counts.set(r.own, (counts.get(r.own) || 0) + 1));

  const used = new Map();
  const elementMap = new Map();
  const elements = [];
  for (const r of rows) {
    if (elements.length >= 80) break;
    let label = counts.get(r.own) > 1 && r.ctx ? `${r.own} — ${r.ctx}` : r.own;
    label = label.slice(0, 80);
    const n = used.get(label) || 0;
    used.set(label, n + 1);
    if (n > 0) label = `${label} (${n + 1})`;
    const id = `e${elements.length + 1}`;
    elementMap.set(id, r.el);
    elements.push({ id, label });
  }

  // ----- الأقسام (العناوين) -----
  const sectionMap = new Map();
  const sections = [];
  const seenHeadings = new Set();
  for (const h of base.querySelectorAll('h1,h2,h3')) {
    if (sections.length >= 30) break;
    if (h.closest(IGNORE) || !isVisible(h)) continue;
    const label = norm(h.textContent).slice(0, 80);
    if (!label || seenHeadings.has(label)) continue;
    seenHeadings.add(label);
    const id = `s${sections.length + 1}`;
    sectionMap.set(id, h);
    sections.push({ id, label });
  }

  return {
    public: {
      pages: pages.map(({ id, label, hint }) => ({ id, label, hint })),
      sections,
      elements,
      current,
    },
    elements: elementMap,
    sections: sectionMap,
  };
}

// نص نظيف مع الحفاظ على فواصل الأسطر (تُستخدم كنقاط وقف عند القراءة).
function textOf(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll(NOISE).forEach((n) => n.remove());
  clone.querySelectorAll(BLOCKS).forEach((n) => n.append('\n'));
  return (clone.textContent || '')
    .split('\n')
    .map(norm)
    .filter(Boolean)
    .join('\n');
}

export function getPageText() {
  return textOf(root());
}

export function getSectionText(heading) {
  if (!heading || !heading.isConnected) return '';
  const level = Number(heading.tagName[1]);
  const parts = [textOf(heading)];
  for (let sib = heading.nextElementSibling; sib; sib = sib.nextElementSibling) {
    if (/^H[1-6]$/.test(sib.tagName) && Number(sib.tagName[1]) <= level) break;
    parts.push(textOf(sib));
  }
  let text = parts.filter(Boolean).join('\n');
  if (text.length < 60) {
    const card = heading.closest(
      '.news-sub-card, .question-card, .dark-concept-card, .politics-card-reversed, .politics-top-section, .hero-content, .slider-content, section',
    );
    if (card) text = textOf(card);
  }
  return text;
}
