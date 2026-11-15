// Ende-zu-Ende-Verschlüsselung mit der Web Crypto API
// RSA-OAEP-2048 (Schlüsselaustausch) + AES-256-GCM (Nachrichten)
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = crypto.subtle;

export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const RSA = { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

async function deriveKey(secret, salt) {
  const base = await subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

/** Privaten Schlüssel (PKCS8) mit einem Geheimnis (Passwort oder Wiederherstellungsschlüssel) verpacken. */
async function wrapPrivate(pkcs8, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await deriveKey(secret, salt);
  const out = await subtle.encrypt({ name: "AES-GCM", iv }, kek, pkcs8);
  return { enc: b64(out), salt: b64(salt), iv: b64(iv) };
}

async function unwrapPrivate({ enc: e, salt, iv }, secret) {
  const kek = await deriveKey(secret, unb64(salt));
  return subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, kek, unb64(e));
}

const importPrivate = (pkcs8) => subtle.importKey("pkcs8", pkcs8, RSA, false, ["decrypt"]);

/** Wiederherstellungsschlüssel, z. B. "K7QP-2MXZ-4RWD-9HFA-3TBC-8NVE" (120 Bit) */
export function randomRecoveryKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 Zeichen
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const chars = Array.from(bytes, (b) => alphabet[b % 32]);
  return chars.join("").match(/.{4}/g).join("-");
}
const normRecovery = (k) => String(k).replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/**
 * Neues Schlüsselpaar. Der private Schlüssel wird zweimal verpackt:
 * einmal mit dem Passwort, einmal mit einem zufälligen Wiederherstellungsschlüssel.
 * Der Wiederherstellungsschlüssel wird NICHT gespeichert, nur dem Nutzer angezeigt.
 */
export async function generateKeyMaterial(password) {
  const pair = await subtle.generateKey(RSA, true, ["encrypt", "decrypt"]);
  const publicKey = b64(await subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  const recoveryKey = randomRecoveryKey();
  const pw = await wrapPrivate(pkcs8, password);
  const rec = await wrapPrivate(pkcs8, normRecovery(recoveryKey));
  return {
    recoveryKey,
    meta: {
      public_key: publicKey,
      enc_private_key: pw.enc, key_salt: pw.salt, key_iv: pw.iv,
      rec_enc_private_key: rec.enc, rec_salt: rec.salt, rec_iv: rec.iv,
    },
  };
}

/** Privaten Schlüssel mit dem Passwort entsperren (nicht exportierbar im Speicher gehalten). */
export async function unlockPrivateKey(profile, password) {
  const pkcs8 = await unwrapPrivate(
    { enc: profile.enc_private_key, salt: profile.key_salt, iv: profile.key_iv }, password);
  return importPrivate(pkcs8);
}

/**
 * Mit dem Wiederherstellungsschlüssel entsperren und gleichzeitig mit einem neuen Passwort neu verpacken.
 * Wirft einen Fehler, wenn der Schlüssel falsch ist oder keiner hinterlegt wurde.
 */
export async function recoverWithKey(profile, recoveryKey, newPassword) {
  if (!profile.rec_enc_private_key) throw new Error("Kein Wiederherstellungsschlüssel hinterlegt");
  const pkcs8 = await unwrapPrivate(
    { enc: profile.rec_enc_private_key, salt: profile.rec_salt, iv: profile.rec_iv }, normRecovery(recoveryKey));
  const w = await wrapPrivate(pkcs8, newPassword);
  return {
    key: await importPrivate(pkcs8),
    fields: { enc_private_key: w.enc, key_salt: w.salt, key_iv: w.iv },
  };
}

const importPublic = (b) => subtle.importKey("spki", unb64(b), RSA, false, ["encrypt"]);

/** Text verschlüsseln: ein AES-Schlüssel pro Nachricht, einmal für Empfänger und einmal für Absender verpackt. */
export async function encryptMessage(text, recipientPub, senderPub) {
  const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(text));
  const raw = await subtle.exportKey("raw", aes);
  const wrap = async (pub) => b64(await subtle.encrypt({ name: "RSA-OAEP" }, await importPublic(pub), raw));
  return {
    ciphertext: b64(ciphertext),
    iv: b64(iv),
    key_for_recipient: await wrap(recipientPub),
    key_for_sender: await wrap(senderPub),
  };
}

export async function decryptMessage(privateKey, wrappedKey, iv, ciphertext) {
  const raw = await subtle.decrypt({ name: "RSA-OAEP" }, privateKey, unb64(wrappedKey));
  const aes = await subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, aes, unb64(ciphertext));
  return dec.decode(plain);
}

/** Zufälliger Sicherheitscode, z. B. "k7Qp&2mXz4Rw" */
export function randomCode(len = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const sym = "&#$%!?+=";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = Array.from(bytes, (b) => chars[b % chars.length]);
  out[Math.floor(Math.random() * len)] = sym[bytes[0] % sym.length];
  // mindestens eine Ziffer garantieren (wird von der Registrierung verlangt)
  if (!/\d/.test(out.join(""))) out[(Math.floor(Math.random() * len) + 1) % len] = "7";
  return out.join("");
}
