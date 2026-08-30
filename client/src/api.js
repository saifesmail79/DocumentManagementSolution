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
  tree: () => request('/api/folders/tree'),
  folder: (folderId, { cursor } = {}) =>
    request(`/api/folders/${folderId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  createFolder: (parentId, name) => request('/api/folders', { method: 'POST', body: { parentId, name } }),

  document: (documentId) => request(`/api/documents/${documentId}`),
  updateMetadata: (documentId, body) =>
    request(`/api/documents/${documentId}/metadata`, { method: 'PATCH', body }),

  metadata: {
    types: () => request('/api/metadata/types'),
    fields: (typeId) => request(`/api/metadata/fields${typeId ? `?typeId=${typeId}` : ''}`),
    labels: () => request('/api/metadata/labels'),
    createType: (body) => request('/api/metadata/types', { method: 'POST', body }),
    createField: (body) => request('/api/metadata/fields', { method: 'POST', body }),
    createLabel: (body) => request('/api/metadata/labels', { method: 'POST', body }),
  },
  deleteDocument: (documentId) => request(`/api/documents/${documentId}`, { method: 'DELETE' }),
  contentUrl: (documentId, version) =>
    `/api/documents/${documentId}/content${version ? `?version=${version}` : ''}`,

  upload: (folderId, file, { title, typeId, fields } = {}) => {
    const form = new FormData();
    // Fields must precede the file part: the server reads them from the same
    // multipart stream, and anything after the file is not visible while the
    // upload is being consumed.
    if (title) form.append('title', title);
    if (typeId) form.append('typeId', String(typeId));
    // One JSON part rather than a part per value — far easier for a client to
    // order correctly than a dozen separate fields.
    if (fields?.length) form.append('fields', JSON.stringify(fields));
    form.append('file', file, file.name);
    return request(`/api/folders/${folderId}/documents`, { method: 'POST', body: form, raw: true });
  },

  recycleBin: (folderId) =>
    request(`/api/recycle-bin${folderId ? `?folderId=${folderId}` : ''}`),
  restoreDocument: (documentId) =>
    request(`/api/documents/${documentId}/restore`, { method: 'POST' }),
  purgeDocument: (documentId) =>
    request(`/api/documents/${documentId}/purge`, { method: 'POST' }),

  advancedSearch: (criteria) =>
    request('/api/search/advanced', { method: 'POST', body: criteria }),
  facets: (params = '') => request(`/api/search/facets${params ? `?${params}` : ''}`),
  snippets: (documentIds, q) =>
    request('/api/search/snippets', { method: 'POST', body: { documentIds, q } }),

  // ── Personal shelves ───────────────────────────────────────────────────
  favourites: () => request('/api/favourites'),
  addFavourite: (documentId) => request(`/api/favourites/${documentId}`, { method: 'PUT', body: {} }),
  removeFavourite: (documentId) => request(`/api/favourites/${documentId}`, { method: 'DELETE' }),
  recent: () => request('/api/recent'),

  // ── Watches and notifications ──────────────────────────────────────────
  watches: () => request('/api/watches'),
  watch: (body) => request('/api/watches', { method: 'POST', body }),
  unwatch: (params) => request(`/api/watches?${new URLSearchParams(params)}`, { method: 'DELETE' }),
  notifications: (unread) => request(`/api/notifications${unread ? '?unread=true' : ''}`),
  markRead: (notificationId) =>
    request('/api/notifications/read', { method: 'POST', body: { notificationId } }),

  // ── Comments, relations, tags ──────────────────────────────────────────
  comments: (documentId) => request(`/api/documents/${documentId}/comments`),
  addComment: (documentId, body, parentCommentId) =>
    request(`/api/documents/${documentId}/comments`, { method: 'POST', body: { body, parentCommentId } }),
  deleteComment: (commentId) => request(`/api/comments/${commentId}`, { method: 'DELETE' }),

  relations: (documentId) => request(`/api/documents/${documentId}/relations`),
  relate: (documentId, toDocument, relationType) =>
    request(`/api/documents/${documentId}/relations`, { method: 'POST', body: { toDocument, relationType } }),
  unrelate: (relationId) => request(`/api/relations/${relationId}`, { method: 'DELETE' }),

  tags: (q) => request(`/api/tags${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  documentTags: (documentId) => request(`/api/documents/${documentId}/tags`),
  setTags: (documentId, tags) =>
    request(`/api/documents/${documentId}/tags`, { method: 'PUT', body: { tags } }),
  taggedDocuments: (name) => request(`/api/tags/${encodeURIComponent(name)}/documents`),

  // ── Saved searches ─────────────────────────────────────────────────────
  savedSearches: () => request('/api/saved-searches'),
  saveSearch: (body) => request('/api/saved-searches', { method: 'POST', body }),
  deleteSavedSearch: (searchId) => request(`/api/saved-searches/${searchId}`, { method: 'DELETE' }),

  // ── Approvals ──────────────────────────────────────────────────────────
  pendingApprovals: () => request('/api/approvals/pending'),
  documentApprovals: (documentId) => request(`/api/documents/${documentId}/approvals`),
  requestApproval: (documentId, body) =>
    request(`/api/documents/${documentId}/approvals`, { method: 'POST', body }),
  decideApproval: (requestId, decision, note) =>
    request(`/api/approvals/${requestId}/decision`, { method: 'POST', body: { decision, note } }),
  cancelApproval: (requestId) => request(`/api/approvals/${requestId}/cancel`, { method: 'POST', body: {} }),
  approvalTemplates: () => request('/api/approval-templates'),
  createApprovalTemplate: (body) => request('/api/approval-templates', { method: 'POST', body }),
  deleteApprovalTemplate: (templateId) =>
    request(`/api/approval-templates/${templateId}`, { method: 'DELETE' }),

  // ── Bulk operations ────────────────────────────────────────────────────
  bulkMove: (documentIds, targetFolderId) =>
    request('/api/bulk/move', { method: 'POST', body: { documentIds, targetFolderId } }),
  bulkMetadata: (body) => request('/api/bulk/metadata', { method: 'POST', body }),
  bulkDelete: (documentIds) => request('/api/bulk/delete', { method: 'POST', body: { documentIds } }),
  bulkDownloadUrl: '/api/bulk/download',

  // ── Document state ─────────────────────────────────────────────────────
  checkOut: (documentId) => request(`/api/documents/${documentId}/checkout`, { method: 'POST', body: {} }),
  checkIn: (documentId) => request(`/api/documents/${documentId}/checkin`, { method: 'POST', body: {} }),
  setLifecycle: (documentId, state) =>
    request(`/api/documents/${documentId}/lifecycle`, { method: 'POST', body: { state } }),
  setExpiry: (documentId, expiresAt) =>
    request(`/api/documents/${documentId}/expiry`, { method: 'POST', body: { expiresAt } }),
  setLegalHold: (documentId, hold, reason) =>
    request(`/api/documents/${documentId}/legal-hold`, { method: 'POST', body: { hold, reason } }),
  restoreVersion: (documentId, versionNumber, comment) =>
    request(`/api/documents/${documentId}/versions/${versionNumber}/restore`, {
      method: 'POST',
      body: { comment },
    }),

  // ── Sharing and QR ─────────────────────────────────────────────────────
  shares: (documentId) => request(`/api/documents/${documentId}/shares`),
  createShare: (documentId, body) =>
    request(`/api/documents/${documentId}/shares`, { method: 'POST', body }),
  revokeShare: (shareId) => request(`/api/shares/${shareId}`, { method: 'DELETE' }),
  qrUrl: (documentId) => `/api/documents/${documentId}/qr`,
  stampedUrl: (documentId) => `/api/documents/${documentId}/content?stamp=qr`,
  thumbnailUrl: (documentId) => `/api/documents/${documentId}/rendition/thumbnail`,
  previewUrl: (documentId) => `/api/documents/${documentId}/rendition/preview`,

  // ── Folder defaults ────────────────────────────────────────────────────
  folderDefaults: (folderId) => request(`/api/folders/${folderId}/defaults`),
  setFolderDefaults: (folderId, defaults) =>
    request(`/api/folders/${folderId}/defaults`, { method: 'PUT', body: { defaults } }),

  // ── Resumable upload ───────────────────────────────────────────────────
  startUpload: (body) => request('/api/uploads', { method: 'POST', body }),
  uploadChunk: async (sessionId, offset, blob) => {
    const response = await fetch(`/api/uploads/${sessionId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) },
      body: blob,
    });
    const parsed = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, parsed);
    return parsed;
  },
  completeUpload: (sessionId) => request(`/api/uploads/${sessionId}/complete`, { method: 'POST', body: {} }),
  abortUpload: (sessionId) => request(`/api/uploads/${sessionId}`, { method: 'DELETE' }),

  // ── Reporting and integration administration ───────────────────────────
  reports: {
    overview: () => request('/api/reports/overview'),
    trend: (days = 30) => request(`/api/reports/trend?days=${days}`),
    storage: () => request('/api/reports/storage'),
    contributors: (days = 30) => request(`/api/reports/contributors?days=${days}`),
    distribution: () => request('/api/reports/distribution'),
  },
  apiKeys: () => request('/api/api-keys'),
  createApiKey: (body) => request('/api/api-keys', { method: 'POST', body }),
  revokeApiKey: (keyId) => request(`/api/api-keys/${keyId}`, { method: 'DELETE' }),
  webhooks: () => request('/api/webhooks'),
  createWebhook: (body) => request('/api/webhooks', { method: 'POST', body }),
  deleteWebhook: (webhookId) => request(`/api/webhooks/${webhookId}`, { method: 'DELETE' }),
  exportCsvUrl: (folderId) => `/api/export/metadata.csv${folderId ? `?folderId=${folderId}` : ''}`,

  settings: {
    list: () => request('/api/settings'),
    set: (key, value) => request(`/api/settings/${key}`, { method: 'PUT', body: { value } }),
    clear: (key) => request(`/api/settings/${key}`, { method: 'DELETE' }),
  },

  admin: {
    users: (q) => request(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    createUser: (body) => request('/api/admin/users', { method: 'POST', body }),
    setActive: (userId, active) =>
      request(`/api/admin/users/${userId}/active`, { method: 'POST', body: { active } }),
    setSuperAdmin: (userId, isSuperAdmin) =>
      request(`/api/admin/users/${userId}/super-admin`, { method: 'POST', body: { isSuperAdmin } }),
    resetPassword: (userId) => request(`/api/admin/users/${userId}/reset-password`, { method: 'POST' }),
    unlock: (userId) => request(`/api/admin/users/${userId}/unlock`, { method: 'POST' }),

    groups: () => request('/api/admin/groups'),
    createGroup: (body) => request('/api/admin/groups', { method: 'POST', body }),
    groupMembers: (groupId) => request(`/api/admin/groups/${groupId}/members`),
    addMember: (groupId, principalId) =>
      request(`/api/admin/groups/${groupId}/members`, { method: 'POST', body: { principalId } }),
    removeMember: (groupId, principalId) =>
      request(`/api/admin/groups/${groupId}/members/${principalId}`, { method: 'DELETE' }),

    roles: () => request('/api/admin/roles'),
    createRole: (body) => request('/api/admin/roles', { method: 'POST', body }),
    deleteRole: (roleId) => request(`/api/admin/roles/${roleId}`, { method: 'DELETE' }),

    principals: (q) => request(`/api/admin/principals${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    folderAcl: (folderId) => request(`/api/admin/folders/${folderId}/acl`),
    setAce: (folderId, principalId, body) =>
      request(`/api/admin/folders/${folderId}/acl/${principalId}`, { method: 'PUT', body }),
    removeAce: (folderId, principalId) =>
      request(`/api/admin/folders/${folderId}/acl/${principalId}`, { method: 'DELETE' }),
    setInheritance: (folderId, inherits, copyInherited = true) =>
      request(`/api/admin/folders/${folderId}/inheritance`, {
        method: 'POST',
        body: { inherits, copyInherited },
      }),
    extractionStats: () => request('/api/admin/extraction/stats'),
    mailStatus: () => request('/api/admin/mail/status'),
    missingBlobs: () => request('/api/admin/storage/missing'),
    purge: (dryRun) => request('/api/admin/storage/purge', { method: 'POST', body: { dryRun } }),
    manifests: () => request('/api/admin/storage/manifests', { method: 'POST' }),
    audit: (params = '') => request(`/api/admin/audit${params ? `?${params}` : ''}`),
  },

  search: (query, { folderId, limit = 25, offset = 0, content = true } = {}) => {
    const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
    if (folderId) params.set('folderId', folderId);
    if (!content) params.set('content', 'false');
    return request(`/api/search?${params}`);
  },
  searchCapabilities: () => request('/api/search/capabilities'),
};
