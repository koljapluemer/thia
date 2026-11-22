/** The workshop server's API (web/server), on this origin under /api, with the session cookie. */

export type Me = { email: string; school: string; admin: boolean; maintainer: boolean };
/** What a draft makes: a learning view, a visualization, or a lesson of several views. */
export type Kind = 'view' | 'viz' | 'sequence';
export type DraftInfo = { id: string; package: string; kind: Kind; title: string; created: string };
export type Publication = { id: string; url: string; manifest: string; updated: string; revoked: string | null; warnings: string[] };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly problems: string[] = []) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const r = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    ...(json === undefined ? {} : { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } }),
  });
  if (r.status === 204) return undefined as T;
  const body = (await r.json().catch(() => ({}))) as { error?: string; problems?: string[] };
  if (!r.ok) throw new ApiError(body.error ?? `the server answered ${r.status}`, r.status, body.problems ?? []);
  return body as T;
}

export const me = () => api<Me>('/me');
export const login = (email: string, password: string) => api<Me>('/login', { method: 'POST', json: { email, password } });
export const logout = () => api<void>('/logout', { method: 'POST' });
export const drafts = () => api<DraftInfo[]>('/drafts');
export const newDraft = (title: string, kind: Kind) => api<DraftInfo>('/drafts', { method: 'POST', json: { title, kind } });
/** A draft that was kept in this browser, moved to the account: its id and package stay. */
export const moveDraft = (title: string, kind: Kind, moved: { id: string; package: string }) =>
  api<DraftInfo>('/drafts', { method: 'POST', json: { title, kind, moved } });
export const deleteDraft = (id: string) => api<void>(`/drafts/${id}`, { method: 'DELETE' });
export const publication = (id: string) => api<Publication | null>(`/drafts/${id}/publication`);
/** Published for `runtime`, this page's frame runtime: what its preview runs, and the player the lesson's link serves. */
export const publish = (id: string, runtime: string) => api<Publication>(`/drafts/${id}/publish`, { method: 'POST', json: { runtime } });
export const unpublish = (id: string) => api<void>(`/drafts/${id}/publication`, { method: 'DELETE' });

/** A workshop's result offered for the public site, and what became of it. */
export type Submission = {
  id: string; kind: 'view' | 'viz'; email: string; source: string; title: string; about: string; credit: string | null;
  created: string; status: 'pending' | 'accepted' | 'rejected'; decided: string | null; note: string | null; promoted: string | null;
};
/** What the sender says about it; `rights`: they may share it, and agree to it being published. */
export type Offer = { about: string; credit?: string; rights: boolean };
/** Ymls as sync writes them, and the blobs they use (base64). */
export type Snapshot = { ymls: { id: string; text: string }[]; blobs: Record<string, string> };
/** Where accepting puts it: `plugin` and `package` for a view, `deck` for both. */
export type Target = { plugin?: string; package?: string; deck: string };
export type Promoted = { at: string; written: string[]; next: string[]; warnings: string[] };

export const submissionsOf = (source: string) => api<Submission[]>(`/submissions?source=${encodeURIComponent(source)}`);
export const submitDraft = (id: string, offer: Offer) => api<Submission>(`/drafts/${id}/submit`, { method: 'POST', json: offer });
/** Writes ymls into a draft as its sync does, checked as they are; then the blobs. */
export async function writeDraft(id: string, s: Snapshot) {
  if (s.ymls.length) await api<void>(`/drafts/${id}/sync/write`, { method: 'POST', json: s.ymls });
  for (const [name, b64] of Object.entries(s.blobs)) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await api<void>(`/drafts/${id}/blobs/${encodeURIComponent(name)}`, { method: 'PUT', body: bytes });
  }
}

export const queue = () => api<{ submissions: Submission[]; repo: string | null }>('/admin/submissions');
export const submission = (id: string) => api<Submission & { ymls: { id: string; text: string }[]; proposed: Target }>(`/admin/submissions/${id}`);
export const accept = (id: string, t: Target) => api<Promoted>(`/admin/submissions/${id}/accept`, { method: 'POST', json: t });
export const reject = (id: string, note: string) => api<void>(`/admin/submissions/${id}/reject`, { method: 'POST', json: { note } });
/** A submission as a read-only deck, for its preview. */
export const submissionDeck = (id: string) => `${location.origin}/api/admin/submissions/${id}/deck`;

/** Bundles a view's npm imports at the pinned versions; where each is served, as absolute URLs (the frame's origin is `null`). */
export async function resolveNpm(imports: string[], versions: Record<string, string>): Promise<Record<string, string>> {
  const paths = await api<Record<string, string>>('/npm', { method: 'POST', json: { npm: versions, imports } });
  return Object.fromEntries(Object.entries(paths).map(([spec, path]) => [spec, new URL(path, location.origin).href]));
}

/** A lesson of several views, checked as a whole: and the account's views it can pick from, with what they practise. */
export type SequenceReport = {
  problems: string[]; warnings: string[];
  /** the account's views and visualizations (a viz practises nothing) */
  views: { id: string; title: string; kind: 'view' | 'viz'; practises: string[] }[];
  /** concept ids to names, where a view's concepts have them */
  concepts: Record<string, string>;
};
export const sequenceReport = (id: string) => api<SequenceReport>(`/drafts/${id}/sequence`);

/** The brief a draft was made with (a lesson's plan): kept in this browser until the draft is first opened, which keeps it as its spec. */
const briefKey = (id: string) => `workshop:brief:${id}`;
export const brief = {
  get(id: string) { try { return localStorage.getItem(briefKey(id)) ?? undefined; } catch { return undefined; } },
  set(id: string, text: string) { try { localStorage.setItem(briefKey(id), text); } catch { /* the brief starts empty */ } },
  clear(id: string) { try { localStorage.removeItem(briefKey(id)); } catch { /* nothing kept */ } },
};

/** The draft's folder as the server keeps it, as a zip. */
export const exportUrl = (id: string) => `/api/drafts/${id}/export`;

/** The repo folder a draft syncs with. */
export const draftUrl = (id: string) => `${location.origin}/api/drafts/${id}`;
