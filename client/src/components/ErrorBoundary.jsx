/**
 * Catches a render crash and says what it was.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * React unmounts the whole tree when a render throws. Without a boundary the
 * result is a blank white page: no message, no hint which screen failed, and
 * nothing in the interface to report. The only trace is a console the person
 * hitting it has no reason to open.
 *
 * That is how a one-line mistake — reading `.length` off a state that starts as
 * null — presented as "the document page is failing", with the actual
 * `TypeError` visible only in devtools.
 *
 * ─── What it deliberately does not do ───────────────────────────────────────
 *
 * It does not try to recover or retry. A component that threw once during
 * render will throw again on the same data, and an automatic retry loop just
 * hides the fault harder. It offers a reload and a way back, and otherwise gets
 * out of the way.
 *
 * A class component because `componentDidCatch` has no hook equivalent — this
 * is the one thing React still has no function-component API for.
 */

import { Component } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept in the console as well, where the component stack is readable and a
    // developer will look for it.
    console.error('[render error]', error, info?.componentStack);
  }

  componentDidUpdate(previous) {
    // A new route means a different tree; holding the old error would strand the
    // user on a message about a screen they have already left.
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="w-full max-w-xl rounded-xl border border-red-200 bg-surface p-6">
          <div className="flex items-start gap-3">
            <div className="shrink-0 rounded-lg bg-red-50 p-2">
              <AlertTriangle size={20} className="text-red-600" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-text">تعذّر عرض هذه الصفحة</h2>
              <p className="mt-1 text-sm text-text-muted">
                حدث خطأ أثناء بناء الصفحة. بياناتك لم تتأثر.
              </p>
            </div>
          </div>

          {/* The message verbatim: it is what makes a report actionable, and
              hiding it only means it gets described second-hand. */}
          <pre
            dir="ltr"
            className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border
              bg-surface-muted p-3 text-left text-[11px] leading-relaxed text-text"
          >
            {String(error?.stack || error?.message || error)}
          </pre>

          <div className="mt-4 flex flex-row gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 rounded-lg border border-primary bg-primary
                px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-dark"
            >
              <RotateCcw size={16} />
              إعادة التحميل
            </button>
            <button
              type="button"
              onClick={() => window.history.back()}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface
                px-4 py-2 text-sm font-medium text-text hover:bg-surface-muted"
            >
              رجوع
            </button>
          </div>
        </div>
      </div>
    );
  }
}
