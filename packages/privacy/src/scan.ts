/**
 * Outbound scan. Runs on every value that survived the allowlist, as a second
 * line of defence: if anything here fires, the whole result is thrown away.
 * Detectors report their name only, never the text that matched.
 */
export interface Detector {
  id: string;
  test(text: string): boolean;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/, // JWT
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:0x)?[0-9a-fA-F]{64}\b/, // raw 256-bit key
  /\b(?:pass(?:word|wd)?|secret|api[_ -]?key|token)\s*[:=]\s*\S{4,}/i,
  /\b(?:sessionid|session_id|csrftoken|li_at|auth_token)\s*=\s*\S+/i,
];

const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|system|all)\b[^.\n]{0,40}\b(?:instruction|prompt|rule|direction|message)s?\b/i,
  /\bsystem\s+(?:prompt|message|instruction)s?\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+(?:the\s+)?(?:user|human|operator)\b/i,
  /<\/?\s*(?:system|assistant|user|tool|instructions?)\b[^>]*>/i,
  /\[\/?\s*(?:INST|SYSTEM)\s*\]/i,
  /\bBEGIN\s+(?:SYSTEM|INSTRUCTIONS?)\b/,
  /\b(?:as|to)\s+(?:an?\s+)?(?:ai|llm|language\s+model|assistant|agent)\b[^.\n]{0,60}\b(?:must|should|have\s+to|need\s+to)\b/i,
];

export const DETECTORS: readonly Detector[] = [
  {
    id: "email",
    test: (t) =>
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(t) ||
      /\b[\w.+-]+\s*(?:\(at\)|\[at\]|\{at\}|\sat\s)\s*[\w-]+\s*(?:\(dot\)|\[dot\]|\{dot\}|\sdot\s)\s*[a-z]{2,}\b/i.test(t),
  },
  {
    id: "phone",
    test: (t) => /(?:\+?\d[\s().-]{0,2}){9,}/.test(t),
  },
  {
    id: "card_number",
    test: (t) => {
      for (const match of t.matchAll(/(?:\d[ -]?){13,19}/g)) {
        const digits = match[0].replace(/\D/g, "");
        if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
      }
      return false;
    },
  },
  {
    id: "secret",
    test: (t) => SECRET_PATTERNS.some((p) => p.test(t)),
  },
  {
    id: "high_entropy_token",
    test: (t) => {
      for (const match of t.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
        const token = match[0];
        if (/[0-9]/.test(token) && /[A-Za-z]/.test(token) && shannonEntropy(token) >= 4) return true;
      }
      return false;
    },
  },
  {
    id: "credential_url",
    test: (t) =>
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i.test(t) ||
      /https?:\/\/\S*[?&](?:token|key|secret|sig|signature|password|auth|session)[a-z_]*=/i.test(t),
  },
  {
    id: "prompt_injection",
    test: (t) => INJECTION_PATTERNS.some((p) => p.test(t)),
  },
  {
    id: "markup",
    test: (t) =>
      /<\s*\/?\s*[a-z][a-z0-9-]*(?:\s[^>]*)?>/i.test(t) ||
      /\bjavascript\s*:/i.test(t) ||
      /!\[[^\]]*\]\([^)]*\)/.test(t) ||
      /\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i.test(t),
  },
  {
    id: "hidden_characters",
    // control characters, zero-width and bidirectional overrides, tag characters
    test: (t) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/.test(t),
  },
];

/** Returns the ids of the detectors that fired on `text`, skipping any in `exempt`. */
export function scanText(text: string, exempt: readonly string[] = []): string[] {
  const hits: string[] = [];
  for (const detector of DETECTORS) {
    if (exempt.includes(detector.id)) continue;
    if (detector.test(text)) hits.push(detector.id);
  }
  return hits;
}
