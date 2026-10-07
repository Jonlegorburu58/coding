import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/client';
import {
  qk,
  useCancelSync,
  useSaveSettings,
  useSession,
  useSettings,
  useSignIn,
  useSignOut,
  useStartSync,
  useSyncStatus,
  useWipe,
} from '../api/hooks';
import type { Settings, SignInStart, SyncKind, SyncRun } from '../api/types';
import { ModeBadge } from '../components/Badges';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Layout';
import { ErrorState, Loading } from '../components/States';
import { fmtDateTime, fmtInt, fmtRelative } from '../lib/format';

const RUN_KIND: Record<SyncRun['kind'], string> = { full: 'Full sync', incremental: 'Update', reconcile: 'Access check' };
const RUN_STATUS: Record<SyncRun['status'], string> = { running: 'Running', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

export function SettingsPage() {
  return (
    <>
      <PageHead title="Sync & settings" lead="Sign in to iManage, refresh the local copy of matter data, and manage what is kept on this laptop." />
      <div className="settings-grid">
        <div className="stack-v" style={{ gap: 16 }}>
          <SignInCard />
          <SyncCard />
        </div>
        <div className="stack-v" style={{ gap: 16 }}>
          <PreferencesCard />
          <WipeCard />
          <AboutCard />
        </div>
      </div>
    </>
  );
}

function SignInCard() {
  const session = useSession();
  const signIn = useSignIn();
  const signOut = useSignOut();
  const qc = useQueryClient();
  const [started, setStarted] = useState<SignInStart | null>(null);
  // Once signed in, the sign-in instructions are no longer relevant.
  const pending = session.data?.signed_in ? null : started;

  // While waiting for the user to finish signing in elsewhere, poll the session.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: qk.session }), 2000);
    return () => clearInterval(t);
  }, [pending, qc]);

  async function onSignIn() {
    const r = await signIn.mutateAsync();
    if (r.status === 'signed_in') await qc.invalidateQueries({ queryKey: qk.session });
    else setStarted(r);
  }

  const s = session.data;
  return (
    <section className="card" aria-labelledby="signin-h">
      <div className="card-head">
        <div className="titles"><h2 id="signin-h">iManage sign-in</h2><div className="sub">The app signs in as you and sees only what you can see.</div></div>
        <ModeBadge mode={s?.mode} />
      </div>
      <div className="card-body stack-v">
        {session.isPending ? <Loading /> : session.isError ? <ErrorState error={session.error} /> : (
          <>
            <dl className="kv">
              <dt>Status</dt>
              <dd data-testid="signin-status">{s!.signed_in ? <>Signed in as {s!.user_display_name ?? 'you'}</> : 'Not signed in'}</dd>
              <dt>Source</dt><dd>{s!.source_name}</dd>
            </dl>
            {pending?.status === 'device_code' ? (
              <div className="banner info" role="status" style={{ flexDirection: 'column', gap: 8 }} data-testid="device-code">
                <strong>Finish signing in on the iManage page</strong>
                <span>1. In your browser, go to this address:</span>
                <span className="mono" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{pending.verification_url}</span>
                <span>2. Enter this code when asked:</span>
                <span className="device-code" aria-label={`Code ${pending.user_code?.split('').join(' ')}`}>{pending.user_code}</span>
                <span className="small secondary">This page updates by itself once you have signed in.</span>
              </div>
            ) : null}
            {pending?.status === 'browser_opened' ? (
              <div className="banner info" role="status">
                <Icon name="info" />
                <span>A sign-in page has opened in your browser. Finish signing in there; this page updates by itself.</span>
              </div>
            ) : null}
            {signIn.isError ? <p className="banner error" role="alert">{errorMessage(signIn.error)}</p> : null}
            {signOut.isError ? <p className="banner error" role="alert">{errorMessage(signOut.error)}</p> : null}
            <div className="row">
              {!s!.signed_in ? (
                <button type="button" className={pending ? 'btn' : 'btn primary'} onClick={() => void onSignIn().catch(() => undefined)} disabled={signIn.isPending}>
                  {signIn.isPending ? 'Starting sign-in…' : pending ? 'Start sign-in again' : 'Sign in to iManage'}
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
                  {signOut.isPending ? 'Signing out…' : 'Sign out'}
                </button>
              )}
            </div>
            {s!.signed_in ? <p className="small muted">Signing out removes your iManage sign-in from this laptop. The data already synced is kept until you wipe it.</p> : null}
          </>
        )}
      </div>
    </section>
  );
}

function SyncCard() {
  const sync = useSyncStatus();
  const session = useSession();
  const start = useStartSync();
  const cancel = useCancelSync();
  const st = sync.data;
  const run = st?.current ?? null;
  const last = st?.last ?? null;
  const running = st ? st.state !== 'idle' : false;
  const pct = run && run.workspaces_total ? Math.min(100, Math.round((100 * run.workspaces_done) / run.workspaces_total)) : null;
  const signedIn = session.data?.signed_in ?? false;
  const kick = (k: SyncKind) => start.mutate(k);

  return (
    <section className="card" aria-labelledby="sync-h">
      <div className="card-head">
        <div className="titles"><h2 id="sync-h">Sync</h2><div className="sub">Reads matter and document details (never document contents) from iManage.</div></div>
      </div>
      <div className="card-body stack-v">
        {sync.isPending ? <Loading /> : sync.isError ? <ErrorState error={sync.error} onRetry={() => void sync.refetch()} /> : (
          <>
            {running && run ? (
              <div className="stack-v" style={{ gap: 8 }} data-testid="sync-progress">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{st!.state === 'cancelling' ? 'Cancelling…' : `${RUN_KIND[run.kind]} in progress`}</strong>
                  <span className="num secondary">{pct !== null ? `${pct}%` : ''}</span>
                </div>
                <div className="progress" role="progressbar" aria-label="Sync progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}
                  aria-valuetext={pct !== null ? `${pct}%, ${run.workspaces_done} of ${run.workspaces_total} workspaces` : 'In progress'}>
                  <span style={{ width: `${pct ?? 5}%` }} />
                </div>
                <span className="small secondary num">
                  {fmtInt(run.workspaces_done)}{run.workspaces_total ? ` of ${fmtInt(run.workspaces_total)}` : ''} workspaces · {fmtInt(run.documents_seen)} documents · started {fmtRelative(run.started_at)}
                </span>
                <div className="row">
                  <button type="button" className="btn" onClick={() => cancel.mutate()} disabled={cancel.isPending || st!.state === 'cancelling'}>Cancel sync</button>
                </div>
              </div>
            ) : (
              <>
                <div className="row">
                  <button type="button" className="btn primary" onClick={() => kick('auto')} disabled={!signedIn || start.isPending}>
                    <Icon name="refresh" size={14} /> Sync now
                  </button>
                  <button type="button" className="btn" onClick={() => kick('full')} disabled={!signedIn || start.isPending}>Full sync</button>
                  <button type="button" className="btn" onClick={() => kick('reconcile')} disabled={!signedIn || start.isPending}>Check access</button>
                </div>
                <ul className="small secondary" style={{ margin: 0, paddingLeft: 18 }}>
                  <li><strong>Sync now</strong> fetches what has changed since the last sync. Usually quick.</li>
                  <li><strong>Full sync</strong> re-reads every workspace. Slow; use if figures look wrong.</li>
                  <li><strong>Check access</strong> removes matters you can no longer see in iManage from this laptop.</li>
                </ul>
                {!signedIn ? <p className="small banner warn" role="note">Sign in to iManage before syncing.</p> : null}
              </>
            )}
            {start.isError ? <p className="banner error" role="alert">{errorMessage(start.error)}</p> : null}
            {cancel.isError ? <p className="banner error" role="alert">{errorMessage(cancel.error)}</p> : null}
            <div>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>Last sync</h3>
              {last ? (
                <dl className="kv" data-testid="last-run">
                  <dt>Result</dt>
                  <dd>{RUN_STATUS[last.status]} · {RUN_KIND[last.kind]}</dd>
                  <dt>Finished</dt><dd>{last.finished_at ? `${fmtDateTime(last.finished_at)} (${fmtRelative(last.finished_at)})` : '—'}</dd>
                  <dt>Workspaces</dt><dd className="num">{fmtInt(last.workspaces_done)}{last.workspaces_total ? ` of ${fmtInt(last.workspaces_total)}` : ''}</dd>
                  <dt>Documents read</dt><dd className="num">{fmtInt(last.documents_seen)}</dd>
                  {last.error ? <><dt>Problem</dt><dd style={{ color: 'var(--danger-ink)' }}>{last.error}</dd></> : null}
                </dl>
              ) : <p className="secondary">No sync has run yet. Sign in, then select Sync now to run your first sync.</p>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function PreferencesCard() {
  const settings = useSettings();
  return (
    <section className="card" aria-labelledby="prefs-h">
      <div className="card-head"><div className="titles"><h2 id="prefs-h">Data retention and sampling</h2></div></div>
      <div className="card-body">
        {settings.isPending ? <Loading /> : settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : (
          <PreferencesForm initial={settings.data} />
        )}
      </div>
    </section>
  );
}

function PreferencesForm({ initial }: { initial: Settings }) {
  const save = useSaveSettings();
  const [retention, setRetention] = useState(String(initial.retention_days));
  const [sampleSize, setSampleSize] = useState(String(initial.sample_per_fee_earner));
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    const r = Number(retention);
    const n = Number(sampleSize);
    if (!Number.isInteger(r) || r < 1 || r > 365) return setErr('Retention must be a whole number of days between 1 and 365.');
    if (!Number.isInteger(n) || n < 1 || n > 10) return setErr('Sample size must be between 1 and 10 matters per fee earner.');
    setErr(null);
    save.mutate({ retention_days: r, sample_per_fee_earner: n }, { onSuccess: () => setSaved(true) });
  }

  return (
          <form onSubmit={onSubmit} className="stack-v" noValidate>
            <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              <div className="field" style={{ width: 200 }}>
                <label htmlFor="ret">Keep data for (days)</label>
                <input id="ret" className="input" type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} aria-describedby="ret-help" />
              </div>
              <div className="field" style={{ width: 220 }}>
                <label htmlFor="ss">Lexcel sample per fee earner</label>
                <input id="ss" className="input" type="number" min={1} max={10} value={sampleSize} onChange={(e) => setSampleSize(e.target.value)} />
              </div>
            </div>
            <p id="ret-help" className="small muted">Matters not refreshed by a sync within this many days are deleted from this laptop.</p>
            {err ? <p className="banner error small" role="alert">{err}</p> : null}
            {save.isError ? <p className="banner error small" role="alert">{errorMessage(save.error)}</p> : null}
            <div className="row">
              <button type="submit" className="btn primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
              <span role="status" className="small" style={{ color: 'var(--success-ink)' }}>{saved ? 'Saved.' : ''}</span>
            </div>
            <dl className="kv small">
              <dt>Controls file</dt><dd className="mono">{initial.controls_file}</dd>
              <dt>Controls loaded</dt><dd>{fmtDateTime(initial.controls_loaded_at)}</dd>
            </dl>
          </form>
  );
}

function WipeCard() {
  const wipe = useWipe();
  const sync = useSyncStatus();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState(false);
  const running = sync.data ? sync.data.state !== 'idle' : false;

  function openDialog() {
    setTyped('');
    wipe.reset();
    dialogRef.current?.showModal();
  }
  function confirm() {
    if (typed !== 'WIPE') return;
    wipe.mutate(undefined, {
      onSuccess: () => {
        dialogRef.current?.close();
        setDone(true);
      },
    });
  }

  return (
    <section className="card" aria-labelledby="wipe-h">
      <div className="card-head"><div className="titles"><h2 id="wipe-h">Wipe local data</h2>
        <div className="sub">Deletes every matter, document detail and result stored on this laptop, and the key that protects them. Nothing in iManage is changed.</div></div></div>
      <div className="card-body stack-v">
        {done ? <p className="banner info" role="status">Local data wiped. Run a sync to start again.</p> : null}
        <div className="row">
          <button type="button" className="btn danger" onClick={openDialog} disabled={running}>Wipe local data…</button>
          {running ? <span className="small muted">Cancel the running sync first.</span> : null}
        </div>
      </div>
      <dialog ref={dialogRef} className="modal" aria-labelledby="wipe-dlg-h" onClose={() => setTyped('')}>
        <form method="dialog" className="modal-body" onSubmit={(e) => { e.preventDefault(); confirm(); }}>
          <h2 id="wipe-dlg-h" style={{ fontSize: 17 }}>Wipe all local data?</h2>
          <p className="secondary">This permanently deletes the analytics data on this laptop. It cannot be undone. Your iManage documents are not affected; you can sync again afterwards.</p>
          <div className="field">
            <label htmlFor="wipe-confirm">Type WIPE to confirm</label>
            <input id="wipe-confirm" className="input code" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          {wipe.isError ? <p className="banner error small" role="alert">{errorMessage(wipe.error)}</p> : null}
        </form>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button type="button" className="btn danger-solid" disabled={typed !== 'WIPE' || wipe.isPending} onClick={confirm}>
            {wipe.isPending ? 'Wiping…' : 'Wipe data'}
          </button>
        </div>
      </dialog>
    </section>
  );
}

function AboutCard() {
  return (
    <section className="card about" aria-labelledby="about-h">
      <div className="card-head"><div className="titles"><h2 id="about-h">About this app</h2></div></div>
      <div className="card-body small">
        <ul>
          <li><strong>Read-only.</strong> It never creates, edits, moves or deletes anything in iManage.</li>
          <li><strong>Metadata only.</strong> It reads matter and document details such as names, types, authors and dates. It does not open or read the contents of documents.</li>
          <li><strong>Your access only.</strong> It signs in as you and sees exactly what you can see, including ethical walls.</li>
          <li><strong>Stored on this laptop.</strong> Data is kept in an encrypted file in your Windows profile and is deleted after the retention period or when you wipe it.</li>
          <li><strong>No cloud.</strong> Nothing is sent to any cloud service, analytics or AI provider. The only outside connection is to iManage and the firm's sign-in service.</li>
          <li><strong>Evidence, not proof.</strong> A result shows whether evidence is filed in iManage, not whether a step actually happened.</li>
        </ul>
      </div>
    </section>
  );
}
