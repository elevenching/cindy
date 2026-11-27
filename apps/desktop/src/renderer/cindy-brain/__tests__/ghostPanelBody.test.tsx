// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:GhostWebviewBody(右侧栏插件页签 / 插件页面板共用的 webview 内核)
 *   的挂载与卸载;可观察的是真实 renderer logger 转给 main 的日志行(logToMain)——每次
 *   webview 创建、销毁各一条,销毁行带原因类别 unmount / reload / crash。
 * - Bug / 规则依据:makecindy/cindy#8080 SC5——全局页签被重建时 main.log 里要能看出为什么;
 *   日志只含插件实例 id、存活毫秒和原因,不含 URL 查询串(任务页带 session=<id>)与页面内容。
 * - 现有覆盖缺口:面板 webview 的创建 / 销毁此前不写任何日志。
 * - 最小失败输入:挂载带 query 的面板,再换入口 html、触发 render-process-gone、最后卸载。
 * - tier:unit(jsdom,webview 是普通未知元素,只在 electronAPI.logToMain 边界断言)。
 */

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { GhostWebviewBody } from '../ghostPanelBody';
import { GhostWorkspaceWebBody } from '../GhostWorkspaceWebBody';

const ghost = {
  manifest: { schemaVersion: 2, id: 'canvas', name: 'canvas', version: '1.0.0', kind: 'chip', entry: 'main.js' } as GhostManifest,
  dir: '/fake/canvas',
  enabled: true,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
} as InstalledGhost;
const instanceId = installedGhostStoragePart(ghost);

let lines: Array<{ level: string; scope: string; message: string }>;

const webviewLogs = () =>
  lines
    .filter((line) => line.scope === 'GhostWebview')
    .map((line) => ({
      text: line.message.slice(0, line.message.indexOf(' {')),
      fields: JSON.parse(line.message.slice(line.message.indexOf(' {') + 1)) as Record<string, unknown>,
    }));

const body = (html: string) =>
  createElement(GhostWebviewBody, { ghost, html, query: 'session=secret-session-id' });

beforeEach(() => {
  lines = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    logToMain: (level: string, scope: string, message: string) => lines.push({ level, scope, message }),
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('GhostWebviewBody 创建 / 销毁日志', () => {
  it('writes one created and one destroyed line per webview, tagged with the close category', () => {
    const view = render(body('main-view.html'));
    expect(webviewLogs().map((entry) => entry.text)).toEqual(['webview created']);
    expect(webviewLogs()[0]?.fields).toEqual({ instanceId });

    // 入口页面变了 → effect 依赖变化,旧 webview 销毁后新建:reload。
    view.rerender(body('other-view.html'));
    // guest 进程崩溃 → 进入错误接管态,webview 销毁:crash。
    act(() => {
      const webview = view.container.querySelector('webview');
      webview?.dispatchEvent(new Event('render-process-gone'));
    });
    // 错误接管态里没有 webview,卸载不再写销毁行。
    view.unmount();

    const second = render(body('main-view.html'));
    second.unmount();

    const entries = webviewLogs();
    expect(entries.map((entry) => `${entry.text}${entry.fields.reason ? `:${entry.fields.reason}` : ''}`)).toEqual([
      'webview created',
      'webview destroyed:reload',
      'webview created',
      'webview destroyed:crash',
      'webview created',
      'webview destroyed:unmount',
    ]);
    for (const entry of entries) {
      expect(entry.fields.instanceId).toBe(instanceId);
      expect(Object.keys(entry.fields).sort()).toEqual(
        entry.text === 'webview created' ? ['instanceId'] : ['aliveMs', 'instanceId', 'reason'],
      );
      if (entry.text === 'webview destroyed') {
        expect(Number.isInteger(entry.fields.aliveMs) && (entry.fields.aliveMs as number) >= 0).toBe(true);
      }
    }
    // 查询串(任务页带的 session=<id>)与页面入口路径都不进日志。
    const raw = lines.map((line) => line.message).join('\n');
    expect(raw).not.toContain('secret-session-id');
    expect(raw).not.toContain('session=');
    expect(raw).not.toContain('.html');
  });
});

// Unit, workspace-plugin-page: ordinary plugin views test mounting, but do not
// cover restoring a navigated work area after switching conversation scopes.
it('keeps the same guest when returning after navigating within a workspace page', async () => {
  const origin = 'http://127.0.0.1:4458';
  const first = { workspaceId: 'a', url: origin + '/workspaces/a/overview' };
  const second = { workspaceId: 'b', url: origin + '/workspaces/b/overview' };
  const resolveWorkspaceWeb = vi.fn(async (_id: string, session: string | null) =>
    session === 'b' ? second : first);
  vi.stubGlobal('electronAPI', { ghosts: { resolveWorkspaceWeb } });
  const body = (sessionId: string, directoryKey: string) =>
    <GhostWorkspaceWebBody instanceId="buildr" sessionId={sessionId} directoryKey={directoryKey} mode="sidebar" />;
  const { container, rerender } = render(body('a', '/a'));
  const visibleGuest = () => container.querySelector('webview:not([hidden] webview)');
  await waitFor(() => expect(visibleGuest()?.getAttribute('src')).toBe(first.url));
  const navigatedGuest = visibleGuest()!;
  // A webview can navigate inside Buildr independently of the initial URL.
  const manualPath = origin + '/workspaces/c/projects';
  navigatedGuest.setAttribute('src', manualPath);
  rerender(body('a-worktree', '/a-worktree'));
  await waitFor(() => expect(visibleGuest()).toBe(navigatedGuest));
  rerender(body('b', '/b'));
  await waitFor(() => expect(visibleGuest()?.getAttribute('src')).toBe(second.url));
  rerender(body('__new_maker_project_draft__:local:/a', '/a'));
  expect(visibleGuest()).toBe(navigatedGuest);
  rerender(body('a-new-session', '/a'));
  expect(visibleGuest()).toBe(navigatedGuest);
  expect(visibleGuest()?.getAttribute('src')).toBe(manualPath);
  // Revisiting a cached directory checks the service again. That check must
  // not attach a new WebView or reset the page's navigation.
  expect(resolveWorkspaceWeb).toHaveBeenCalledTimes(4);
});

it('loads the installed app home in the full page when no conversation is open', async () => {
  const home = 'http://127.0.0.1:4458/?catalog=1';
  const resolveWorkspaceWeb = vi.fn(async () => ({ workspaceId: null, url: home }));
  vi.stubGlobal('electronAPI', { ghosts: { resolveWorkspaceWeb } });
  const { container } = render(<GhostWorkspaceWebBody instanceId="buildr" sessionId={null} mode="main" />);
  await waitFor(() => expect(container.querySelector('webview')?.getAttribute('src')).toBe(home));
  expect(resolveWorkspaceWeb).toHaveBeenCalledWith('buildr', null);
});
