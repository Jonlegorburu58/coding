import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/client';
import { Icon } from './Icon';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <span className="ico-wrap"><Icon name="alert" size={20} /></span>
      <h2>We couldn't load this</h2>
      <p>{errorMessage(error)}</p>
      {onRetry ? <button type="button" className="btn" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

export function NoDataState() {
  return (
    <div className="state" data-testid="no-data">
      <span className="ico-wrap"><Icon name="database" size={20} /></span>
      <h2>No data yet. Run your first sync.</h2>
      <p>
        The app has not read any matters from iManage yet. Go to Sync &amp; settings, sign in to iManage, and start a
        sync. The first sync can take a while; you can keep using your laptop as normal.
      </p>
      <Link className="btn primary" to="/settings">Go to Sync &amp; settings</Link>
    </div>
  );
}

/** A trend with only one snapshot: no line is drawn (it would suggest a trend that does not exist). */
export function SingleSnapshot({ title, body }: { title: string; body: string }) {
  return (
    <div className="state" data-testid="single-snapshot">
      <span className="ico-wrap"><Icon name="chart" size={20} /></span>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

export function EmptyResults({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <span className="ico-wrap"><Icon name="search" size={20} /></span>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function SessionExpired() {
  return (
    <div className="fullscreen-state">
      <div className="card" role="alert">
        <div className="state" style={{ padding: 0 }}>
          <span className="ico-wrap"><Icon name="lock" size={20} /></span>
          <h1 style={{ fontSize: 20 }}>Session expired</h1>
          <p>Session expired. Close this window and reopen the app.</p>
          <p className="muted small">
            For your security this window only works for the session it was opened with. Reopening the app from the Start
            menu starts a new session. Your data is still on this laptop.
          </p>
        </div>
      </div>
    </div>
  );
}
