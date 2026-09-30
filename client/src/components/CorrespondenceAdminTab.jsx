import { useCallback, useEffect, useMemo, useState } from 'react';
import { Mailbox, Plus, Save } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { Button, Card, Alert, Spinner, TextField, EmptyState } from './ui.jsx';
import TabIntro from './TabIntro.jsx';

/**
 * Administration of the correspondence module: the units letters are routed
 * to, the yearly book counters, and which group staffs the mail room.
 *
 * The on/off switch itself lives with every other switch in الإعدادات — this
 * tab says where, rather than duplicating the control.
 */

export default function CorrespondenceAdminTab() {
  const [status, setStatus] = useState(null);
  const [units, setUnits] = useState(null);
  const [groups, setGroups] = useState([]);
  const [counters, setCounters] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const [moduleStatus, unitList, groupList, counterBooks, settingList] = await Promise.all([
        api.correspondence.status(),
        api.correspondence.units(true),
        api.admin.groups(),
        api.correspondence.counters(),
        api.settings.list(),
      ]);
      setStatus(moduleStatus);
      setUnits(unitList.units);
      // isActive is only ever `false` on a deactivated group; active rows may omit it.
      setGroups(groupList.groups.filter((group) => group.isActive !== false));
      setCounters(counterBooks);
      setSettings(settingList.settings);
    } catch {
      setError('تعذر تحميل إعدادات الوارد والصادر.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!status || !units || !counters || !settings) return <Spinner />;

  const enabled = status.enabled === true;

  return (
    <div className="space-y-4">
      <TabIntro topic="admin.correspondence" />

      {!enabled ? (
        <Alert tone="warning">
          الوحدة معطّلة حالياً. فعّلها من «الإعدادات ← الوارد والصادر ← وحدة الوارد والصادر»، ثم
          عد إلى هنا لتعريف الأقسام وقلم الوارد.
        </Alert>
      ) : null}

      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <MailroomCard
        groups={groups}
        settings={settings}
        disabled={!enabled}
        onSaved={() => {
          setNotice('حُفظت مجموعة قلم الوارد.');
          load();
        }}
      />
      <IntakeFolderCard
        settings={settings}
        disabled={!enabled}
        onSaved={() => {
          setNotice('حُفظ مجلد الاستلام.');
          load();
        }}
      />
      <UnitsCard units={units} groups={groups} disabled={!enabled} onChanged={load} />
      <CountersCard
        counters={counters}
        disabled={!enabled}
        onSaved={() => {
          setNotice('حُفظ العدّاد.');
          load();
        }}
      />
    </div>
  );
}

/** Which group registers, forwards and follows up. Stored as a setting. */
function MailroomCard({ groups, settings, disabled, onSaved }) {
  const stored = settings.find((setting) => setting.key === 'correspondence.mailroom_group');
  const [groupId, setGroupId] = useState(String(stored?.value || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.settings.set('correspondence.mailroom_group', Number(groupId) || 0);
      onSaved();
    } catch {
      setError('تعذر الحفظ.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h3 className="mb-1 text-sm font-semibold text-text">قلم الوارد</h3>
      <p className="mb-3 text-xs text-text-muted">
        أعضاء هذه المجموعة يسجّلون الكتب ويحيلونها ويتابعونها. مديرو النظام يملكون ذلك دائماً.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-row flex-wrap items-end gap-2">
        <label className="block min-w-56">
          <span className="mb-1.5 block text-sm font-medium text-text">المجموعة</span>
          <select
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            disabled={disabled}
            className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text"
          >
            <option value="">— بلا مجموعة (مديرو النظام فقط) —</option>
            {groups.map((group) => (
              <option key={group.groupId} value={group.groupId}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <Button icon={Save} disabled={disabled || busy} onClick={save}>
          حفظ
        </Button>
      </div>
    </Card>
  );
}

/**
 * Where the تسجيل كتاب screen scans and uploads to, and whose unregistered
 * documents it lists. A folder picked from the tree by its full path, because
 * a bare name is ambiguous the moment two folders share one.
 */
function IntakeFolderCard({ settings, disabled, onSaved }) {
  const stored = settings.find((setting) => setting.key === 'correspondence.intake_folder');
  const [folderId, setFolderId] = useState(String(stored?.value || ''));
  const [folders, setFolders] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .tree()
      .then((result) => setFolders(result.folders ?? []))
      .catch(() => {
        setFolders([]);
        setError('تعذر تحميل شجرة المجلدات.');
      });
  }, []);

  const withPaths = useMemo(() => {
    if (!folders) return [];
    const byId = new Map(folders.map((folder) => [folder.folderId, folder]));
    return folders
      .map((folder) => {
        const parts = [];
        let cursor = folder;
        // Bounded by the map: a cycle would otherwise hang the render.
        for (let hops = 0; cursor && hops < 64; hops += 1) {
          parts.unshift(cursor.name);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
        }
        return { ...folder, path: parts.join(' / ') };
      })
      .sort((a, b) => a.path.localeCompare(b.path, 'ar'));
  }, [folders]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.settings.set('correspondence.intake_folder', Number(folderId) || 0);
      onSaved();
    } catch {
      setError('تعذر الحفظ.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h3 className="mb-1 text-sm font-semibold text-text">مجلد الاستلام</h3>
      <p className="mb-3 text-xs text-text-muted">
        شاشة «تسجيل كتاب» تمسح وترفع إلى هذا المجلد، وتعرض ما فيه من وثائق لم تُقيَّد بعد —
        فلا يبقى كتاب ممسوح خارج الدفاتر.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-row flex-wrap items-end gap-2">
        <label className="block min-w-72 flex-1">
          <span className="mb-1.5 block text-sm font-medium text-text">المجلد</span>
          <select
            value={folderId}
            onChange={(event) => setFolderId(event.target.value)}
            disabled={disabled || !folders}
            className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text"
          >
            <option value="">— غير محدد (تبويب «تسجيل كتاب» معطّل) —</option>
            {withPaths.map((folder) => (
              <option key={folder.folderId} value={folder.folderId}>
                {folder.path}
              </option>
            ))}
          </select>
        </label>
        <Button icon={Save} disabled={disabled || busy || !folders} onClick={save}>
          حفظ
        </Button>
      </div>
    </Card>
  );
}

const BLANK_UNIT = { unitId: null, name: '', groupId: '' };

function UnitsCard({ units, groups, disabled, onChanged }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (draft.unitId) {
        await api.correspondence.updateUnit(draft.unitId, {
          name: draft.name,
          groupId: draft.groupId,
        });
      } else {
        await api.correspondence.createUnit({ name: draft.name, groupId: draft.groupId });
      }
      setDraft(null);
      onChanged();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'name_taken'
          ? 'يوجد قسم فعّال بهذا الاسم.'
          : 'تعذر الحفظ. تأكد من الاسم والمجموعة.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggle(unit) {
    setBusy(true);
    setError(null);
    try {
      await api.correspondence.setUnitActive(unit.unitId, !unit.isActive);
      onChanged();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'unit_has_open_transfers'
          ? `لا يُعطَّل قسم لديه إحالات مفتوحة (${caught.body?.open}). أغلقها أو اسحبها أولاً من «متابعة الإحالات».`
          : 'تعذر التغيير.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">الأقسام</h3>
        <Button
          icon={Plus}
          disabled={disabled || busy || draft !== null}
          onClick={() => setDraft({ ...BLANK_UNIT })}
          className="!px-3 !py-1 text-xs"
        >
          قسم جديد
        </Button>
      </div>

      <p className="mb-3 text-xs text-text-muted">
        لا يظهر «الوارد إليّ» إلا لأعضاء مجموعات الأقسام المعرّفة هنا.
      </p>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {draft ? (
        <div className="mb-3 flex flex-row flex-wrap items-end gap-2 rounded-lg border border-border bg-surface-muted/30 p-3">
          <div className="min-w-48 flex-1">
            <TextField
              label="اسم القسم"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="مثال: الشؤون المالية"
            />
          </div>
          <label className="block min-w-48">
            <span className="mb-1.5 block text-sm font-medium text-text">مجموعة أعضائه</span>
            <select
              value={draft.groupId}
              onChange={(event) => setDraft({ ...draft, groupId: event.target.value })}
              className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text"
            >
              <option value="">اختر…</option>
              {groups.map((group) => (
                <option key={group.groupId} value={group.groupId}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={busy || !draft.name.trim() || !draft.groupId} onClick={save}>
            حفظ
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDraft(null)}>
            إلغاء
          </Button>
        </div>
      ) : null}

      {units.length === 0 && !draft ? (
        <EmptyState
          icon={Mailbox}
          title="لا أقسام معرّفة بعد"
          hint="القسم اسمٌ ومجموعة: تُحال الكتب إليه فيراها أعضاء مجموعته في «الوارد إليّ»."
        />
      ) : (
        <ul className="divide-y divide-border/50">
          {units.map((unit) => (
            <li key={unit.unitId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className={`font-medium ${unit.isActive ? 'text-text' : 'text-text-muted line-through'}`}>
                {unit.name}
              </span>
              <span className="text-xs text-text-muted">← {unit.groupName}</span>
              <span className="ms-auto flex gap-3">
                <button
                  disabled={disabled || busy}
                  onClick={() => setDraft({ unitId: unit.unitId, name: unit.name, groupId: unit.groupId })}
                  className="text-xs text-primary hover:underline"
                >
                  تعديل
                </button>
                <button
                  disabled={disabled || busy}
                  onClick={() => toggle(unit)}
                  className="text-xs text-text-muted hover:text-text"
                >
                  {unit.isActive ? 'تعطيل' : 'تفعيل'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The two yearly books, with the migration path from a paper register. */
function CountersCard({ counters, disabled, onSaved }) {
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(direction) {
    const value = Number(drafts[direction]);
    setBusy(true);
    setError(null);
    try {
      await api.correspondence.setCounter({ direction, year: counters.year, nextNumber: value });
      setDrafts({ ...drafts, [direction]: '' });
      onSaved();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'below_issued'
          ? `لا يمكن الرجوع بالعدّاد: آخر رقم صادر في هذا الدفتر هو ${caught.body?.highestIssued}.`
          : 'تعذر الحفظ. أدخل رقماً صحيحاً موجباً.',
      );
    } finally {
      setBusy(false);
    }
  }

  const NAMES = { in: 'دفتر الوارد', out: 'دفتر الصادر' };

  return (
    <Card className="p-4">
      <h3 className="mb-1 text-sm font-semibold text-text">
        <span>عدّادات سنة </span>
        <span className="num">{counters.year}</span>
      </h3>
      <p className="mb-3 text-xs text-text-muted">
        عند الانتقال من دفتر ورقي في منتصف السنة: اجعل «الرقم التالي» ما بعد آخر رقم في الدفتر
        الورقي. لا يقبل النظام إرجاع العدّاد تحت رقم صدر فعلاً.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {counters.books.map((book) => (
          <div key={book.direction} className="rounded-lg border border-border p-3">
            <p className="text-sm font-medium text-text">{NAMES[book.direction]}</p>
            <p className="num mt-1 text-xs text-text-muted">
              الرقم التالي: {book.nextNumber} · آخر رقم صادر: {book.highestIssued || '—'}
            </p>
            <div className="mt-2 flex flex-row items-end gap-2">
              <div className="w-28">
                <TextField
                  label="الرقم التالي"
                  dir="ltr"
                  value={drafts[book.direction] ?? ''}
                  onChange={(event) =>
                    setDrafts({ ...drafts, [book.direction]: event.target.value })
                  }
                  placeholder={String(book.nextNumber)}
                />
              </div>
              <Button
                variant="secondary"
                disabled={disabled || busy || !/^\d+$/.test(drafts[book.direction] ?? '')}
                onClick={() => save(book.direction)}
                className="!px-3 !py-2 text-xs"
              >
                حفظ
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
