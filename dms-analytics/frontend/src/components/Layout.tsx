import { useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useSession, useSyncStatus } from '../api/hooks';
import { fmtDateTime, fmtInt, fmtRelative } from '../lib/format';
import { filterQuery, readFilters } from '../state/filters';
import { ModeBadge } from './Badges';
import { Icon } from './Icon';
import { useVariant } from '../lib/variant';
import { Loading, NoDataState, ErrorState } from './States';

const NAV = [
  { to: '/', label: 'Portfolio', icon: 'grid', keepFilters: true, end: true },
  { to: '/controls', label: 'Controls', icon: 'shield', keepFilters: true },
  { to: '/exceptions', label: 'Exceptions', icon: 'alert', keepFilters: true },
  { to: '/matters', label: 'Matters', icon: 'folder', keepFilters: true },
  { to: '/key-dates', label: 'Key dates', icon: 'calendar' },
  { to: '/lexcel', label: 'Lexcel sampling', icon: 'sample' },
];

export function Layout() {
  const location = useLocation();
  const filters = readFilters(new URLSearchParams(location.search));
  const qs = filterQuery(filters);
  const session = useSession();
  const sync = useSyncStatus();
  const qc = useQueryClient();

  // When a sync finishes, refresh everything shown on screen.
  const prev = useRef(sync.data?.state);
  useEffect(() => {
    const now = sync.data?.state;
    if (prev.current && prev.current !== 'idle' && now === 'idle') void qc.invalidateQueries();
    prev.current = now;
  }, [sync.data?.state, qc]);

  const variant = useVariant();
  const s = session.data;
  const run = sync.data?.current;
  const pct = run && run.workspaces_total ? Math.round((100 * run.workspaces_done) / run.workspaces_total) : null;

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidenav" aria-label="Main navigation">
        <div className="brand">
          <div className="brand-mark">
            <span className="brand-logo" aria-hidden="true">BWS</span>
            <span>
              <div className="brand-name">Risk Analytics</div>
              <div className="brand-sub">Matter file compliance</div>
            </span>
          </div>
        </div>
        <nav aria-label="Sections">
          {NAV.map((n) => (
            <NavLink key={n.to} to={{ pathname: n.to, search: n.keepFilters ? qs : '' }} end={n.end}
              className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
              <Icon name={n.icon} /> {n.label}
            </NavLink>
          ))}
          <div className="nav-section">App</div>
          {variant.appNav ? (
            <NavLink to={variant.appNav.to} className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
              <Icon name={variant.appNav.icon} /> {variant.appNav.label}
            </NavLink>
          ) : (
            <NavLink to="/settings" className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
              <Icon name="settings" /> Sync &amp; settings
            </NavLink>
          )}
        </nav>
        <div className="sidenav-foot">
          {variant.sidenavFoot ?? <>Read-only. Metadata only.<br />Data stays on this laptop.</>}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="topbar-meta">
            {variant.topbar ?? <>
            <ModeBadge mode={s?.mode} />
            {s ? (
              <span title={s.last_sync_at ? fmtDateTime(s.last_sync_at) : undefined} data-testid="last-synced">
                Last synced: <strong>{s.last_sync_at ? fmtRelative(s.last_sync_at) : 'never'}</strong>
                {s.last_sync_at ? <span className="muted"> ({fmtDateTime(s.last_sync_at)})</span> : null}
              </span>
            ) : null}
            {s ? (
              <span className="row" style={{ gap: 6 }}>
                <Icon name="user" size={14} />
                {s.signed_in ? (s.user_display_name ?? 'Signed in') : <Link to="/settings">Not signed in</Link>}
              </span>
            ) : null}
            </>}
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {sync.data && sync.data.state !== 'idle' ? (
            <div className="banner info no-print" role="status" data-testid="sync-banner">
              <span className="spinner" aria-hidden="true" />
              <span className="grow">
                <strong>{sync.data.state === 'cancelling' ? 'Cancelling sync…' : 'Sync in progress'}</strong>
                {pct !== null ? ` — ${pct}% (${fmtInt(run?.workspaces_done)} of ${fmtInt(run?.workspaces_total)} workspaces).` : '.'}{' '}
                Figures will refresh when it finishes.
              </span>
              {location.pathname !== '/settings' ? <Link to="/settings">View progress</Link> : null}
            </div>
          ) : null}
          {variant.coverage !== undefined ? variant.coverage : s && s.has_data ? (
            <div className="coverage" data-testid="coverage">
              <Icon name="info" />
              <span>
                Based on <strong>{fmtInt(s.coverage.workspaces_visible)} workspaces</strong> visible to you in{' '}
                {fmtInt(s.coverage.libraries)} {s.coverage.libraries === 1 ? 'library' : 'libraries'} ({fmtInt(s.coverage.documents)} documents).
                Results show filing evidence in iManage, not whether a step happened.
              </span>
            </div>
          ) : null}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Shows first-run guidance instead of a data screen when nothing has been synced. */
export function RequireData({ children }: { children: ReactNode }) {
  const session = useSession();
  const { noData } = useVariant();
  if (session.isPending) return <Loading />;
  if (session.isError) return <ErrorState error={session.error} onRetry={() => void session.refetch()} />;
  if (!session.data.has_data) return noData ? <>{noData}</> : <div className="card"><NoDataState /></div>;
  return <>{children}</>;
}

export function PageHead({ title, lead, actions }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {lead ? <p className="lead">{lead}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}
