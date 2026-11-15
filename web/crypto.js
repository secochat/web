// Ende-zu-Ende-Verschlüsselung mit der Web Crypto API
// RSA-OAEP-2048 (Schlüsselaustausch) + AES-256-GCM (Nachrichten)
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = crypto.subtle;

export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const RSA = { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

async function passwordKey(password, salt) {
  const base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

/** Neues Schlüsselpaar; der private Schlüssel wird mit dem Passwort verschlüsselt. */
export async function generateKeyMaterial(password) {
  const pair = await subtle.generateKey(RSA, true, ["encrypt", "decrypt"]);
  const publicKey = b64(await subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await passwordKey(password, salt);
  const encPrivate = await subtle.encrypt({ name: "AES-GCM", iv }, kek, pkcs8);
  return { public_key: publicKey, enc_private_key: b64(encPrivate), key_salt: b64(salt), key_iv: b64(iv) };
}

/** Privaten Schlüssel entsperren (nicht exportierbar im Speicher gehalten). */
export async function unlockPrivateKey(profile, password) {
  const kek = await passwordKey(password, unb64(profile.key_salt));
  const pkcs8 = await subtle.decrypt({ name: "AES-GCM", iv: unb64(profile.key_iv) }, kek, unb64(profile.enc_private_key));
  return subtle.importKey("pkcs8", pkcs8, RSA, false, ["decrypt"]);
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
  return out.join("");
}
