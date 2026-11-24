import sodium from 'libsodium-wrappers-sumo';

type Envelope = { version: 1; salt: string; wrapped: string; data: string };

const wrapContext = (account: string) => JSON.stringify(['thia-personal-key', 1, account]);
const dataContext = (account: string, revision: number) => JSON.stringify(['thia-personal-data', 1, account, revision]);
let key: Uint8Array | undefined;
let header: Omit<Envelope, 'data'> | undefined;

function seal(value: Uint8Array, context: string, secret: Uint8Array) {
  const nonce = sodium.randombytes_buf(24);
  const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(value, context, null, nonce, secret);
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return sodium.to_base64(combined);
}

function open(value: string, context: string, secret: Uint8Array) {
  const bytes = sodium.from_base64(value);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes.subarray(24), context, bytes.subarray(0, 24), secret);
}

self.onmessage = async ({ data }: MessageEvent<{ operation: 'unlock' | 'read' | 'write'; account: string; revision: number; value?: string; passphrase?: string }>) => {
  try {
    await sodium.ready;
    const { account, revision, operation, value } = data;
    if (operation === 'unlock') {
      const envelope = value === undefined ? undefined : JSON.parse(value) as Envelope;
      if (envelope && envelope.version !== 1) throw new Error('Unsupported backup format.');
      const salt = envelope ? sodium.from_base64(envelope.salt) : sodium.randombytes_buf(16);
      const wrappingKey = sodium.crypto_pwhash(32, data.passphrase!, salt, 3, 64 * 1024 * 1024, sodium.crypto_pwhash_ALG_ARGON2ID13);
      try {
        key = envelope ? open(envelope.wrapped, wrapContext(account), wrappingKey) : sodium.randombytes_buf(32);
        header = { version: 1, salt: sodium.to_base64(salt), wrapped: envelope?.wrapped ?? seal(key, wrapContext(account), wrappingKey) };
      } finally {
        sodium.memzero(wrappingKey);
      }
    }
    if (!key || !header) throw new Error('Unlock sync first.');
    let result: string | undefined;
    if (operation === 'write') {
      result = JSON.stringify({ ...header, data: seal(sodium.from_string(value!), dataContext(account, revision), key) });
    } else if (value !== undefined) {
      const envelope = JSON.parse(value) as Envelope;
      if (envelope.version !== 1 || envelope.wrapped !== header.wrapped) throw new Error('The encryption key changed. Unlock again.');
      result = sodium.to_string(open(envelope.data, dataContext(account, revision), key));
    }
    self.postMessage({ result });
  } catch {
    self.postMessage({ error: 'Could not unlock or encrypt the backup. Check your sync passphrase.' });
  }
};
