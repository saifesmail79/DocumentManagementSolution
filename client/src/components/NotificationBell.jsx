import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';

import { api } from '../api.js';
import { formatDate } from '../format.js';

/**
 * The notification bell and its dropdown.
 *
 * Polled rather than pushed. A WebSocket for a system whose notifications
 * arrive minutes apart would add a connection to keep alive, a reconnect path,
 * and a second server surface — for latency nobody would notice. One request a
 * minute is the cheaper answer.
 *
 * The poll pauses while the tab is hidden: a browser left open overnight should
 * not spend the night asking.
 */
const POLL_MS = 60_000;

const KIND_LABELS = {
  'document.added': 'وثيقة جديدة',
  'document.updated': 'تحديث وثيقة',
  'comment.added': 'تعليق جديد',
  'approval.requested': 'طلب موافقة',
  'approval.decided': 'قرار اعتماد',
  'approval.escalated': 'تأخّر اعتماد',
  'document.expiring': 'اقتراب انتهاء',
  'document.shared': 'مشاركة وثيقة',
};

/** 20rem, matching the w-80 the panel used to carry as a class. */
const PANEL_WIDTH = 320;

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const containerRef = useRef(null);
  const buttonRef = useRef(null);
  // Where the panel actually sits, measured rather than assumed. See below.
  const [anchor, setAnchor] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await api.notifications();
      setNotifications(result.notifications);
      setUnread(result.unread);
    } catch {
      // A failed poll is not worth telling anyone about; the next one may work.
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Clicking outside closes the panel. Without this it stays open behind
  // whatever the user clicked next, which reads as the page being stuck.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function openPanel() {
    setOpen((value) => !value);
    if (!open) await load();
  }

  async function go(notification) {
    setOpen(false);
    await api.markRead(notification.notificationId).catch(() => {});
    setUnread((count) => Math.max(0, count - (notification.read ? 0 : 1)));

    if (notification.documentId) navigate(`/documents/${notification.documentId}`);
    else if (notification.folderId) navigate(`/folders/${notification.folderId}`);
  }

  /*
   * The panel is placed against the viewport, not against its container.
   *
   * ─── Why not simply anchor it to one edge of the bell ──────────────────
   *
   * It was anchored to the inline-start, and in RTL that is the edge with no
   * room: the bell sits in the inline-start corner of the header, so a 20rem
   * panel growing that way hung off the side of the window and took its own
   * content with it. Moving the anchor to the other edge fixes the wide window
   * and breaks the narrow one, where the panel then runs off the opposite side
   * instead. Neither edge is right, because the correct position is not a
   * property of the bell at all — it is whichever placement is on screen.
   *
   * So the panel is measured against the window and clamped into it, which is
   * the same approach the row action ring uses and for the same reason. It costs
   * a measurement and means the panel must follow the window: hence the resize
   * and scroll listeners, in the capture phase because a scroll event does not
   * bubble.
   */
  const place = useCallback(() => {
    const box = buttonRef.current?.getBoundingClientRect();
    if (!box) return;

    const margin = 8;
    const width = Math.min(PANEL_WIDTH, window.innerWidth - margin * 2);
    // Preferred: hanging from the bell, extending toward the page. Clamped, so
    // a bell near either edge still produces a panel that is wholly visible.
    const preferred = box.right - width;
    const left = Math.max(margin, Math.min(preferred, window.innerWidth - width - margin));

    setAnchor({ top: box.bottom + margin, left, width });
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);

    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        onClick={openPanel}
        aria-label={`الإشعارات${unread ? ` (${unread} غير مقروء)` : ''}`}
        className="relative rounded-lg border border-border bg-surface p-2 text-text-muted
          transition-colors hover:bg-primary/10 hover:text-primary"
      >
        <Bell size={16} />
        {unread > 0 ? (
          // Positioned on the inline-end so RTL puts it on the left of the bell,
          // which is where the eye lands last.
          <span
            className="num absolute -top-1 flex h-4 min-w-4 items-center justify-center rounded-full
              bg-primary px-1 text-[10px] font-medium text-on-primary"
            style={{ insetInlineEnd: '-0.25rem' }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="fixed z-30 overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
          // Hidden until measured, so it never paints once in the wrong place
          // and then jumps into the right one.
          style={
            anchor
              ? { top: anchor.top, left: anchor.left, width: anchor.width }
              : { visibility: 'hidden' }
          }
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold text-text">الإشعارات</span>
            {unread > 0 ? (
              <button
                onClick={async () => {
                  await api.markRead(null);
                  await load();
                }}
                className="text-xs text-primary hover:underline"
              >
                تعليم الكل كمقروء
              </button>
            ) : null}
          </div>

          <ul className="max-h-96 divide-y divide-border/50 overflow-y-auto">
            {notifications.map((notification) => (
              <li key={notification.notificationId}>
                <button
                  onClick={() => go(notification)}
                  className={`w-full px-3 py-2.5 text-right transition-colors hover:bg-surface-muted/50 ${
                    notification.read ? '' : 'bg-primary/5'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-primary">
                      {KIND_LABELS[notification.kind] ?? notification.kind}
                    </span>
                    <span className="num text-[11px] text-text-muted">
                      {formatDate(notification.createdAt)}
                    </span>
                  </div>
                  <p className="truncate text-sm text-text">{notification.title}</p>
                  {notification.body ? (
                    <p className="truncate text-xs text-text-muted">{notification.body}</p>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-text-muted">لا توجد إشعارات.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
