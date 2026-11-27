import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import {
  GHOST_WORKSPACE_WEB_PARTITION,
  type GhostWorkspaceWebPage,
} from '../../shared/ghostWorkspaceWeb';

interface Props {
  instanceId: string;
  sessionId: string | null;
  /** A stable directory key lets sessions in the same local directory reuse the resolution. */
  directoryKey?: string;
  mode: 'main' | 'sidebar';
  visible?: boolean;
}

function WorkspaceGuest({ instanceId, url }: { instanceId: string; url: string }) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const guest = document.createElement('webview');
    const onLoadFailure = (event: Event) => {
      const failure = event as Electron.DidFailLoadEvent;
      if (failure.isMainFrame && failure.errorCode !== -3) setFailed(true);
    };
    const onGone = () => setFailed(true);
    guest.setAttribute('partition', GHOST_WORKSPACE_WEB_PARTITION + instanceId);
    guest.setAttribute('src', url);
    guest.className = 'h-full w-full';
    guest.addEventListener('did-fail-load', onLoadFailure);
    guest.addEventListener('render-process-gone', onGone);
    host.append(guest);
    return () => guest.remove();
  }, [attempt, instanceId, url]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={container} className={failed ? 'hidden' : 'h-full w-full'} />
      {failed && (
        <div className="p-4">
          <ErrorNotice message={t('workspaceWeb.unavailable')} actions={
            <Button variant="secondary" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>
              {t('workspaceWeb.retry')}
            </Button>
          } />
        </div>
      )}
    </div>
  );
}

export function GhostWorkspaceWebBody({ instanceId, sessionId, directoryKey, mode, visible = true }: Props) {
  const { t } = useTranslation();
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, GhostWorkspaceWebPage | null>>(() => new Map());
  const [guests, setGuests] = useState<ReadonlyMap<string, GhostWorkspaceWebPage>>(() => new Map());
  const key = JSON.stringify([instanceId, sessionId === null ? null : directoryKey || sessionId]);
  const resolved = resolutions.get(key);
  const retry = () => setResolutions(previous => {
    const next = new Map(previous);
    next.delete(key);
    return next;
  });
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    let live = true;
    if (!visible || resolved !== undefined || (mode === 'sidebar' && sessionIdRef.current === null)) return;
    const updateResolution = (page: GhostWorkspaceWebPage | null) => {
      if (live) setResolutions(previous => new Map(previous).set(key, page));
    };
    const resolver = window.electronAPI?.ghosts?.resolveWorkspaceWeb;
    void Promise.resolve(resolver?.(instanceId, sessionIdRef.current)).then(
      page => {
        if (!live) return;
        updateResolution(page ?? null);
        if (!page || (mode === 'sidebar' && page.workspaceId === null)) return;
        const guestKey = page.workspaceId ?? page.url;
        setGuests(previous => {
          if (previous.has(guestKey)) return previous;
          const next = new Map(previous);
          next.set(guestKey, page);
          return next;
        });
      },
      () => updateResolution(null),
    );
    return () => { live = false; };
  }, [instanceId, key, mode, resolved, visible]);

  const unavailable = mode === 'sidebar' && (sessionId === null || resolved?.workspaceId === null);
  const active = !unavailable && resolved ? resolved.workspaceId ?? resolved.url : null;
  return (
    <div className="relative h-full min-h-0 w-full flex-1 overflow-hidden">
      {[...guests].map(([guestKey, page]) => (
        <div key={guestKey} hidden={guestKey !== active} className="absolute inset-0">
          <WorkspaceGuest instanceId={instanceId} url={page.url} />
        </div>
      ))}
      {unavailable ? (
        <div className="p-4">
          <ErrorNotice message={t('workspaceWeb.noWorkspace')} actions={sessionId !== null &&
            <Button variant="secondary" onClick={retry}>{t('workspaceWeb.retry')}</Button>
          } />
        </div>
      ) : resolved === undefined ? (
        <div className="flex h-full items-center justify-center"><Spinner /></div>
      ) : !resolved ? (
        <div className="p-4">
          <ErrorNotice message={t('workspaceWeb.unavailable')} actions={
            <Button variant="secondary" onClick={retry}>{t('workspaceWeb.retry')}</Button>
          } />
        </div>
      ) : null}
    </div>
  );
}
