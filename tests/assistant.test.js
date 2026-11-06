// تشغيل: npm test   (يستخدم node:test المدمج، بدون أي مكتبات إضافية)
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeManifest, validateCommand } from '../src/assistant/validate.js';

const manifest = sanitizeManifest({
  pages: [
    { id: 'home', label: 'الرئيسية', hint: 'x' },
    { id: 'politics', label: 'سياسة' },
  ],
  sections: [{ id: 's1', label: 'ما وراء الخبر' }],
  elements: [{ id: 'e1', label: 'اقرأ الخبر كاملاً' }],
  current: 'home',
});

test('الأوامر الصحيحة تمر', () => {
  assert.deepEqual(validateCommand({ action: 'navigate', target: 'politics' }, manifest), {
    action: 'navigate',
    target: 'politics',
  });
  assert.deepEqual(validateCommand('{"action":"click","target":"e1"}', manifest), {
    action: 'click',
    target: 'e1',
  });
  assert.deepEqual(validateCommand({ action: 'read', target: 'page' }, manifest), {
    action: 'read',
    target: 'page',
  });
  assert.deepEqual(validateCommand({ action: 'read', target: 's1' }, manifest), {
    action: 'read',
    target: 's1',
  });
  assert.deepEqual(validateCommand({ action: 'scroll', direction: 'down' }, manifest), {
    action: 'scroll',
    direction: 'down',
  });
  assert.deepEqual(validateCommand({ action: 'help' }, manifest), { action: 'help' });
});

test('أي هدف خارج القائمة يتحول إلى unknown', () => {
  for (const bad of [
    { action: 'navigate', target: 'privacy' },
    { action: 'navigate', target: '/politics' },
    { action: 'navigate', target: 'constructor' },
    { action: 'click', target: 'e999' },
    { action: 'read', target: 's99' },
    { action: 'scroll', direction: 'sideways' },
    { action: 'eval', code: 'alert(1)' },
    { action: 'navigate' },
    'ليس JSON',
    null,
    [],
    42,
  ]) {
    assert.equal(validateCommand(bad, manifest).action, 'unknown', JSON.stringify(bad));
  }
});

test('رسالة unknown تُنظَّف ويُقص طولها', () => {
  const out = validateCommand({ action: 'unknown', message: 'a\u0000b'.repeat(200) }, manifest);
  assert.equal(out.action, 'unknown');
  assert.ok(out.message.length <= 160);
  assert.ok(!out.message.includes('\u0000'));
});

test('sanitizeManifest يرفض المعرّفات الغريبة ويحد الأعداد', () => {
  const m = sanitizeManifest({
    pages: [{ id: 'bad id!', label: 'x' }, { id: 'ok', label: 'y' }],
    elements: Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, label: `زرار ${i}` })),
  });
  assert.deepEqual(m.pages.map((p) => p.id), ['ok']);
  assert.equal(m.elements.length, 100);
  assert.deepEqual(sanitizeManifest('junk').pages, []);
});

// ---------------- اختبار دالة السيرفر مع fetch وهمي ----------------
process.env.ANTHROPIC_API_KEY = 'test-key';
const { default: handler, resetRateLimits } = await import('../api/assistant.js');

function mockRes() {
  return {
    code: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.code = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

const makeReq = (over = {}) => ({
  method: 'POST',
  headers: { host: 'site.test', origin: 'https://site.test', 'x-forwarded-for': '1.2.3.4' },
  body: { text: 'خدني لصفحة سياسة', manifest },
  ...over,
});

const modelReply = (text) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ content: [{ type: 'text', text }] }),
});

test('السيرفر: رد سليم من الموديل', async () => {
  resetRateLimits();
  globalThis.fetch = modelReply('{"action":"navigate","target":"politics"}');
  const res = mockRes();
  await handler(makeReq(), res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.command, { action: 'navigate', target: 'politics' });
});

test('السيرفر: الموديل يحاول هدفًا خارج القائمة أو يضيف كلامًا', async () => {
  resetRateLimits();
  globalThis.fetch = modelReply('تمام: {"action":"navigate","target":"privacy"} شكرًا');
  const res = mockRes();
  await handler(makeReq(), res);
  assert.equal(res.body.command.action, 'unknown');
});

test('السيرفر: مفتاح الـ API لا يظهر في الرد ويُرسل في الهيدر فقط', async () => {
  resetRateLimits();
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return modelReply('{"action":"help"}')();
  };
  const res = mockRes();
  await handler(makeReq(), res);
  assert.equal(seen.init.headers['x-api-key'], 'test-key');
  assert.ok(!JSON.stringify(res.body).includes('test-key'));
  assert.ok(!seen.init.body.includes('test-key'));
});

test('السيرفر: rate limiting يرجّع 429', async () => {
  resetRateLimits();
  globalThis.fetch = modelReply('{"action":"help"}');
  let last;
  for (let i = 0; i < 16; i += 1) {
    last = mockRes();
    await handler(makeReq(), last);
  }
  assert.equal(last.code, 429);
});

test('السيرفر: timeout وخطأ المصدر والمدخلات الخاطئة', async () => {
  resetRateLimits();
  globalThis.fetch = async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  let res = mockRes();
  await handler(makeReq(), res);
  assert.equal(res.code, 504);

  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  res = mockRes();
  await handler(makeReq(), res);
  assert.equal(res.code, 502);

  res = mockRes();
  await handler(makeReq({ method: 'GET' }), res);
  assert.equal(res.code, 405);

  res = mockRes();
  await handler(makeReq({ headers: { host: 'site.test', origin: 'https://evil.test' } }), res);
  assert.equal(res.code, 403);

  res = mockRes();
  await handler(makeReq({ body: { text: 'x'.repeat(400), manifest } }), res);
  assert.equal(res.code, 400);
});
