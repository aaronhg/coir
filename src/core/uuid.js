// Cocos Creator UUID compression.
//
// Algorithm from Cocos Creator v2.0.10's `compressUuid` / `decompressUuid`.
// The same scheme is used by Creator 3.x for the compressed script id stored in
// a serialized component's `__type__` field. A 32-hex UUID compresses to a
// 23-char token: the first 5 hex chars are kept literally, the remaining 27 hex
// chars are base64-encoded.

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Array(128).fill(0);
for (let i = 0; i < 64; i++) BASE64_VALUES[BASE64_KEYS.charCodeAt(i)] = i;

const HYPHEN = /-/g;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX32_RE = /^[0-9a-fA-F]{32}$/;

export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function compressUuid(uuid, min = false) {
  if (UUID_RE.test(uuid)) uuid = uuid.replace(HYPHEN, '');
  else if (!HEX32_RE.test(uuid)) return uuid;
  return compressHex(uuid, min ? 2 : 5);
}

function compressHex(hex, reserved) {
  let i = reserved;
  const out = [];
  const head = hex.slice(0, i);
  for (; i < hex.length; i += 3) {
    const a = parseInt(hex[i], 16);
    const b = parseInt(hex[i + 1], 16);
    const c = parseInt(hex[i + 2], 16);
    out.push(BASE64_KEYS[(a << 2) | (b >> 2)]);
    out.push(BASE64_KEYS[((b & 3) << 4) | c]);
  }
  return head + out.join('');
}

export function decompressUuid(token) {
  if (token.length === 23) {
    const arr = [];
    for (let i = 5; i < 23; i += 2) {
      const a = BASE64_VALUES[token.charCodeAt(i)];
      const b = BASE64_VALUES[token.charCodeAt(i + 1)];
      arr.push((a >> 2).toString(16), (((a & 3) << 2) | (b >> 4)).toString(16), (b & 15).toString(16));
    }
    token = token.slice(0, 5) + arr.join('');
  } else if (token.length === 22) {
    const arr = [];
    for (let i = 2; i < 22; i += 2) {
      const a = BASE64_VALUES[token.charCodeAt(i)];
      const b = BASE64_VALUES[token.charCodeAt(i + 1)];
      arr.push((a >> 2).toString(16), (((a & 3) << 2) | (b >> 4)).toString(16), (b & 15).toString(16));
    }
    token = token.slice(0, 2) + arr.join('');
  } else {
    return token;
  }
  return `${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20)}`;
}

// A reference can carry a sub-asset id: "uuid@subid". The owning asset is keyed
// by the main uuid; the sub-id selects a sprite-frame / texture inside it.
export function mainUuid(ref) {
  const at = ref.indexOf('@');
  return at === -1 ? ref : ref.slice(0, at);
}

export function subOf(ref) {
  const at = ref.indexOf('@');
  return at === -1 ? null : ref.slice(at + 1);
}

const COMPRESSED23_RE = /^[0-9a-fA-F]{5}[0-9a-zA-Z+/]{18}$/;
const COMPRESSED22_RE = /^[0-9a-fA-F]{2}[0-9a-zA-Z+/]{20}$/;

// Heuristic: does a serialized `__type__` token look like a compressed script
// uuid (rather than a builtin class name such as "cc.Sprite" or "TypedArray")?
// The decompressed value is still verified against the asset index downstream.
export function looksCompressed(token) {
  if (token.length === 23) return COMPRESSED23_RE.test(token);
  if (token.length === 22) return COMPRESSED22_RE.test(token);
  return false;
}
