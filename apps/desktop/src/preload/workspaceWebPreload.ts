import { ipcRenderer } from 'electron';
import { WORKSPACE_WEB_OPEN_LINK, parseWorkspaceWebLink } from '../shared/ghostWorkspaceWeb';

// This sandboxed preload exposes no APIs to the page. Only the native default
// action of a real link click may be moved from the guest to the browser.
document.addEventListener('click', (event) => {
  if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
  const link = event.composedPath().find((target): target is HTMLAnchorElement =>
    target instanceof HTMLAnchorElement &&
    target.hasAttribute('href') &&
    target.target.toLowerCase() === '_blank' &&
    !target.hasAttribute('download'),
  );
  if (!link) return;
  const url = parseWorkspaceWebLink(link.href);
  if (!url) return;
  event.preventDefault();
  ipcRenderer.send(WORKSPACE_WEB_OPEN_LINK, url);
}, true);
