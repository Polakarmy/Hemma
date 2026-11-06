// منطق التحقق (whitelist) المشترك بين السيرفر والواجهة.
// الموديل لا يتحكم في الموقع أبدًا: أي رد منه يمر من هنا، وأي هدف غير موجود
// في قائمة الصفحات/العناصر/الأقسام المُولَّدة من الموقع يتحول إلى "unknown".

export const ACTIONS = Object.freeze(['navigate', 'click', 'read', 'scroll', 'help', 'unknown']);
export const SCROLL_DIRECTIONS = Object.freeze(['up', 'down', 'top', 'bottom']);

export const DEFAULT_UNKNOWN_MESSAGE = 'مفهمتش الأمر، ممكن تعيده؟ قول "مساعدة" لو عايز تعرف الأوامر.';
export const NOT_AVAILABLE_MESSAGE = 'ده مش موجود في الموقع. قول "مساعدة" عشان تعرف المتاح.';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// تنظيف النصوص: إزالة محارف التحكم، توحيد المسافات، قص الطول.
const clean = (value, max) =>
  typeof value === 'string'
    ? value.replace(/\p{C}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

function takeList(arr, cap, build) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (out.length >= cap) break;
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : null;
    if (!id || seen.has(id)) continue;
    const label = clean(item.label, 100);
    if (!label) continue;
    seen.add(id);
    out.push(build(id, label, item));
  }
  return out;
}

// يُستخدم على السيرفر لأن القائمة تأتي من المتصفح (غير موثوقة من حيث الشكل والحجم).
export function sanitizeManifest(input) {
  const m = input && typeof input === 'object' ? input : {};
  return {
    pages: takeList(m.pages, 30, (id, label, it) => ({ id, label, hint: clean(it.hint, 140) })),
    sections: takeList(m.sections, 40, (id, label) => ({ id, label })),
    elements: takeList(m.elements, 100, (id, label) => ({ id, label })),
    current: typeof m.current === 'string' && ID_RE.test(m.current) ? m.current : null,
  };
}

const idSet = (list) => new Set(list.map((x) => x.id));

// يحوّل أي مخرجات (نص JSON أو كائن) إلى أمر آمن من الأوامر المسموحة فقط.
export function validateCommand(raw, manifest) {
  const unknown = (message) => ({
    action: 'unknown',
    message: clean(message, 160) || DEFAULT_UNKNOWN_MESSAGE,
  });

  let cmd = raw;
  if (typeof cmd === 'string') {
    try {
      cmd = JSON.parse(cmd);
    } catch {
      return unknown();
    }
  }
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return unknown();

  const m = manifest || { pages: [], sections: [], elements: [] };

  switch (cmd.action) {
    case 'navigate':
      return typeof cmd.target === 'string' && idSet(m.pages).has(cmd.target)
        ? { action: 'navigate', target: cmd.target }
        : unknown(NOT_AVAILABLE_MESSAGE);

    case 'click':
      return typeof cmd.target === 'string' && idSet(m.elements).has(cmd.target)
        ? { action: 'click', target: cmd.target }
        : unknown(NOT_AVAILABLE_MESSAGE);

    case 'read':
      return typeof cmd.target === 'string' &&
        (cmd.target === 'page' || idSet(m.sections).has(cmd.target))
        ? { action: 'read', target: cmd.target }
        : unknown(NOT_AVAILABLE_MESSAGE);

    case 'scroll':
      return SCROLL_DIRECTIONS.includes(cmd.direction)
        ? { action: 'scroll', direction: cmd.direction }
        : unknown();

    case 'help':
      return { action: 'help' };

    case 'unknown':
      return unknown(cmd.message);

    default:
      return unknown();
  }
}
