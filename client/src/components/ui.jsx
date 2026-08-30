/**
 * Shared primitives, built to docs/UI_UX_AGENT_STANDARDS.md.
 *
 * These exist so the token classes are written once. A component that hardcodes
 * a colour is the thing the guide forbids, and the reliable way to prevent it is
 * to leave nowhere that needs one.
 */

import { Loader2 } from 'lucide-react';

export function Button({ variant = 'primary', icon: Icon, children, className = '', ...props }) {
  const variants = {
    primary: 'bg-primary text-on-primary hover:bg-primary-dark border-primary',
    secondary: 'bg-surface text-text hover:bg-surface-muted border-border',
    // Delete is one of the guide's allowed semantic-colour exceptions.
    danger: 'bg-surface text-red-600 hover:bg-red-50 border-red-200',
  };

  return (
    <button
      className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium
        transition-colors disabled:cursor-not-allowed disabled:opacity-50
        focus:outline-none focus:ring-2 focus:ring-primary/40 ${variants[variant]} ${className}`}
      {...props}
    >
      {Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className = '', ...props }) {
  return (
    <button
      title={label}
      aria-label={label}
      className={`rounded-lg border border-border bg-surface p-2 text-text-muted
        transition-colors hover:bg-primary/10 hover:text-primary
        focus:outline-none focus:ring-2 focus:ring-primary/40 ${className}`}
      {...props}
    >
      <Icon size={16} />
    </button>
  );
}

export function TextField({ label, hint, error, className = '', ...props }) {
  return (
    <label className="block">
      {label ? <span className="mb-1.5 block text-sm font-medium text-text">{label}</span> : null}
      <input
        dir="rtl"
        className={`w-full rounded-lg border bg-control px-3 py-2 text-sm text-text
          placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40
          ${error ? 'border-red-300' : 'border-border'} ${className}`}
        {...props}
      />
      {hint && !error ? <span className="mt-1 block text-xs text-text-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}

export function Card({ children, className = '' }) {
  return (
    <div className={`rounded-xl border border-border bg-surface ${className}`}>{children}</div>
  );
}

export function Spinner({ label }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-text-muted">
      <Loader2 size={18} className="animate-spin" />
      {label ? <span className="text-sm">{label}</span> : null}
    </div>
  );
}

/** An empty state is a normal outcome here — most users can see only part of the tree. */
export function EmptyState({ icon: Icon, title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      {Icon ? <Icon size={32} className="text-text-muted/60" /> : null}
      <p className="text-sm font-medium text-text">{title}</p>
      {hint ? <p className="max-w-md text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}

export function Alert({ tone = 'error', children }) {
  const tones = {
    error: 'bg-red-50 border-red-200 text-red-600',
    success: 'bg-green-50 border-green-200 text-green-600',
    warning: 'bg-amber-50 border-amber-200 text-amber-600',
    info: 'bg-blue-50 border-blue-200 text-blue-600',
  };
  return (
    // whitespace-pre-line so a message covering several files keeps one per
    // line. Ten failures collapsed into one run-on sentence is how a list of
    // reasons becomes unreadable.
    <div
      className={`whitespace-pre-line rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}
      role="alert"
    >
      {children}
    </div>
  );
}

/**
 * Marks a document the user may see but not open. The requirement was explicit:
 * a browse-only user sees that a document exists and nothing more, so the UI has
 * to say why the row is inert rather than looking broken.
 */
export function ReadOnlyBadge() {
  return (
    <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-600">
      عرض الاسم فقط
    </span>
  );
}
