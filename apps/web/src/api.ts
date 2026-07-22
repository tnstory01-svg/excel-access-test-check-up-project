import type { DraftProblemView, UploadMetadata } from './workflow.ts';
import type { GradeSummaryWire } from '../../../packages/domain/src/results.ts';

export type GradeRequest = Readonly<{ artifactId: string; problemIds?: readonly string[] }>;
export type GradeResponse = Readonly<{ summary: GradeSummaryWire }>;

type FetchLike = typeof fetch;

/** Same-origin client; requests expose artifact IDs and canonical evidence only, never local paths. */
export class LocalApiClient {
  #csrfToken: string | undefined;

  constructor(private readonly request: FetchLike = fetch) {}

  async bootstrap(token: string): Promise<void> {
    const response = await this.request('/bootstrap', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) throw new Error(`Bootstrap failed (${response.status})`);
    this.#csrfToken = response.headers.get('x-csrf-token') ?? undefined;
    if (!this.#csrfToken) throw new Error('Bootstrap response did not include a CSRF token');
  }

  async upload(file: File): Promise<UploadMetadata> {
    const form = new FormData();
    form.set('file', file, file.name);
    return this.#json('/api/uploads', { method: 'POST', body: form });
  }

  async loadDraft(artifactId: string): Promise<readonly DraftProblemView[]> {
    return this.#json(`/api/artifacts/${encodeURIComponent(artifactId)}/draft`);
  }

  async saveDraft(artifactId: string, problems: readonly DraftProblemView[]): Promise<void> {
    await this.#json(`/api/artifacts/${encodeURIComponent(artifactId)}/draft`, { method: 'PUT', body: JSON.stringify({ problems }) });
  }

  async grade(request: GradeRequest): Promise<GradeResponse> {
    return this.#json('/api/grades', { method: 'POST', body: JSON.stringify(request) });
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
    if (init.method && init.method !== 'GET' && init.method !== 'HEAD') {
      if (!this.#csrfToken) throw new Error('No authenticated CSRF token');
      headers.set('x-csrf-token', this.#csrfToken);
    }
    const response = await this.request(path, { ...init, headers, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return await response.json() as T;
  }
}
