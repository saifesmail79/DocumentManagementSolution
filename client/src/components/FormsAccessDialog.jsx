/**
 * Who may use one template.
 *
 * ─── Why groups and users in one list ───────────────────────────────────────
 *
 * Access is stored against `dbo.principals`, the same table folder permissions
 * use, and the server expands a user into their groups with
 * `fn_expand_principals`. So a group and a person are the same kind of answer to
 * the same question, and splitting them into two pickers would only invite the
 * mistake of granting a person what should have been granted to their
 * department — which then has to be re-granted each time the staff changes.
 * Groups are listed first, because naming a group is almost always the right
 * answer.
 *
 * ─── Why the whole set is sent, not a diff ──────────────────────────────────
 *
 * The route replaces the list (`PUT .../access` with `principalIds`). Sending
 * the full set means two administrators editing at once cannot interleave into
 * a state neither of them chose: the last save wins visibly, rather than a
 * half-merged list nobody wrote.
 *
 * An empty list is a real answer and is not treated as a mistake — it means the
 * template is reachable by super administrators only, which is how a template
 * is kept out of circulation while it is being prepared. The dialog says so
 * rather than refusing to save.
 *
 * ─── Why the search asks the server ─────────────────────────────────────────
 *
 * The directory listing the dialog is handed is capped at a hundred rows, so
 * filtering only that list locally would make everyone past the cap ungrantable
 * — and silently, because the list looks complete. So a typed search goes to the
 * server, which reads the whole directory, and its answer replaces the local
 * filter while the box has text in it. This is the same arrangement the groups
 * screen arrived at (Admin.jsx's member picker).
 */

import { useEffect, useMemo, useState } from 'react';
import { Save, Users } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { Alert, Button, TextField } from './ui.jsx';
import { Modal } from './Modal.jsx';

export default function FormsAccessDialog({ open, template, principals, onClose, onSaved }) {
  const [selected, setSelected] = useState([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // What the server answered for the typed search; null = nothing asked yet, or
  // the ask failed, in which case the local filter is still worth something.
  const [found, setFound] = useState(null);

  useEffect(() => {
    if (!open || !template) return;
    setSelected((template.access ?? []).map((entry) => String(entry.principalId)));
    setQuery('');
    setFound(null);
    setError(null);
  }, [open, template]);

  /*
   * Asks the server whenever the box has text, after a pause.
   *
   * Debounced because it would otherwise fire on every keystroke, and the answer
   * for «أح» is thrown away by the time «أحم» is typed.
   */
  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setFound(null);
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await api.admin.principals(needle);
        if (!cancelled) setFound(result.principals ?? []);
      } catch {
        // Falls back to filtering the roster already loaded, which still finds
        // anyone inside the first hundred names.
        if (!cancelled) setFound(null);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const chosen = new Set(selected);

  /*
   * Anyone already granted stays visible whatever the search says.
   *
   * The directory listing is capped at 100 rows, so a grant made last year to
   * someone who does not match today's search term would otherwise disappear
   * from the dialog — and be silently dropped by the next save, because the save
   * sends the whole set.
   */
  const rows = useMemo(() => {
    // While the box has text and the server has answered, its answer is the
    // pool — it searched the whole directory, the loaded roster is only its
    // first page.
    const pool = query.trim() && found ? found : (principals ?? []);
    const known = new Map(pool.map((principal) => [String(principal.principalId), principal]));
    for (const entry of template?.access ?? []) {
      const id = String(entry.principalId);
      if (!known.has(id)) {
        known.set(id, {
          principalId: id,
          displayName: entry.displayName,
          type: entry.kind === 'group' ? 'group' : 'user',
        });
      }
    }

    const needle = query.trim().toLowerCase();
    return [...known.values()]
      .filter((principal) => {
        if (selected.includes(String(principal.principalId))) return true;
        // `found` is already the server's answer to this very term; filtering it
        // again locally would only re-apply a narrower rule to it.
        if (!needle || found) return true;
        return (
          (principal.displayName ?? '').toLowerCase().includes(needle)
          || (principal.username ?? '').toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'group' ? -1 : 1;
        return (a.displayName ?? '').localeCompare(b.displayName ?? '', 'ar');
      });
  }, [principals, template, query, selected, found]);

  // `listPrincipals` answers at most a hundred rows, so a full roster is the
  // sign that there are probably more names than are on screen.
  const capped = !query.trim() && (principals ?? []).length >= 100;

  function toggle(principalId) {
    const id = String(principalId);
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.forms.adminSetAccess(template.templateId, selected);
      onSaved();
      onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'not_found'
          ? 'النموذج أو أحد المختارين غير موجود. حدّث الصفحة.'
          : 'تعذر حفظ الصلاحيات. أعد المحاولة.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`من يستخدم النموذج: ${template?.name ?? ''}`}
      subtitle="مديرو النظام يستخدمون كل النماذج دائماً."
      icon={Users}
      size="md"
      footer={
        <>
          <Button icon={Save} onClick={save} disabled={busy}>
            حفظ
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <TextField
          label="ابحث عن مجموعة أو مستخدم"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="اسم المجموعة أو اسم المستخدم"
          hint={
            capped
              ? 'القائمة تعرض أول مئة اسم فقط — اكتب اسماً للبحث في الدليل كله.'
              : 'البحث يمرّ على الدليل كله، لا على المعروض فقط.'
          }
        />

        {selected.length === 0 ? (
          <Alert tone="info">
            لم تُختر أي جهة: لن يظهر النموذج لأحد غير مديري النظام. هذا مقصود أثناء إعداد النموذج.
          </Alert>
        ) : (
          <p className="text-xs text-text-muted">
            <span>المختار: </span>
            <span className="num">{selected.length}</span>
          </p>
        )}

        <ul className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
          {rows.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-text-muted">لا نتائج مطابقة.</li>
          ) : null}
          {rows.map((principal) => (
            <li key={principal.principalId}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-primary/10">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={chosen.has(String(principal.principalId))}
                  onChange={() => toggle(principal.principalId)}
                />
                <span className="text-text">{principal.displayName}</span>
                <span className="ms-auto text-xs text-text-muted">
                  {principal.type === 'group' ? 'مجموعة' : (principal.username ?? 'مستخدم')}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
