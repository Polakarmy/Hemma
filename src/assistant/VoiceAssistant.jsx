import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './voice-assistant.css';
import { PAGES } from './pages.js';
import { buildManifest, getPageText, getSectionText } from './manifest.js';
import { validateCommand } from './validate.js';
import { speak, stopSpeaking, isSpeaking, isMuted, setMuted, ttsSupported } from './speech.js';

const API_URL = import.meta.env.VITE_ASSISTANT_API_URL || '/api/assistant';
const REQUEST_TIMEOUT_MS = 10000;
const LISTEN_START_DELAY_MS = 700; // نمنح قارئ الشاشة وقتًا ليكمل إعلانه قبل فتح الميكروفون
const LISTEN_MAX_MS = 10000;
const NAV_SETTLE_MS = 1300; // الصفحات تبدأ قراءة ترحيبية بعد ثانية؛ نؤكد بعدها

const CONSENT_KEY = 'va-consent-v1';
const ZW = '​';

const T = {
  idle: 'المساعد الصوتي جاهز. اضغط Alt+V وقول أمرك.',
  listening: 'بسمعك… قول أمرك.',
  thinking: 'بفكر…',
  stopped: 'تم الإيقاف.',
  unsupported:
    'متصفحك مش بيدعم التعرف على الصوت. جرّب Google Chrome أو Microsoft Edge، أو اكتب الأمر في الخانة.',
  offline: 'مفيش اتصال بالإنترنت. جرّب تاني لما النت يرجع.',
  network: 'حصلت مشكلة في الاتصال. جرّب تاني.',
  timeout: 'الطلب أخد وقت طويل. حاول تاني.',
  rate: 'الطلبات كتير، استنى شوية وحاول تاني.',
  server: 'المساعد مش متاح دلوقتي. حاول بعد شوية.',
  noSpeech: 'مسمعتش حاجة. اضغط Alt+V وجرّب تاني.',
  micDenied: 'مفيش إذن للميكروفون. اسمح للموقع باستخدام الميكروفون من إعدادات المتصفح.',
  micMissing: 'مش لاقي ميكروفون شغال على الجهاز.',
  micFail: 'مقدرتش أشغّل الميكروفون. جرّب تاني.',
  langUnsupported: 'المتصفح مش بيدعم التعرف على اللغة العربية.',
  elementGone: 'العنصر ده مبقاش موجود في الصفحة.',
  nothingToRead: 'مفيش نص أقرأه هنا.',
  mutedRead: 'الصوت متوقف. فعّل الصوت عشان أقرأ لك، أو استخدم قارئ الشاشة.',
  consentDeclined: 'تمام، مش هشغّل المساعد. تقدر توافق في أي وقت.',
  consent:
    'قبل ما نبدأ: المتصفح هيحوّل صوتك لنص، والنص بيتبعت لسيرفر الموقع عشان يفهم الأمر. مش بنسجل صوتك ومش بنحفظ كلامك. موافق؟',
};

const STATUS_LABEL = {
  idle: 'جاهز',
  listening: 'بيسمع',
  thinking: 'بيفكر',
  speaking: 'بيتكلم',
  error: 'حصل خطأ',
};

const SHORT = { ok: 'تم', info: 'رد من المساعد', error: 'حصل خطأ' };

// حالة التشغيل (مثيل واحد للمساعد في الصفحة): نحتفظ بها خارج React لتبقى مستقرة في التنظيف.
const rt = { run: 0, timers: [], rec: null, abort: null, pendingText: null, memoryConsent: null };

const getRecognitionCtor = () =>
  typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null;

function readConsent() {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === 'yes' ? 'yes' : rt.memoryConsent;
  } catch {
    return rt.memoryConsent;
  }
}

function writeConsent(value) {
  rt.memoryConsent = value;
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    /* نكمل بالذاكرة لحد ما الصفحة تتقفل */
  }
}

const micError = (code) => {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return T.micDenied;
    case 'no-speech':
      return T.noSpeech;
    case 'audio-capture':
      return T.micMissing;
    case 'network':
      return T.network;
    case 'language-not-supported':
      return T.langUnsupported;
    default:
      return T.micFail;
  }
};

function later(fn, ms) {
  const id = setTimeout(fn, ms);
  rt.timers.push(id);
  return id;
}

function clearTimers() {
  rt.timers.forEach(clearTimeout);
  rt.timers = [];
}

// ينتظر مدة، ويتوقف تلقائيًا لو أُلغي التشغيل.
const wait = (ms) => new Promise((resolve) => later(resolve, ms));

function hardStop() {
  rt.run += 1;
  clearTimers();
  try {
    rt.rec?.abort();
  } catch {
    /* تجاهل */
  }
  rt.rec = null;
  rt.abort?.abort();
  rt.abort = null;
  stopSpeaking();
}

export default function VoiceAssistant() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('idle');
  const [heard, setHeard] = useState('');
  const [message, setMessage] = useState('');
  const [live, setLive] = useState('');
  const [alertText, setAlertText] = useState('');
  const [muted, setMutedState] = useState(() => isMuted());
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');

  const fabRef = useRef(null);
  const consentBtnRef = useRef(null);
  const flip = useRef(false);
  const latest = useRef({});

  // ---------- مساعدات العرض والإعلان ----------
  const announce = (text) => {
    flip.current = !flip.current;
    setLive(text + (flip.current ? ZW : ''));
  };

  const alertNow = (text) => {
    flip.current = !flip.current;
    setAlertText(text + (flip.current ? ZW : ''));
  };

  const canSpeak = () => ttsSupported() && !isMuted();

  // الرد النهائي: لو الصوت شغال نعلن كلمة قصيرة فقط لقارئ الشاشة (حتى لا يتكلم فوق الصوت)،
  // ولو الصوت مكتوم نعلن النص كامل في منطقة aria-live.
  const report = async (text, run, kind = 'ok') => {
    if (run !== rt.run) return;
    setMessage(text);
    const spoken = canSpeak();
    if (kind === 'error') {
      setStatus('error');
      alertNow(spoken ? SHORT.error : text);
    } else {
      setAlertText('');
      announce(spoken ? SHORT[kind] : text);
      setStatus('idle');
    }
    if (!spoken) return;
    setStatus('speaking');
    await speak(text);
    if (run === rt.run) setStatus('idle');
  };

  const stopAll = (next = 'idle') => {
    hardStop();
    setStatus(next);
  };

  const begin = () => {
    stopAll('idle');
    setAlertText('');
    return rt.run;
  };

  // ---------- تنفيذ الأوامر (بعد التحقق من الـ whitelist) ----------
  const execute = async (cmd, m, run) => {
    switch (cmd.action) {
      case 'navigate': {
        const page = PAGES.find((p) => p.id === cmd.target);
        if (!page) return report(T.elementGone, run, 'error');
        if (window.location.pathname === page.path) {
          return report(`أنت بالفعل في ${page.spoken}`, run);
        }
        stopSpeaking();
        navigate(page.path);
        window.scrollTo(0, 0);
        await wait(NAV_SETTLE_MS);
        if (run !== rt.run) return undefined;
        stopSpeaking(); // نوقف القراءة الترحيبية التلقائية للصفحة الجديدة قبل التأكيد
        return report(`تم، أنت دلوقتي في ${page.spoken}`, run);
      }

      case 'click': {
        const el = m.elements.get(cmd.target);
        const label = m.public.elements.find((e) => e.id === cmd.target)?.label ?? '';
        if (!el || !el.isConnected) return report(T.elementGone, run, 'error');
        stopSpeaking();
        el.click();
        await wait(350);
        if (run !== rt.run) return undefined;
        const text = `تم، ضغطت على ${label}`;
        if (isSpeaking()) {
          // الموقع بدأ يقرأ بنفسه (زرار استمع): لا نقطع قراءته.
          setMessage(text);
          announce(canSpeak() ? SHORT.ok : text);
          setStatus('idle');
          return undefined;
        }
        return report(text, run);
      }

      case 'read': {
        let text;
        let label;
        if (cmd.target === 'page') {
          text = getPageText();
          label = 'الصفحة';
        } else {
          text = getSectionText(m.sections.get(cmd.target));
          label = m.public.sections.find((s) => s.id === cmd.target)?.label ?? 'القسم';
        }
        if (!text) return report(T.nothingToRead, run, 'error');
        if (!canSpeak()) return report(T.mutedRead, run, 'info');
        setMessage(`بقرأ: ${label}`);
        announce(SHORT.ok);
        setStatus('speaking');
        await speak(text);
        if (run === rt.run) {
          setStatus('idle');
          setMessage('خلصت القراءة.');
        }
        return undefined;
      }

      case 'scroll': {
        stopSpeaking();
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const behavior = reduce ? 'auto' : 'smooth';
        const before = window.scrollY;
        const doc = document.scrollingElement || document.documentElement;
        const step = Math.round(window.innerHeight * 0.8);
        if (cmd.direction === 'down') window.scrollBy({ top: step, behavior });
        if (cmd.direction === 'up') window.scrollBy({ top: -step, behavior });
        if (cmd.direction === 'top') window.scrollTo({ top: 0, behavior });
        if (cmd.direction === 'bottom') window.scrollTo({ top: doc.scrollHeight, behavior });
        await wait(700);
        if (run !== rt.run) return undefined;
        const stuck = Math.abs(window.scrollY - before) < 2;
        const said = {
          down: stuck ? 'وصلت لآخر الصفحة' : 'تم، نزلت لتحت',
          up: stuck ? 'إنت في أول الصفحة' : 'تم، طلعت لفوق',
          top: 'تم، رجعت لأول الصفحة',
          bottom: 'تم، وصلت لآخر الصفحة',
        }[cmd.direction];
        return report(said, run);
      }

      case 'help': {
        const names = PAGES.map((p) => p.label).join('، أو ');
        return report(
          `تقدر تقول: روح لصفحة ${names}. أو: اضغط على، واسم الزرار. أو: اقرأ الصفحة، أو اقرأ، واسم القسم. أو: انزل، أو اطلع، أو رجّعني لفوق. لإيقاف الصوت اضغط Escape، وللتكلم اضغط Alt و V.`,
          run,
          'info',
        );
      }

      default:
        return report(cmd.message, run, 'info');
    }
  };

  // ---------- إرسال النص للسيرفر ----------
  const handleCommand = async (text, run) => {
    setHeard(text);
    setStatus('thinking');
    setMessage(T.thinking);
    announce(T.thinking);

    if (!navigator.onLine) {
      await report(T.offline, run, 'error');
      return;
    }

    const m = buildManifest(PAGES);
    const ctrl = new AbortController();
    rt.abort = ctrl;
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let cmd;
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, manifest: m.public }),
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
      if (res.status === 429) {
        await report(T.rate, run, 'error');
        return;
      }
      if (!res.ok) {
        await report(T.server, run, 'error');
        return;
      }
      const data = await res.json();
      cmd = validateCommand(data?.command, m.public);
    } catch {
      if (run !== rt.run) return; // أوقفه المستخدم
      await report(ctrl.signal.aborted ? T.timeout : T.network, run, 'error');
      return;
    } finally {
      clearTimeout(timer);
    }
    if (run !== rt.run) return;
    await execute(cmd, m, run);
  };

  // ---------- الاستماع ----------
  const startListening = () => {
    const SR = getRecognitionCtor();
    const run = begin();
    if (!SR) {
      report(T.unsupported, run, 'error');
      return;
    }
    setHeard('');
    setMessage(T.listening);
    setStatus('listening');
    announce(T.listening);

    later(() => {
      if (run !== rt.run) return;
      const rec = new SR();
      rec.lang = 'ar-EG';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      let done = false;

      rec.onresult = (e) => {
        if (done || run !== rt.run) return;
        done = true;
        const text = (e.results?.[0]?.[0]?.transcript || '').trim();
        if (!text) {
          report(T.noSpeech, run, 'error');
          return;
        }
        handleCommand(text, run);
      };
      rec.onerror = (e) => {
        if (done || run !== rt.run || e.error === 'aborted') return;
        done = true;
        report(micError(e.error), run, 'error');
      };
      rec.onend = () => {
        if (done || run !== rt.run) return;
        done = true;
        report(T.noSpeech, run, 'error');
      };

      rt.rec = rec;
      try {
        rec.start();
      } catch {
        done = true;
        report(T.micFail, run, 'error');
        return;
      }
      later(() => {
        if (run === rt.run && !done) {
          try {
            rec.stop();
          } catch {
            /* تجاهل */
          }
        }
      }, LISTEN_MAX_MS);
    }, LISTEN_START_DELAY_MS);
  };

  // ---------- الموافقة قبل أول استخدام ----------
  const askConsent = () => {
    stopAll('idle');
    setAsking(true);
    setMessage(T.consent);
    if (canSpeak()) speak(T.consent);
    later(() => consentBtnRef.current?.focus(), 50);
  };

  const accept = () => {
    writeConsent('yes');
    setAsking(false);
    const pending = rt.pendingText;
    rt.pendingText = null;
    if (pending) {
      const run = begin();
      handleCommand(pending, run);
    } else {
      startListening();
    }
  };

  const decline = () => {
    rt.pendingText = null;
    setAsking(false);
    stopSpeaking();
    setMessage(T.consentDeclined);
    announce(T.consentDeclined);
    fabRef.current?.focus();
  };

  // ---------- أوامر الواجهة ----------
  const activate = () => {
    setOpen(true);
    if (asking) return;
    if (status === 'listening') {
      stopAll('idle');
      setMessage(T.stopped);
      announce(T.stopped);
      return;
    }
    if (readConsent() !== 'yes') {
      askConsent();
      return;
    }
    startListening();
  };

  const submitTyped = (e) => {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    setTyped('');
    if (readConsent() !== 'yes') {
      rt.pendingText = text;
      askConsent();
      return;
    }
    const run = begin();
    handleCommand(text, run);
  };

  const stopTalking = () => {
    stopAll('idle');
    setMessage(T.stopped);
    announce(T.stopped);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    const text = next
      ? 'الصوت متوقف. الردود هتظهر لقارئ الشاشة فقط.'
      : 'الصوت شغال.';
    setMessage(text);
    announce(text);
  };

  const askHelp = () => {
    const run = begin();
    setOpen(true);
    execute({ action: 'help' }, null, run);
  };

  const closePanel = () => {
    stopAll('idle');
    setAsking(false);
    setOpen(false);
    fabRef.current?.focus();
  };

  const escape = () => {
    if (asking) {
      decline();
      return;
    }
    if (status !== 'idle' || isSpeaking()) {
      stopTalking();
      return;
    }
    if (open) closePanel();
  };

  // نحدّث المرجع بعد كل رسم حتى يقرأ مستمع الكيبورد أحدث نسخة من الدوال.
  useEffect(() => {
    latest.current = { activate, escape };
  });

  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyV') {
        e.preventDefault();
        latest.current.activate?.();
        return;
      }
      if (e.key === 'Escape') latest.current.escape?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      hardStop();
    };
  }, []);

  return (
    <div className="va-root" dir="rtl" lang="ar">
      <div className="va-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {live}
      </div>
      <div className="va-sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {alertText}
      </div>

      {open && (
        <section className="va-panel" role="dialog" aria-modal="false" aria-labelledby="va-title">
          <div className="va-panel-head">
            <p id="va-title" className="va-title">
              المساعد الصوتي
            </p>
            <button type="button" className="va-btn" onClick={closePanel}>
              إغلاق
            </button>
          </div>

          {asking ? (
            <div className="va-consent">
              <p id="va-consent-text">{T.consent}</p>
              <div className="va-actions">
                <button
                  type="button"
                  ref={consentBtnRef}
                  className="va-btn va-btn-primary"
                  aria-describedby="va-consent-text"
                  onClick={accept}
                >
                  موافق
                </button>
                <button type="button" className="va-btn" onClick={decline}>
                  مش موافق
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="va-status">الحالة: {STATUS_LABEL[status]}</p>
              <p className="va-message">{message || T.idle}</p>
              {heard && <p className="va-heard">سمعت: {heard}</p>}

              <div className="va-actions">
                <button type="button" className="va-btn va-btn-primary" onClick={activate}>
                  {status === 'listening' ? 'إيقاف الاستماع' : 'تكلّم (Alt+V)'}
                </button>
                <button type="button" className="va-btn" onClick={stopTalking}>
                  إيقاف الكلام
                </button>
                <button type="button" className="va-btn" aria-pressed={muted} onClick={toggleMute}>
                  {muted ? 'تشغيل الصوت' : 'كتم الصوت'}
                </button>
                <button type="button" className="va-btn" onClick={askHelp}>
                  مساعدة
                </button>
              </div>

              <form className="va-form" onSubmit={submitTyped}>
                <label htmlFor="va-typed">أو اكتب أمرك</label>
                <input
                  id="va-typed"
                  className="va-input"
                  type="text"
                  value={typed}
                  maxLength={300}
                  enterKeyHint="send"
                  autoComplete="off"
                  onChange={(e) => setTyped(e.target.value)}
                />
                <button type="submit" className="va-btn va-btn-primary">
                  إرسال
                </button>
              </form>
            </>
          )}
        </section>
      )}

      <button
        type="button"
        ref={fabRef}
        className="va-fab"
        data-status={status}
        aria-label="المساعد الصوتي. اضغط للتحدث بأمر صوتي. الاختصار Alt زائد V"
        aria-keyshortcuts="Alt+V"
        aria-pressed={status === 'listening'}
        onClick={(e) => {
          e.stopPropagation(); // حتى لا يصل النقر لمستمعي window الخاصة بالموقع (القراءة الترحيبية)
          activate();
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <line x1="12" y1="18" x2="12" y2="22" />
        </svg>
        <span aria-hidden="true">المساعد الصوتي</span>
        <span className="va-fab-key" aria-hidden="true">
          Alt+V
        </span>
      </button>
    </div>
  );
}
