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

async function request(path, { method = 'GET', body, headers = {}, raw, signal } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    signal,
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
  /**
   * One folder's contents, optionally narrowed by parameter filters.
   *
   * Filters go on the query string rather than in a body so a narrowed folder
   * view is a URL that can be bookmarked and shared, the same as a search.
   */
  folder: (folderId, { cursor, filters } = {}) => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === null || value === undefined || value === '') continue;
      params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const query = params.toString();
    return request(`/api/folders/${folderId}${query ? `?${query}` : ''}`);
  },
  createFolder: (parentId, name) => request('/api/folders', { method: 'POST', body: { parentId, name } }),
  /** Only an empty one; the server answers 409 with the counts when it is not. */
  deleteFolder: (folderId) => request(`/api/folders/${folderId}`, { method: 'DELETE' }),

  document: (documentId) => request(`/api/documents/${documentId}`),
  updateMetadata: (documentId, body) =>
    request(`/api/documents/${documentId}/metadata`, { method: 'PATCH', body }),

  metadata: {
    // `inactive` matters for the administration screen: a retired type must stay
    // visible there to be switched back on, while the document form only ever
    // wants the live ones.
    types: (includeInactive) => request(`/api/metadata/types${includeInactive ? '?inactive=true' : ''}`),
    fields: (typeId, includeInactive) => {
      const params = new URLSearchParams();
      if (typeId) params.set('typeId', String(typeId));
      if (includeInactive) params.set('inactive', 'true');
      const query = params.toString();
      return request(`/api/metadata/fields${query ? `?${query}` : ''}`);
    },
    // Same reason as `inactive` on types: a retired label can only be brought
    // back from the administration screen, so that screen has to see it.
    labels: (includeInactive) => request(`/api/metadata/labels${includeInactive ? '?inactive=true' : ''}`),
    createType: (body) => request('/api/metadata/types', { method: 'POST', body }),
    updateType: (typeId, body) => request(`/api/metadata/types/${typeId}`, { method: 'PATCH', body }),
    setTypeActive: (typeId, active) =>
      request(`/api/metadata/types/${typeId}/active`, { method: 'POST', body: { active } }),
    createField: (body) => request('/api/metadata/fields', { method: 'POST', body }),
    updateField: (fieldId, body) => request(`/api/metadata/fields/${fieldId}`, { method: 'PATCH', body }),
    setFieldActive: (fieldId, active) =>
      request(`/api/metadata/fields/${fieldId}/active`, { method: 'POST', body: { active } }),
    createLabel: (body) => request('/api/metadata/labels', { method: 'POST', body }),
    updateLabel: (labelId, body) => request(`/api/metadata/labels/${labelId}`, { method: 'PATCH', body }),
    setLabelActive: (labelId, active) =>
      request(`/api/metadata/labels/${labelId}/active`, { method: 'POST', body: { active } }),
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

  /**
   * Files a batch of documents chosen in one action.
   *
   * `mode` is what the user was asked: 'separate' for one document per file,
   * 'single' for one document made of all of them. Sent as a field BEFORE the
   * files, like every other upload field — the server reads the multipart
   * stream in order and cannot see a field that arrives after a file part.
   */
  uploadBatch: (folderId, files, { mode = 'separate', title, typeId, fields } = {}) => {
    const form = new FormData();
    form.append('mode', mode);
    if (title) form.append('title', title);
    if (typeId) form.append('typeId', String(typeId));
    if (fields?.length) form.append('fields', JSON.stringify(fields));
    for (const file of files) form.append('files', file, file.name);
    return request(`/api/folders/${folderId}/documents/batch`, {
      method: 'POST',
      body: form,
      raw: true,
    });
  },

  /** The constituent files of a document filed as one entry. */
  documentFiles: (documentId) => request(`/api/documents/${documentId}/files`),
  fileContentUrl: (documentId, fileId) =>
    `/api/documents/${documentId}/files/${fileId}/content`,
  filesZipUrl: (documentId) => `/api/documents/${documentId}/files.zip`,

  /**
   * The vocabulary a filter bar renders its controls from — types, labels,
   * tags, uploaders and the file types actually present. Scoped by folder when
   * one is given, and always scoped to what the caller may browse.
   */
  filterOptions: (folderId) =>
    request(`/api/search/filter-options${folderId ? `?folderId=${folderId}` : ''}`),

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
  updateApprovalTemplate: (templateId, body) =>
    request(`/api/approval-templates/${templateId}`, { method: 'PATCH', body }),
  setApprovalTemplateActive: (templateId, active) =>
    request(`/api/approval-templates/${templateId}/active`, { method: 'POST', body: { active } }),
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

  /**
   * The rendered preview of a document the browser cannot open itself — an
   * Office file, or a TIFF scan.
   *
   * "No preview" is four different answers and a viewer has to tell them apart:
   * still being made (keep waiting), never will be (offer the download), the
   * renderer failed (say so), or the request itself failed. Returning a URL and
   * letting an <img> decide collapses all four into a broken-image icon, so the
   * status codes are translated here instead.
   *
   * The caller owns the returned object URL and must revoke it.
   *
   * @returns {Promise<{status:'ready', blobUrl:string, mimeType:string}
   *                 | {status:'queued'|'unsupported'|'failed', reason?:string}>}
   */
  previewRendition: async (documentId, { signal, fileId = null } = {}) => {
    // `fileId` addresses one constituent of a multi-file document; without it
    // the request is for the document's own current version.
    const query = fileId ? `?fileId=${encodeURIComponent(fileId)}` : '';
    const response = await fetch(`/api/documents/${documentId}/rendition/preview${query}`, {
      credentials: 'include',
      signal,
    });

    if (response.status === 202) return { status: 'queued' };
    if (response.status === 415) return { status: 'unsupported' };
    if (response.status === 422) {
      const body = await response.json().catch(() => null);
      return { status: 'failed', reason: body?.reason };
    }
    if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));

    const blob = await response.blob();
    return { status: 'ready', blobUrl: URL.createObjectURL(blob), mimeType: blob.type };
  },

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
  updateWebhook: (webhookId, body) => request(`/api/webhooks/${webhookId}`, { method: 'PATCH', body }),
  /** Pausing keeps the signing secret; deleting loses it for good. */
  setWebhookActive: (webhookId, active) =>
    request(`/api/webhooks/${webhookId}/active`, { method: 'POST', body: { active } }),
  deleteWebhook: (webhookId) => request(`/api/webhooks/${webhookId}`, { method: 'DELETE' }),
  /** Issues a new signing secret, shown once; the old one stops signing at the next sweep. */
  rotateWebhookSecret: (webhookId) =>
    request(`/api/webhooks/${webhookId}/secret`, { method: 'POST', body: {} }),
  exportCsvUrl: (folderId) => `/api/export/metadata.csv${folderId ? `?folderId=${folderId}` : ''}`,

  settings: {
    list: () => request('/api/settings'),
    set: (key, value) => request(`/api/settings/${key}`, { method: 'PUT', body: { value } }),
    clear: (key) => request(`/api/settings/${key}`, { method: 'DELETE' }),
  },

  branding: () => request('/api/settings/branding'),
  preferences: () => request('/api/preferences'),
  setPreference: (key, value) =>
    request(`/api/preferences/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }),

  admin: {
    /**
     * The directory, optionally narrowed. Both filters run on the server, which
     * has supported them since the route was written; the screen simply never
     * sent them.
     */
    users: (q, { includeInactive = true } = {}) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (!includeInactive) params.set('inactive', 'false');
      const query = params.toString();
      return request(`/api/admin/users${query ? `?${query}` : ''}`);
    },
    createUser: (body) => request('/api/admin/users', { method: 'POST', body }),
    /** Display name and email. The username is the login and stays what it was. */
    updateUser: (userId, body) => request(`/api/admin/users/${userId}`, { method: 'PATCH', body }),
    setActive: (userId, active) =>
      request(`/api/admin/users/${userId}/active`, { method: 'POST', body: { active } }),
    setSuperAdmin: (userId, isSuperAdmin) =>
      request(`/api/admin/users/${userId}/super-admin`, { method: 'POST', body: { isSuperAdmin } }),
    resetPassword: (userId) => request(`/api/admin/users/${userId}/reset-password`, { method: 'POST' }),
    unlock: (userId) => request(`/api/admin/users/${userId}/unlock`, { method: 'POST' }),

    groups: () => request('/api/admin/groups'),
    createGroup: (body) => request('/api/admin/groups', { method: 'POST', body }),
    updateGroup: (groupId, body) => request(`/api/admin/groups/${groupId}`, { method: 'PATCH', body }),
    /** A deactivated group stops conveying permissions; its grants and members are kept. */
    setGroupActive: (groupId, active) =>
      request(`/api/admin/groups/${groupId}/active`, { method: 'POST', body: { active } }),
    groupMembers: (groupId) => request(`/api/admin/groups/${groupId}/members`),
    addMember: (groupId, principalId) =>
      request(`/api/admin/groups/${groupId}/members`, { method: 'POST', body: { principalId } }),
    removeMember: (groupId, principalId) =>
      request(`/api/admin/groups/${groupId}/members/${principalId}`, { method: 'DELETE' }),

    roles: () => request('/api/admin/roles'),
    createRole: (body) => request('/api/admin/roles', { method: 'POST', body }),
    updateRole: (roleId, body) => request(`/api/admin/roles/${roleId}`, { method: 'PATCH', body }),
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
    reindex: () => request('/api/admin/extraction/reindex', { method: 'POST' }),
    extractionFailures: () => request('/api/admin/extraction/failures'),
    renditionStatus: () => request('/api/admin/renditions/status'),
    mailStatus: () => request('/api/admin/mail/status'),
    missingBlobs: () => request('/api/admin/storage/missing'),
    purge: (dryRun) => request('/api/admin/storage/purge', { method: 'POST', body: { dryRun } }),
    manifests: () => request('/api/admin/storage/manifests', { method: 'POST' }),
    rebuildPreviews: () => request('/api/admin/renditions/rebuild', { method: 'POST' }),

    // ── Where the documents live ──────────────────────────────────────────
    /** Checks a candidate root without changing anything. */
    validateStorageRoot: (path) =>
      request('/api/admin/storage/root/validate', { method: 'POST', body: { path } }),
    /** Repoints the system, and returns the reconciliation for the new root. */
    setStorageRoot: (path) => request('/api/admin/storage/root', { method: 'POST', body: { path } }),
    /** Re-checks every referenced file against the live root. */
    reconcileStorage: () => request('/api/admin/storage/reconcile', { method: 'POST' }),
    /** What is still outstanding after a move. */
    storageReport: () => request('/api/admin/storage/reconcile'),
    audit: (params = '') => request(`/api/admin/audit${params ? `?${params}` : ''}`),
    /** The actions actually present in the log, so a filter offers only what exists. */
    auditActions: () => request('/api/admin/audit/actions'),
  },

  /**
   * Letter formats (النماذج): Word templates merged into new documents. Every
   * call except `status` answers "disabled" while the module's switch is off.
   * The admin calls need a super-admin session.
   */
  forms: {
    status: () => request('/api/forms/status'),
    templates: () => request('/api/forms/templates'),
    template: (templateId) => request(`/api/forms/templates/${templateId}`),
    /** body: { templateId, folderId, title, values: { placeholder: value } } */
    generate: (body) => request('/api/forms/generate', { method: 'POST', body }),

    adminStatus: () => request('/api/admin/forms/status'),
    adminTemplates: () => request('/api/admin/forms/templates'),
    /** formData: name, description, typeId, approvalTemplateId, folderIds (JSON array of folder ids), then the .docx as `file`. */
    adminCreate: (formData, { signal } = {}) =>
      request('/api/admin/forms/templates', { method: 'POST', body: formData, raw: true, signal }),
    adminUpdate: (templateId, body) =>
      request(`/api/admin/forms/templates/${templateId}`, { method: 'PATCH', body }),
    adminReplaceFile: (templateId, formData, { signal } = {}) =>
      request(`/api/admin/forms/templates/${templateId}/file`, { method: 'PUT', body: formData, raw: true, signal }),
    adminSetAccess: (templateId, principalIds) =>
      request(`/api/admin/forms/templates/${templateId}/access`, { method: 'PUT', body: { principalIds } }),
    /** The folders a letter from this template may be filed into; [] means any folder the person may upload into. */
    adminSetFolders: (templateId, folderIds) =>
      request(`/api/admin/forms/templates/${templateId}/folders`, { method: 'PUT', body: { folderIds } }),
    adminSetFields: (templateId, fields) =>
      request(`/api/admin/forms/templates/${templateId}/fields`, { method: 'PUT', body: { fields } }),
    adminFileUrl: (templateId) => `/api/admin/forms/templates/${templateId}/file`,
    /** A sample-filled PDF of the template, for checking fidelity. Creates nothing. */
    adminPreviewUrl: (templateId) => `/api/admin/forms/templates/${templateId}/preview`,
  },

  /**
   * Ink signing (التوقيع): strokes drawn on a page, saved as a new version.
   * `document` answers { enabled:false } while the switch is off.
   */
  signing: {
    status: () => request('/api/signing/status'),
    document: (documentId) => request(`/api/signing/documents/${documentId}`),
    /** Page count and each page's displayed size. Loads the PDF; ask only when the tab opens. */
    pages: (documentId) => request(`/api/signing/documents/${documentId}/pages`),
    pageUrl: (documentId, page, version) =>
      `/api/signing/documents/${documentId}/pages/${page}${version ? `?version=${version}` : ''}`,
    /** body: { version, note?, pages: [{ number, image: 'data:image/png;base64,…' }] } */
    sign: (documentId, body) =>
      request(`/api/signing/documents/${documentId}/sign`, { method: 'POST', body }),
  },

  /**
   * The correspondence register (الوارد والصادر). Every call except `status`
   * answers "disabled" while the module's switch is off.
   */
  correspondence: {
    status: () => request('/api/correspondence/status'),
    queue: ({ scope, q } = {}) => {
      const params = new URLSearchParams();
      if (scope) params.set('scope', scope);
      if (q) params.set('q', q);
      const query = params.toString();
      return request(`/api/correspondence/queue${query ? `?${query}` : ''}`);
    },
    intake: () => request('/api/correspondence/intake'),
    followUp: () => request('/api/correspondence/followup'),
    /**
     * The book, narrowed.
     *
     * `location: 'out'` keeps only the letters whose PAPER is currently with
     * somebody — the list the mail room picks from when a sheet comes back, so
     * the clerk chooses a letter instead of remembering its number.
     */
    letters: ({ direction, year, status, q, location } = {}) => {
      const params = new URLSearchParams();
      if (direction) params.set('direction', direction);
      if (year) params.set('year', String(year));
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      if (location) params.set('location', location);
      const query = params.toString();
      return request(`/api/correspondence/letters${query ? `?${query}` : ''}`);
    },
    letter: (letterId) => request(`/api/correspondence/letters/${letterId}`),
    forDocument: (documentId) => request(`/api/correspondence/documents/${documentId}/letter`),
    /**
     * Registers a document in a book.
     *
     * Beyond the letter's own fields the body carries two links the paper trail
     * needs: `transfers[].note` — the director's instruction («التهميش»), written
     * once and repeated on every department row — and `replyToLetterId`, the
     * incoming letter an outgoing one answers.
     */
    register: (body) => request('/api/correspondence/register', { method: 'POST', body }),
    /** Forwarding after registration. Each row may carry its own `note`, as at registration. */
    addTransfers: (letterId, transfers) =>
      request(`/api/correspondence/letters/${letterId}/transfers`, {
        method: 'POST',
        body: { transfers },
      }),

    /**
     * A returned or re-annotated paper, filed as a NEW VERSION of the letter's
     * existing document — never a second document. `action` names what was done
     * to the sheet (instruction | endorsement | rescan | other), `personName`
     * who did it, and `returned` records in the same step that the paper is back
     * in the mail room.
     *
     * Fields before the file, for the reason `upload` states: the server reads
     * one multipart stream in order and cannot see a field that arrives after
     * the file part.
     */
    addCopy: (letterId, file, { action, personName, note, returned } = {}) => {
      const form = new FormData();
      if (action) form.append('action', action);
      if (personName) form.append('personName', personName);
      if (note) form.append('note', note);
      // Sent both ways rather than only when true: the server reads a plain
      // 'true'/'false', and an absent field would be a third state to guess at.
      form.append('returned', returned ? 'true' : 'false');
      form.append('file', file, file.name);
      return request(`/api/correspondence/letters/${letterId}/versions`, {
        method: 'POST',
        body: form,
        raw: true,
      });
    },

    /** Where the paper went ('out') or that it came back ('back'). */
    move: (letterId, { kind, personName, note } = {}) =>
      request(`/api/correspondence/letters/${letterId}/movements`, {
        method: 'POST',
        body: { kind, personName: personName ?? null, note: note ?? null },
      }),
    annul: (letterId, reason) =>
      request(`/api/correspondence/letters/${letterId}/annul`, { method: 'POST', body: { reason } }),
    setStatus: (letterId, status) =>
      request(`/api/correspondence/letters/${letterId}/status`, { method: 'POST', body: { status } }),
    receive: (transferId) =>
      request(`/api/correspondence/transfers/${transferId}/receive`, { method: 'POST', body: {} }),
    close: (transferId, note) =>
      request(`/api/correspondence/transfers/${transferId}/close`, { method: 'POST', body: { note } }),
    cancelTransfer: (transferId, reason) =>
      request(`/api/correspondence/transfers/${transferId}/cancel`, {
        method: 'POST',
        body: { reason },
      }),
    units: (all) => request(`/api/admin/correspondence/units${all ? '?all=true' : ''}`),
    createUnit: (body) => request('/api/admin/correspondence/units', { method: 'POST', body }),
    updateUnit: (unitId, body) =>
      request(`/api/admin/correspondence/units/${unitId}`, { method: 'PATCH', body }),
    setUnitActive: (unitId, active) =>
      request(`/api/admin/correspondence/units/${unitId}/active`, {
        method: 'POST',
        body: { active },
      }),
    counters: (year) => request(`/api/admin/correspondence/counters${year ? `?year=${year}` : ''}`),
    setCounter: (body) => request('/api/admin/correspondence/counters', { method: 'PUT', body }),
  },

  /** The document-recognition pilot. Every call answers "disabled" while its switch is off. */
  classification: {
    status: () => request('/api/admin/classification/status'),
    metrics: () => request('/api/admin/classification/metrics'),
    /** Queues documents without a current fingerprint, or every document with `all`. */
    rebuild: (all = false) =>
      request('/api/admin/classification/rebuild', { method: 'POST', body: { all } }),
    document: (documentId) => request(`/api/documents/${documentId}/classification`),
    run: (documentId) =>
      request(`/api/documents/${documentId}/classification/run`, { method: 'POST', body: {} }),
  },

  search: (query, { folderId, limit = 25, offset = 0, content = true } = {}) => {
    const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
    if (folderId) params.set('folderId', folderId);
    if (!content) params.set('content', 'false');
    return request(`/api/search?${params}`);
  },
  searchCapabilities: () => request('/api/search/capabilities'),
};
