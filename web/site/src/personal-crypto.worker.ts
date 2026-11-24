import sodium from 'libsodium-wrappers-sumo';

const context = (account: string, revision: number) => JSON.stringify(['thia-personal-data', 2, account, revision]);
let key: Uint8Array | undefined;

self.onmessage = async ({ data }: MessageEvent<{
  operation: 'unlock' | 'read' | 'write';
  account: string;
  revision: number;
  value?: string;
  key?: Uint8Array;
}>) => {
  try {
    await sodium.ready;
    const { account, revision, operation, value } = data;
    if (operation === 'unlock') {
      if (data.key?.length !== 32) throw new Error('Invalid sync key.');
      key = data.key;
      self.postMessage({});
      return;
    }
    if (!key || value === undefined) throw new Error('Sign in to sync.');
    const aad = context(account, revision);
    if (operation === 'write') {
      const nonce = sodium.randombytes_buf(24);
      const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        sodium.from_string(value), aad, null, nonce, key,
      );
      const combined = new Uint8Array(nonce.length + encrypted.length);
      combined.set(nonce);
      combined.set(encrypted, nonce.length);
      self.postMessage({ result: JSON.stringify({ version: 2, data: sodium.to_base64(combined) }) });
    } else {
      const envelope = JSON.parse(value) as { version: number; data: string };
      if (envelope.version !== 2) throw new Error('Unsupported backup format.');
      const bytes = sodium.from_base64(envelope.data);
      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, bytes.subarray(24), aad, bytes.subarray(0, 24), key,
      );
      self.postMessage({ result: sodium.to_string(plaintext) });
    }
  } catch {
    self.postMessage({ error: 'Could not read or encrypt synced progress.' });
  }
};
