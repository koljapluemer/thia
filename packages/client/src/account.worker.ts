import init, { PasswordExchange } from '../wasm/gestalts.js';
import type { Account } from './account';

type Attempt = { challenge: string; message: string };
type Saved = { account: string; generation: number; wrapping: CryptoKey; wrapped: string };
const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const utf8 = (value: string) => new TextEncoder().encode(value);

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch('/api/' + path, {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(response.status === 401 ? 'Check your email and password.' : error.error ?? 'Could not complete the account request.');
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

function context(account: Pick<Account, 'id' | 'generation'>, label: string) {
  return utf8(JSON.stringify([label, 1, account.id, account.generation]));
}

async function wrappingKey(exportKey: Uint8Array<ArrayBuffer>) {
  try {
    const input = await crypto.subtle.importKey('raw', exportKey, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('thia-personal-key-wrap-v1') },
      input, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  } finally { exportKey.fill(0); }
}

async function seal(key: Uint8Array<ArrayBuffer>, wrapping: CryptoKey, additionalData: Uint8Array<ArrayBuffer>) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, wrapping, key));
  return base64(new Uint8Array([...iv, ...ciphertext]));
}

async function open(wrapped: string, wrapping: CryptoKey, additionalData: Uint8Array<ArrayBuffer>) {
  const value = bytes(wrapped);
  return new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: value.subarray(0, 12), additionalData,
  }, wrapping, value.subarray(12)));
}

async function local<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('thia-account', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('unlock');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('unlock', mode);
      const request = operation(tx.objectStore('unlock'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function remember(account: Account, key: Uint8Array<ArrayBuffer>, wanted: boolean) {
  try {
    if (!wanted) {
      await local('readwrite', store => store.delete('current'));
      return true;
    }
    const wrapping = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const wrapped = await seal(key, wrapping, context(account, 'thia-browser-unlock'));
    await local('readwrite', store => store.put({ account: account.id, generation: account.generation, wrapping, wrapped } satisfies Saved, 'current'));
    return true;
  } catch { return false; }
}

type Parts = [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>];
type Request =
  | { type: 'login'; email: string; password: string; code?: string; remember: boolean }
  | { type: 'change'; account: Account; password: string; next: string; remember: boolean }
  | { type: 'restore'; account: Account }
  | { type: 'clear' };

async function perform(request: Request) {
  if (request.type === 'clear') {
    await local('readwrite', store => store.delete('current'));
    return;
  }
  if (request.type === 'restore') {
    const saved = await local<Saved | undefined>('readonly', store => store.get('current'));
    if (!saved) return;
    if (saved.account !== request.account.id || saved.generation !== request.account.generation) {
      await local('readwrite', store => {
        const get = store.get('current');
        get.onsuccess = () => {
          if (get.result?.account === saved.account && get.result?.generation === saved.generation) store.delete('current');
        };
        return get;
      });
      return;
    }
    return await open(saved.wrapped, saved.wrapping, context(request.account, 'thia-browser-unlock'));
  }
  await init();
  const exchange = new PasswordExchange();
  const password = utf8(request.password);
  const next = request.type === 'change' ? utf8(request.next) : undefined;
  try {
    if (request.type === 'change') {
      const account = request.account;
      const attempt = await post<Attempt & { registration: string; wrapped: string; generation: number }>('password/change/start', {
        message: base64(exchange.start(password, false)),
        registration: base64(exchange.start(next!, true)),
      });
      if (attempt.generation !== account.generation) throw new Error('Sign in again to change your password.');
      const [message, currentExport] = exchange.finish(password, bytes(attempt.message), false) as Parts;
      const key = await open(attempt.wrapped, await wrappingKey(currentExport), context(account, 'thia-server-unlock'));
      try {
        const [registration, nextExport] = exchange.finish(next!, bytes(attempt.registration), true) as Parts;
        const wrapped = await seal(key, await wrappingKey(nextExport), context({ ...account, generation: account.generation + 1 }, 'thia-server-unlock'));
        const updated = await post<Account>('password/change/finish', {
          challenge: attempt.challenge, message: base64(message), registration: base64(registration), wrapped, remember: request.remember,
        });
        return { account: updated, key: key.slice(), remembered: await remember(updated, key, request.remember) };
      } finally { key.fill(0); }
    }
    if (request.code !== undefined) {
      const attempt = await post<Attempt & { id: string }>('signup/start', {
        email: request.email, code: request.code, message: base64(exchange.start(password, true)),
      });
      const [message, exportKey] = exchange.finish(password, bytes(attempt.message), true) as Parts;
      const key = crypto.getRandomValues(new Uint8Array(32));
      try {
        const wrapped = await seal(key, await wrappingKey(exportKey), context({ id: attempt.id, generation: 0 }, 'thia-server-unlock'));
        await post('signup/finish', { challenge: attempt.challenge, message: base64(message), wrapped });
      } finally { key.fill(0); }
    }
    const attempt = await post<Attempt>('login/start', { email: request.email, message: base64(exchange.start(password, false)) });
    const [message, exportKey] = exchange.finish(password, bytes(attempt.message), false) as Parts;
    const wrapping = await wrappingKey(exportKey);
    const { account, wrapped } = await post<{ account: Account; wrapped: string }>('login/finish', {
      challenge: attempt.challenge, message: base64(message), remember: request.remember,
    });
    const key = await open(wrapped, wrapping, context(account, 'thia-server-unlock'));
    return { account, key, remembered: await remember(account, key, request.remember) };
  } finally {
    password.fill(0);
    next?.fill(0);
    exchange.free();
  }
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try { self.postMessage({ result: await perform(data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Could not complete sign-in.' }); }
};
