/**
 * Fan-out for document events.
 *
 * One place where "a document happened" turns into the several things that
 * should follow: watchers are notified, and subscribed webhooks are queued.
 *
 * ─── Never throws ───────────────────────────────────────────────────────────
 *
 * Every branch is best-effort. A watcher list that cannot be computed, or a
 * webhook that cannot be queued, must not fail the upload that caused it — the
 * document is already stored and the user is entitled to be told so.
 */

import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('documents');

/**
 * @param {object} args
 * @param {string} args.event            a WEBHOOK_EVENTS name
 * @param {object} args.actor            request.user
 * @param {string} args.documentId
 * @param {string} [args.folderId]
 * @param {string} [args.title]
 * @param {boolean} [args.notifyWatchers] false to skip the inbox side
 */
export async function announceDocumentEvent({
  event,
  actor,
  documentId,
  folderId = null,
  title = null,
  notifyWatchers = true,
}) {
  try {
    if (notifyWatchers) {
      const { watchersOf } = await import('../collaboration/service.js');
      const { notifyMany, KIND } = await import('../notifications/service.js');

      // The person who acted is excluded: being notified about your own upload
      // is the noise that trains people to ignore the inbox entirely.
      const watchers = await watchersOf({ documentId, excludeUserId: actor?.userId });

      if (watchers.length > 0) {
        await notifyMany({
          userIds: watchers,
          kind: event === 'document.created' ? KIND.DOCUMENT_ADDED : KIND.DOCUMENT_UPDATED,
          title:
            event === 'document.created'
              ? `وثيقة جديدة: ${title ?? ''}`.trim()
              : `تحديث وثيقة: ${title ?? ''}`.trim(),
          body: `بواسطة ${actor?.displayName || actor?.username || 'النظام'}`,
          documentId,
          folderId,
        });
      }
    }
  } catch (error) {
    log.warn({ err: error, event }, 'could not notify watchers');
  }

  try {
    const { emitEvent } = await import('../integration/service.js');
    await emitEvent({
      event,
      payload: {
        documentId: String(documentId),
        folderId: folderId === null ? null : String(folderId),
        title,
        actor: actor?.username ?? null,
      },
    });
  } catch (error) {
    log.warn({ err: error, event }, 'could not queue webhook deliveries');
  }
}
