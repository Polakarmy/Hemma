// الرد الصوتي (Speech Synthesis) بالعربي، مع تقسيم النص الطويل وإمكانية الكتم الفوري.

const MUTE_KEY = 'va-muted';

let muted = false;
try {
  muted = window.localStorage.getItem(MUTE_KEY) === '1';
} catch {
  /* التخزين قد يكون محجوبًا: نكمل بدونه */
}

let token = 0;
let resolveCurrent = null;

export const ttsSupported = () =>
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  typeof window.SpeechSynthesisUtterance !== 'undefined';

export const isMuted = () => muted;

export function setMuted(value) {
  muted = Boolean(value);
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* تجاهل */
  }
  if (muted) stopSpeaking();
}

export const isSpeaking = () => ttsSupported() && window.speechSynthesis.speaking;

export function stopSpeaking() {
  token += 1;
  if (ttsSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* تجاهل */
    }
  }
  if (resolveCurrent) {
    const done = resolveCurrent;
    resolveCurrent = null;
    done();
  }
}

// تقسيم عند علامات الترقيم/الأسطر حتى لا يتوقف النطق في النصوص الطويلة (مشكلة معروفة في Chrome).
function toChunks(text, max = 180) {
  const out = [];
  for (const line of text.split('\n')) {
    const pieces = line.match(/[^.!?؟،؛:]+[.!?؟،؛:]*\s*/g) || [line];
    let buf = '';
    const flush = () => {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    };
    for (const piece of pieces) {
      if (piece.length > max) {
        flush();
        let part = '';
        for (const word of piece.split(/\s+/)) {
          if ((part + ' ' + word).length > max) {
            if (part) out.push(part.trim());
            part = word;
          } else {
            part = part ? part + ' ' + word : word;
          }
        }
        if (part) out.push(part.trim());
      } else if ((buf + piece).length > max) {
        flush();
        buf = piece;
      } else {
        buf += piece;
      }
    }
    flush();
  }
  return out;
}

function pickVoice() {
  try {
    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find((v) => v.lang === 'ar-EG') ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('ar')) ||
      null
    );
  } catch {
    return null;
  }
}

// تُرجع Promise تكتمل عند انتهاء الكلام أو إيقافه. لو الصوت مكتوم تكتمل فورًا.
export function speak(text) {
  stopSpeaking();
  return new Promise((resolve) => {
    if (!ttsSupported() || muted || !text) {
      resolve();
      return;
    }
    const mine = token;
    resolveCurrent = resolve;
    const chunks = toChunks(text);
    const voice = pickVoice();
    let i = 0;

    const next = () => {
      if (mine !== token || i >= chunks.length) {
        if (mine === token) resolveCurrent = null;
        resolve();
        return;
      }
      const u = new window.SpeechSynthesisUtterance(chunks[i]);
      i += 1;
      u.lang = 'ar-EG';
      u.rate = 0.95;
      if (voice) u.voice = voice;
      u.onend = next;
      u.onerror = next;
      window.speechSynthesis.speak(u);
    };

    // تأخير بسيط بعد cancel() لأن Chrome أحيانًا يُسقط أول جملة.
    setTimeout(next, 60);
  });
}
