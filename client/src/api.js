/**
 * API client.
 *
 * The session is an httpOnly cookie, so there is no token to store or attach —
 * `credentials: 'include'` is the whole authentication story on this side, and
 * JavaScript can never read the session, which is the point.
 */

/** Thrown for any non-2xx response, carrying the server's machine-readable reason. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `Request failed with ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error;
    this.problems = body?.problems;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: body && !raw ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return null;

  const text = await response.text();
  const parsed = text ? safeJson(text) : null;

  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export const api = {
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    request('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),

  roots: () => request('/api/folders'),
  folder: (folderId, { cursor } = {}) =>
    request(`/api/folders/${folderId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  createFolder: (parentId, name) => request('/api/folders', { method: 'POST', body: { parentId, name } }),

  document: (documentId) => request(`/api/documents/${documentId}`),
  deleteDocument: (documentId) => request(`/api/documents/${documentId}`, { method: 'DELETE' }),
  contentUrl: (documentId, version) =>
    `/api/documents/${documentId}/content${version ? `?version=${version}` : ''}`,

  upload: (folderId, file, { title } = {}) => {
    const form = new FormData();
    // Fields must precede the file part: the server reads them from the same
    // multipart stream, and anything after the file is not visible while the
    // upload is being consumed.
    if (title) form.append('title', title);
    form.append('file', file, file.name);
    return request(`/api/folders/${folderId}/documents`, { method: 'POST', body: form, raw: true });
  },

  search: (query, { folderId, limit = 25, offset = 0, content = true } = {}) => {
    const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
    if (folderId) params.set('folderId', folderId);
    if (!content) params.set('content', 'false');
    return request(`/api/search?${params}`);
  },
  searchCapabilities: () => request('/api/search/capabilities'),
};
