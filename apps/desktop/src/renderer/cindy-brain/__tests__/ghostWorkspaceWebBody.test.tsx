// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GhostWorkspaceWebBody } from '../GhostWorkspaceWebBody';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Unit: a retained tab may outlive the local server. Reopening it must check the
// service while keeping the existing guest if the workspace is still the same.
it('checks the service only when the workspace tab is shown and rechecks on reopening', async () => {
  const resolveWorkspaceWeb = vi.fn(async () => ({
    workspaceId: 'workspace-1', url: 'http://127.0.0.1:4458/workspaces/workspace-1',
  }));
  vi.stubGlobal('electronAPI', { ghosts: { resolveWorkspaceWeb } });
  const props = { instanceId: 'buildr-workspace', sessionId: 'session-1', mode: 'sidebar' as const };
  const view = render(<GhostWorkspaceWebBody {...props} visible={false} />);
  expect(resolveWorkspaceWeb).not.toHaveBeenCalled();

  view.rerender(<GhostWorkspaceWebBody {...props} />);
  await waitFor(() => expect(view.container.querySelector('webview')).toBeTruthy());
  const guest = view.container.querySelector('webview');
  expect(resolveWorkspaceWeb).toHaveBeenCalledExactlyOnceWith('buildr-workspace', 'session-1');

  view.rerender(<GhostWorkspaceWebBody {...props} visible={false} />);
  expect(resolveWorkspaceWeb).toHaveBeenCalledTimes(1);
  view.rerender(<GhostWorkspaceWebBody {...props} />);
  await waitFor(() => expect(resolveWorkspaceWeb).toHaveBeenCalledTimes(2));
  expect(view.container.querySelector('webview')).toBe(guest);
});
