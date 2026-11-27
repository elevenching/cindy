import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { browserWebviewPool } from '../lib/browserWebviewPool';
import { isTabHostedHere } from '../lib/tabHosting';
import { getBucket, subscribe } from '../store';
import type { TabState } from '../types';
import type { InstalledGhost } from '../../../../shared/ghost';
import { getWorkspaceWebTabHostId } from '../tabAvailability';

export interface TabBodyHostDescriptor {
  tab: TabState;
  workspaceHostId?: string;
  sessionId: string | null;
  workdir: string;
  remoteHostId: string | null;
  deviceLinkDeviceId?: string | null;
}

function canHostGuest(tab: TabState): boolean {
  return tab.kind === 'web-browser' || tab.kind === 'file-browser';
}

/**
 * Keep the slots of live browser, file preview and workspace webpage guests connected when their task leaves the
 * sidebar. Moving a pooled webview to parking and back recreates its Electron
 * guest, even when the wrapper DOM object itself survives.
 *
 * Browser and file preview guests remain bound to the pool. Workspace webpages
 * share one body per plugin in this window, while each task still owns its tab
 * state. Closing the tab or handing it off releases the hidden body.
 */
export function useRetainedBrowserTabHosts(
  current: readonly TabBodyHostDescriptor[],
  installedGhosts: readonly InstalledGhost[],
): TabBodyHostDescriptor[] {
  const previous = useRef<readonly TabBodyHostDescriptor[]>([]);
  const [, refresh] = useState(0);

  useEffect(() => {
    const onChange = () => refresh((version) => version + 1);
    const unsubscribeStore = subscribe(onChange);
    const unsubscribeRelease = browserWebviewPool.onRelease(onChange);
    const unsubscribeCreated = browserWebviewPool.onEntryCreated(onChange);
    return () => {
      unsubscribeStore();
      unsubscribeRelease();
      unsubscribeCreated();
    };
  }, []);

  const hosts: TabBodyHostDescriptor[] = [];
  const remaining = new Map(current.map((host) => [host.workspaceHostId ?? host.tab.id, host]));
  for (const host of previous.current) {
    const hostId = host.workspaceHostId ?? host.tab.id;
    const foreground = remaining.get(hostId);
    if (foreground) {
      hosts.push(foreground);
      remaining.delete(hostId);
      continue;
    }
    // 页签已不由本 renderer 承载(弹出到别的窗口 / 从多页签窗口合并回去):不再保留它的后台 body。
    if (!host.sessionId || !isTabHostedHere(host.tab.id)) continue;
    if (!host.workspaceHostId && !browserWebviewPool.peek(host.tab.id)) continue;
    // Background navigation/close updates belong to the original task. Never
    // reuse the foreground task's context or revive a tab missing from its bucket.
    const bucket = getBucket(host.sessionId);
    const tab = bucket.hydrated && bucket.tabs.find((candidate) => candidate.id === host.tab.id);
    if (
      tab && (host.workspaceHostId
        ? getWorkspaceWebTabHostId(tab, installedGhosts) === host.workspaceHostId
        : canHostGuest(tab))
    ) hosts.push({ ...host, tab });
  }
  // Stable browser order matters too: React moving an ancestor of a webview
  // within this list disconnects the guest just like reparenting its wrapper.
  hosts.push(...remaining.values());

  useLayoutEffect(() => {
    // Capture current candidates too: their child effects may materialize the
    // guest later in this commit, before the user can switch tasks.
    previous.current = hosts.filter(({ tab, workspaceHostId }) => workspaceHostId || canHostGuest(tab));
  });

  return hosts;
}
