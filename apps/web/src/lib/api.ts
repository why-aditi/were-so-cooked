import type {
  AgentState,
  InboxItem,
  PantryItem,
  Profile,
  Scan,
  TrendingEntry,
} from '@cooked/shared';

/**
 * REST calls to the Worker (section 11).
 *
 * The chat stream and the synced state come over the agent WebSocket, not
 * through here — this covers the routes that are plain HTTP: the session,
 * the budget meter's numbers, uploads and scans.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { accept: 'application/json', ...init.headers },
  });

  if (!response.ok) {
    // Section 11 guarantees one error shape, so the message the server wrote
    // is the one the user should see — the UI does not invent its own.
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      body?.error.code ?? 'internal_error',
      body?.error.message ?? "we're cooked 💀 (the server, not you). try again?",
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface Me {
  user: { id: string; login: string; name: string | null; avatarUrl: string | null; isDemo: boolean };
}

export interface BudgetStatus {
  user: { used: number; limit: number; left: number };
  account: { used: number; limit: number; left: number };
  resetsAt: string;
}

export const api = {
  me: () => request<Me>('/api/me'),

  startDemo: () =>
    request<Me>('/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' } }),

  logout: () =>
    request<{ ok: true }>('/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }),

  budget: () => request<BudgetStatus>('/api/budget'),

  uploadPhoto: (file: File) =>
    request<{ scanId: string; status: string }>('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': file.type },
      body: file,
    }),

  scan: (scanId: string) => request<{ scan: Scan }>(`/api/scans/${scanId}`),

  confirmScan: (scanId: string, items: Scan['items']) =>
    request<{ status: string }>(`/api/scans/${scanId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    }),

  /* -------------------------------- profile ------------------------------- */

  profile: () => request<{ profile: Profile }>('/api/profile'),

  saveProfile: (profile: Omit<Profile, 'updatedAt'>) =>
    request<{ profile: Profile }>('/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profile),
    }),

  deleteAccount: () => request<{ ok: true }>('/api/me', { method: 'DELETE' }),

  /* -------------------------------- pantry -------------------------------- */

  pantry: () => request<{ items: PantryItem[] }>('/api/pantry'),

  addPantry: (text: string) =>
    request<{ items: PantryItem[] }>('/api/pantry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }),

  patchPantry: (id: string, patch: Record<string, unknown>) =>
    request<{ item: PantryItem }>(`/api/pantry/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  removePantry: (id: string) => request<{ ok: true }>(`/api/pantry/${id}`, { method: 'DELETE' }),

  restorePantry: (id: string) =>
    request<{ ok: true }>(`/api/pantry/${id}/restore`, { method: 'POST' }),

  /* --------------------------- plan, grocery, rest ------------------------- */

  currentPlan: () => request<{ plan: PlanView | null }>('/api/plans/current'),

  startPlan: () =>
    request<{ planId: string }>('/api/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),

  grocery: () => request<{ items: GroceryRow[] }>('/api/grocery'),

  checkGrocery: (itemId: string, checked: boolean) =>
    request<{ item: { id: string; checked: boolean } }>(`/api/grocery/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checked }),
    }),

  trending: (fitsMe: boolean) =>
    request<{ recipes: TrendingEntry[] }>(`/api/trending${fitsMe ? '?fits=me' : ''}`),

  inbox: () => request<{ items: InboxItem[]; unread: number }>('/api/inbox'),

  markRead: (id: string) => request<{ ok: true }>(`/api/inbox/${id}/read`, { method: 'POST' }),

  pipeline: () => request<{ runs: PipelineRun[] }>('/api/status/pipeline'),
};

/** `GET /api/plans/current`, as the worker's `PlanView` returns it. */
export interface PlanView {
  id: string;
  weekStart: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  complete: boolean;
  slots: PlanSlot[];
  days: { date: string; meals: PlanMealView[] }[];
  unfilled: { date: string; slot: PlanSlot; reason: string }[];
  repeated: { date: string; slot: PlanSlot; reason: string }[];
  dropped: { title: string; reason: string }[];
  error: string | null;
  catalogOnly: boolean;
}

export type PlanSlot = 'breakfast' | 'lunch' | 'dinner' | 'treat';

export interface PlanMealView {
  slot: PlanSlot;
  recipeId: string | null;
  title: string;
  minutes: number;
  pantryCoverage: number;
  swaps: { fromName: string; toName: string; explanation: string }[];
}

export interface GroceryRow {
  id: string;
  canonicalId: string | null;
  displayName: string;
  category: string;
  quantity: number | null;
  unit: string | null;
  checked: boolean;
}

export interface PipelineRun {
  id: string;
  workflow: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  found: number;
  filtered: number;
  extracted: number;
  added: number;
  duplicates: number;
  neurons: number;
  errors: string[];
}

/** The shape the agent syncs to every open tab (section 5). */
export type SyncedState = AgentState;

export const EMPTY_STATE: SyncedState = {
  pantryCount: 0,
  expiringSoonCount: 0,
  unreadInbox: 0,
  activePlanStatus: null,
  neuronsLeftToday: 0,
};
