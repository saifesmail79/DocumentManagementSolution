import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  FileText,
  Download,
  Save,
  History,
  Folder,
  ArrowRight,
  ClipboardList,
  ShieldCheck,
  MessageSquare,
  Tag,
  Link2,
  CheckCircle2,
  Share2,
  ScanSearch,
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDate, formatBytes } from '../format.js';
import { Button, Card, Spinner, Alert, TextField, ReadOnlyBadge } from '../components/ui.jsx';
import SearchabilityNotice, { EXTRACTION } from '../components/SearchabilityNotice.jsx';
import { previewMode, PreviewBody } from '../components/DocumentPreview.jsx';
import {
  TagPanel,
  CommentPanel,
  RelationPanel,
  StatePanel,
  SharePanel,
  ApprovalPanel,
  VersionPanel,
} from '../components/DocumentPanels.jsx';
import ClassificationPanel from '../components/ClassificationPanel.jsx';
import { useAuth } from '../auth.jsx';

/**
 * The sections of a document, in the order they are worked through: read it,
 * describe it, control it, then everything that accumulates around it.
 *
 * `count` reads the tally a panel reported; `filled` is for sections that hold
 * no list but can still be "set" — the state tab is filled when a lock, a hold
 * or an expiry is on the document.
 *
 * ─── Why everything but the document is capped ──────────────────────────────
 *
 * These panels used to sit in a third-width column, which quietly kept their
 * controls to a sensible size. Full-width tabs removed that, and a form
 * stretched across a wide monitor is worse than one that is merely tall: a
 * four-option dropdown rendered a metre wide tells the reader nothing about how
 * much input it wants, and the eye has to travel from a right-aligned label to
 * a far-left control to pair them up.
 *
 * The document viewer is the one thing that genuinely wants the room.
 */
const SECTIONS = [
  // `wide` opts a tab out of the reading-width cap below.
  { key: 'document', label: 'الوثيقة', icon: FileText, wide: true },
  { key: 'metadata', label: 'البيانات', icon: ClipboardList },
  { key: 'state', label: 'الحالة', icon: ShieldCheck },
  { key: 'versions', label: 'الإصدارات', icon: History },
  { key: 'comments', label: 'المناقشة', icon: MessageSquare },
  { key: 'tags', label: 'الوسوم', icon: Tag },
  { key: 'relations', label: 'العلاقات', icon: Link2 },
  { key: 'approvals', label: 'الاعتماد', icon: CheckCircle2 },
  { key: 'shares', label: 'المشاركة', icon: Share2 },
  // Shown only while the recognition pilot is switched on; the panel reports
  // the switch's state and the tab is dropped when it is off.
  { key: 'classification', label: 'التعرّف', icon: ScanSearch, pilot: true },
];

/**
 * One document: its metadata, its custom fields, and its version history.
 *
 * The form is built from the field definitions the server returns for the chosen
 * type, so a deployment that defines its own vocabulary gets its own form with
 * no change here.
 */
export default function DocumentDetail() {
  const { documentId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [document, setDocument] = useState(null);
  const [types, setTypes] = useState([]);
  const [labels, setLabels] = useState([]);
  const [fields, setFields] = useState([]);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('document');
  // The recognition pilot's tab exists only while its switch is on. Hidden
  // until the panel reports that it is: a production install, where the
  // switch is off, never shows the tab at all — not even for a moment.
  const [pilotEnabled, setPilotEnabled] = useState(false);

  /*
   * How many items each section holds, reported by the panels themselves.
   *
   * The setters are created once per key and stored in a ref, so each panel
   * receives an identity-stable callback — a fresh closure every render would
   * retrigger the effect that calls it. Writing an unchanged value is a no-op
   * for the same reason.
   */
  const [counts, setCounts] = useState({});
  const setters = useRef({});
  const counter = useCallback((key) => {
    if (!setters.current[key]) {
      setters.current[key] = (n) =>
        setCounts((current) => (current[key] === n ? current : { ...current, [key]: n }));
    }
    return setters.current[key];
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, typeList, labelList] = await Promise.all([
        api.document(documentId),
        api.metadata.types(),
        api.metadata.labels(),
      ]);

      setDocument(detail);
      setTypes(typeList.types);
      setLabels(labelList.labels);

      setForm({
        title: detail.title,
        typeId: detail.typeId ?? '',
        labelId: detail.sensitivityLabelId ?? '',
        values: Object.fromEntries(detail.fields.map((f) => [f.fieldId, f.value ?? ''])),
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? 'الوثيقة غير موجودة أو ليس لديك صلاحية لعرضها.'
          : 'تعذر تحميل الوثيقة.',
      );
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * A freshly uploaded document is always PENDING, and extraction finishes
   * seconds to minutes later. Without this the "being indexed" notice sits there
   * until someone reloads by hand, which reads exactly like the stuck state it
   * exists to distinguish itself from.
   *
   * Polls only while pending, and stops as soon as the status moves — including
   * when it moves to a failure, so the reason appears on its own.
   */
  useEffect(() => {
    if (Number(document?.extractionStatus) !== EXTRACTION.PENDING) return undefined;

    const timer = setInterval(async () => {
      if (window.document.visibilityState !== 'visible') return;
      try {
        // Only the document, and only into the document state: calling load()
        // here would blank the page to a spinner every ten seconds and throw
        // away whatever the user was typing into the metadata form.
        const fresh = await api.document(documentId);
        setDocument((current) =>
          current && fresh.extractionStatus === current.extractionStatus ? current : fresh,
        );
      } catch {
        // A failed poll is not worth reporting; the next one may work.
      }
    }, 10_000);

    return () => clearInterval(timer);
  }, [document?.extractionStatus, documentId]);

  // The applicable field set depends on the chosen type, so it is refetched when
  // the type changes rather than filtered client-side — the server already knows
  // which globals apply.
  useEffect(() => {
    if (!form) return;
    api.metadata
      .fields(form.typeId || undefined)
      .then((result) => setFields(result.fields))
      .catch(() => setFields([]));
  }, [form?.typeId]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      await api.updateMetadata(documentId, {
        title: form.title,
        typeId: form.typeId === '' ? null : Number(form.typeId),
        labelId: form.labelId === '' ? null : Number(form.labelId),
        fields: fields.map((field) => ({
          fieldId: field.fieldId,
          value: form.values[field.fieldId] === '' ? null : form.values[field.fieldId],
        })),
      });
      setSaved(true);
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? {
              forbidden: 'لا تملك صلاحية تعديل بيانات هذه الوثيقة.',
              invalid_title: 'العنوان غير صالح.',
              invalid_value: `قيمة غير صالحة للحقل: ${caught.body?.detail ?? ''}`,
              required_field: `حقل مطلوب: ${caught.body?.detail ?? ''}`,
            }[caught.code] ?? 'تعذر حفظ التعديلات.'
          : 'تعذر حفظ التعديلات.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="جارٍ التحميل…" />;
  if (error && !document) return <Alert tone="error">{error}</Alert>;

  const editable = document.canRead;

  /*
   * The shape the shared preview body expects.
   *
   * The detail payload carries the mime type on the current version rather than
   * at the top level, which is the one difference from a folder row.
   */
  const previewDocument = {
    documentId,
    title: document.title,
    canRead: document.canRead,
    mimeType: document.versions?.[0]?.mimeType ?? null,
    multiFile: document.multiFile,
    fileCount: document.fileCount,
  };

  const previewTarget = !document.canRead
    ? 'denied'
    : document.multiFile
      ? 'multifile'
      : previewMode(previewDocument.mimeType);

  /**
   * What each tab has to show for itself.
   *
   * `count` where a section holds a list, `has` where it is simply set or not:
   * the state tab is configured or it is not, and a "1" on it would be a claim
   * about a quantity that does not exist.
   */
  const sectionState = {
    // Anything the shared body can actually show, which now includes the types
    // that reach the screen through a rendition rather than directly.
    document: { has: previewTarget !== 'denied' && previewTarget !== 'unknown' },
    metadata: {
      has: Boolean(
        form?.typeId
          || form?.labelId
          || Object.values(form?.values ?? {}).some((value) => value !== '' && value != null),
      ),
    },
    state: {
      has: Boolean(
        document.lockedBy
          || document.legalHold
          || document.expiresAt
          || (document.lifecycleState && document.lifecycleState !== 'active'),
      ),
    },
    // Straight from the document, which already carries its versions.
    versions: { count: document.versions.length },
    comments: { count: counts.comments },
    tags: { count: counts.tags },
    relations: { count: counts.relations },
    approvals: { count: counts.approvals },
    shares: { count: counts.shares },
  };

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate(`/folders/${document.folderId}`)}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-primary"
      >
        {/* RTL: ArrowRight reads as "back". */}
        <ArrowRight size={13} />
        العودة إلى المجلد
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <FileText size={20} className="text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-text">{document.title}</h2>
            <p className="num text-xs text-text-muted">
              {document.multiFile
                ? `${document.fileCount} ملفات`
                : `الإصدار ${document.currentVersion}`}{' '}
              · {formatDate(document.updatedAt)}
            </p>
          </div>
          {!document.canRead ? <ReadOnlyBadge /> : null}
        </div>

        {document.canRead ? (
          <a
            // A multi-file document has no single blob to open, so the whole set
            // is offered as one archive. The content route answers 409 for it
            // rather than picking a file the reader did not ask for.
            href={document.multiFile ? api.filesZipUrl(documentId) : api.contentUrl(documentId)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-primary bg-primary px-4 py-2
              text-sm font-medium text-on-primary transition-colors hover:bg-primary-dark"
          >
            <Download size={16} />
            {document.multiFile ? 'تنزيل الكل' : 'فتح'}
          </a>
        ) : null}
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {saved ? <Alert tone="success">تم حفظ التعديلات.</Alert> : null}

      {/* Only shown when there is something to say — a fully indexed document
          renders nothing here. */}
      <SearchabilityNotice
        status={document.extractionStatus}
        reason={document.extractionError}
      />

      {/*
        ─── Tabs, not one long page ──────────────────────────────────────────

        Nine panels stacked vertically meant the answer to "does this document
        have comments?" was several screens of scrolling away, and the document
        itself — the thing the page is about — sat above a form that pushed it
        off screen the moment the metadata had more than a couple of fields.

        Each tab carries a badge when its section holds something, so the whole
        shape of a document is readable from the strip without opening anything.
      */}
      <div className="flex flex-row flex-wrap gap-1 border-b border-border">
        {SECTIONS.filter((section) => !section.pilot || pilotEnabled).map((section) => {
          const state = sectionState[section.key] ?? {};
          const active = tab === section.key;
          const filled = state.count > 0 || state.has;

          return (
            <button
              key={section.key}
              onClick={() => setTab(section.key)}
              aria-current={active ? 'true' : undefined}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
                active
                  ? 'border-primary font-medium text-primary'
                  : `border-transparent hover:text-text ${filled ? 'text-text' : 'text-text-muted'}`
              }`}
            >
              <section.icon size={15} />
              {section.label}

              {/*
                A number where there is one, a dot where the section is set but
                has nothing to count — the state tab is either configured or it
                is not, and "1" would be a lie about what it holds.
              */}
              {state.count > 0 ? (
                <span
                  className={`num rounded-full px-1.5 text-[10px] leading-4 ${
                    active ? 'bg-primary text-on-primary' : 'bg-surface-muted text-text-muted'
                  }`}
                >
                  {state.count}
                </span>
              ) : state.has ? (
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-primary' : 'bg-primary/50'}`}
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/*
        Every panel stays mounted and inactive ones are hidden.

        Unmounting would refetch on every visit, so switching tabs would flicker
        through a spinner and the preview iframe would reload the document each
        time. It also keeps the badges honest: a count cannot be reported by a
        panel that is not there.
      */}
      <div className={tab === 'document' ? '' : 'hidden'}>
        {document.multiFile ? (
          <MultiFileView document={document} documentId={documentId} />
        ) : (
          /*
            The same body the folder's preview pane uses, rather than this page's
            own narrower rule.

            It used to iframe only the types a browser opens unaided and answer
            "cannot be displayed" for the rest — which was wrong for every Office
            file: the worker converts them to PDF, and finished renditions were
            sitting in the database that this page never asked for. Sharing the
            component means Word, Excel, PowerPoint and TIFF scans preview here
            exactly as they do in the folder, including the honest "still being
            prepared" state while the queue catches up.
          */
          /*
            A flex column with a scrolling body — the same shape the folder pane
            uses, and for the reasons that pane already proved.

            `overflow-hidden` on a fixed-height box turns anything taller than it
            into silent truncation, and three different things are taller: a
            scan at its natural size, a long text file, and — on a window under
            about 550px tall — the preview's own `min-h-[24rem]` floor, which
            then exceeds 70vh and clips the bottom of the frame, taking the PDF
            viewer's toolbar with it. None of them showed a scrollbar, so all
            three read as the document simply ending.

            The body scrolls instead, and the height floor moves to the card so
            the box grows rather than its contents being cut.
          */
          <Card className="flex h-[calc(100vh-14rem)] min-h-[26rem] flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-auto">
              <PreviewBody document={previewDocument} mode={previewTarget} />
            </div>
          </Card>
        )}
      </div>

      <div className={tab === 'metadata' ? 'max-w-3xl' : 'hidden'}>
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-text">البيانات الوصفية</h3>

          <form onSubmit={save} className="space-y-3">
            <TextField
              label="العنوان"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              disabled={!editable}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text">النوع</span>
                <select
                  value={form.typeId}
                  onChange={(event) => setForm({ ...form, typeId: event.target.value })}
                  disabled={!editable}
                  className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                    focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">بدون نوع</option>
                  {types.map((type) => (
                    <option key={type.typeId} value={type.typeId}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text">درجة السرية</span>
                <select
                  value={form.labelId}
                  onChange={(event) => setForm({ ...form, labelId: event.target.value })}
                  disabled={!editable}
                  className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                    focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">غير محددة</option>
                  {labels.map((label) => (
                    <option key={label.labelId} value={label.labelId}>
                      {label.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {fields.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.map((field) => (
                  <FieldInput
                    key={field.fieldId}
                    field={field}
                    value={form.values[field.fieldId] ?? ''}
                    disabled={!editable}
                    onChange={(value) =>
                      setForm({ ...form, values: { ...form.values, [field.fieldId]: value } })
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted">لا توجد حقول إضافية لهذا النوع.</p>
            )}

            {editable ? (
              <Button type="submit" icon={Save} disabled={busy}>
                {busy ? 'جارٍ الحفظ…' : 'حفظ'}
              </Button>
            ) : null}
          </form>
        </Card>
      </div>

      <div className={tab === 'state' ? 'max-w-3xl' : 'hidden'}>
        <StatePanel document={document} isSuperAdmin={user.isSuperAdmin} onChanged={load} />
      </div>

      <div className={tab === 'versions' ? 'max-w-3xl' : 'hidden'}>
        <Card className="p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
            <History size={15} className="text-primary" />
            الإصدارات
          </h3>

          {document.versions.length === 0 ? (
            // Version history reveals how often a document changed and who
            // touched it, so browse-only does not receive it.
            <p className="text-xs text-text-muted">
              {document.canRead ? 'لا توجد إصدارات.' : 'يتطلب عرض السجل صلاحية القراءة.'}
            </p>
          ) : (
            <VersionPanel
              documentId={documentId}
              versions={document.versions}
              canRestore={document.permissions?.upload}
              onChanged={load}
            />
          )}

          <button
            onClick={() => navigate(`/folders/${document.folderId}`)}
            className="mt-3 flex items-center gap-1 text-xs text-text-muted hover:text-primary"
          >
            <Folder size={12} />
            المجلد
          </button>
        </Card>
      </div>

      <div className={tab === 'comments' ? 'max-w-3xl' : 'hidden'}>
        <CommentPanel
          documentId={documentId}
          currentUserId={user.userId}
          canRead={document.canRead}
          onCount={counter('comments')}
        />
      </div>

      <div className={tab === 'tags' ? 'max-w-3xl' : 'hidden'}>
        <TagPanel
          documentId={documentId}
          canEdit={document.permissions?.editMeta}
          onCount={counter('tags')}
        />
      </div>

      <div className={tab === 'relations' ? 'max-w-3xl' : 'hidden'}>
        <RelationPanel
          documentId={documentId}
          onOpen={(id) => navigate(`/documents/${id}`)}
          onCount={counter('relations')}
        />
      </div>

      <div className={tab === 'approvals' ? 'max-w-3xl' : 'hidden'}>
        <ApprovalPanel
          documentId={documentId}
          canRead={document.canRead}
          onChanged={load}
          onCount={counter('approvals')}
        />
      </div>

      <div className={tab === 'shares' ? 'max-w-3xl' : 'hidden'}>
        <SharePanel documentId={documentId} canRead={document.canRead} onCount={counter('shares')} />
      </div>

      {/* Mounted regardless so it can report whether the pilot is on; the tab
          that opens it is only offered once it has. */}
      <div className={tab === 'classification' ? 'max-w-3xl' : 'hidden'}>
        <ClassificationPanel
          documentId={documentId}
          canRead={document.canRead}
          onOpen={(id) => navigate(`/documents/${id}`)}
          onCount={counter('classification')}
          onEnabled={setPilotEnabled}
        />
      </div>
    </div>
  );
}

/** Renders the input a field's data type calls for. */
function FieldInput({ field, value, disabled, onChange }) {
  const label = (
    <span className="mb-1.5 block text-sm font-medium text-text">
      {field.name}
      {field.isRequired ? <span className="text-red-600"> *</span> : null}
    </span>
  );

  const base =
    'rounded-lg border border-border bg-control px-3 py-2 text-sm text-text ' +
    'focus:outline-none focus:ring-2 focus:ring-primary/40';

  /*
   * Width follows the data type.
   *
   * A date is ten characters and a number is rarely more; stretching either to
   * the column width makes them look like free text and leaves the label and
   * the input at opposite ends of the row. Text and choice fields keep the full
   * column, because their content really can be long.
   */
  const classes = `w-full ${base}`;
  const narrow = (width) => `${width} ${base}`;

  if (field.dataType === 'choice') {
    return (
      <label className="block">
        {label}
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={classes}
        >
          <option value="">—</option>
          {field.choices.map((choice) => (
            <option key={choice.choiceId} value={choice.choiceId}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.dataType === 'bool') {
    return (
      <label className="flex items-center gap-2 pt-6 text-sm text-text">
        <input
          type="checkbox"
          checked={value === true || value === 'true'}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.name}
      </label>
    );
  }

  if (field.dataType === 'date') {
    return (
      <label className="block">
        {label}
        <input
          type="date"
          // Trimmed to yyyy-MM-dd: a date input rejects a full ISO timestamp.
          value={value ? String(value).slice(0, 10) : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
          dir="ltr"
          className={narrow('w-44')}
        />
      </label>
    );
  }

  return (
    <label className="block">
      {label}
      <input
        // type="text" even for numbers: a number input swallows keystrokes and
        // fights RTL, and the server validates the value anyway.
        type="text"
        inputMode={field.dataType === 'number' ? 'decimal' : undefined}
        dir={field.dataType === 'number' ? 'ltr' : 'rtl'}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        // A number gets a number's width; free text keeps the column.
        className={field.dataType === 'number' ? narrow('w-40') : classes}
      />
    </label>
  );
}


/**
 * The constituent files of a document filed as one entry.
 *
 * ─── Why a list beside a preview, and not a preview alone ───────────────────
 *
 * A multi-file document has no single file to show, and choosing one for it —
 * the first, the largest — would present part of a document as though it were
 * the whole. So the files are listed, the reader picks, and the pane shows what
 * they picked. The first is selected on arrival because opening onto an empty
 * pane to make a point would be worse than a sensible default.
 *
 * The list is rendered even when nothing in it can be previewed: knowing a
 * document is made of five files, and their names and sizes, is useful on its
 * own, and each row still opens in a new tab.
 */
function MultiFileView({ document, documentId }) {
  const files = document.files ?? [];
  const [activeFileId, setActiveFileId] = useState(files[0]?.fileId ?? null);

  if (!document.canRead) {
    return (
      <Card className="p-6">
        <p className="text-sm text-text-muted">ليست لديك صلاحية قراءة محتوى هذه الوثيقة.</p>
      </Card>
    );
  }

  const active = files.find((file) => file.fileId === activeFileId) ?? files[0] ?? null;

  /*
   * The descriptor the shared body wants, naming the file rather than the
   * document.
   *
   * This view used to accept only the types a browser opens unaided and answer
   * "cannot be displayed" for the rest — so a document filed as five .docx
   * scans could not be read at all, even though LibreOffice converts each in
   * seconds. Renditions are now addressable per file, so the same component
   * that previews a folder row previews a constituent.
   */
  const activeDescriptor = active
    ? {
      documentId,
      fileId: active.fileId,
      title: active.filename ?? document.title,
      canRead: document.canRead,
      mimeType: active.mimeType,
    }
    : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            ملفات الوثيقة
          </span>
          <span className="num text-xs text-text-muted">{files.length}</span>
        </div>
        <ul className="max-h-[70vh] divide-y divide-border/50 overflow-y-auto">
          {files.map((file) => (
            <li key={file.fileId}>
              <button
                type="button"
                onClick={() => setActiveFileId(file.fileId)}
                aria-current={file.fileId === active?.fileId}
                className={`flex w-full items-center gap-2 px-4 py-2 text-right transition-colors
                  ${
                    file.fileId === active?.fileId
                      ? 'bg-primary/5 text-text'
                      : 'text-text hover:bg-surface-muted/60'
                  }`}
              >
                {/* The stored reading order, which is what extraction and the
                    archive both follow. */}
                <span className="num shrink-0 text-xs text-text-muted">{file.sortOrder + 1}.</span>
                <FileText size={14} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {file.filename ?? `ملف ${file.sortOrder + 1}`}
                </span>
                <span className="num shrink-0 text-xs text-text-muted">
                  {formatBytes(file.bytes)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {activeDescriptor ? (
        // Same scrolling body as the single-file card above.
        <Card className="flex h-[calc(100vh-14rem)] min-h-[26rem] flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-auto">
            {/* Keyed on the file: switching constituents keeps the same document,
                and without a fresh key the previous file's rendition would stay. */}
            <PreviewBody
              key={activeDescriptor.fileId}
              document={activeDescriptor}
              mode={previewMode(activeDescriptor.mimeType)}
            />
          </div>
        </Card>
      ) : (
        // Only reachable when the document lists no files at all — every real
        // constituent now goes through the shared body, which handles its own
        // unsupported and download cases.
        <Card className="p-6">
          <p className="text-sm text-text-muted">لا توجد ملفات في هذه الوثيقة.</p>
        </Card>
      )}
    </div>
  );
}
