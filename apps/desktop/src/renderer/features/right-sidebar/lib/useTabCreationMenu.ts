import { approvedGhostWorkspaceWebOrigin } from '../../../../shared/ghostWorkspaceWeb';
import { useContext, useRef, useState, useSyncExternalStore } from 'react';
import { BuildrNavigationIcon, MAIN_VIEW_ICONS, mainViewIconName } from '@/cindy-brain/mainViewIcons';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';
import { useBotProfiles } from '@/features/bots/botStore';
import { findBotProfileForSession } from '@/features/bots/botSessionOwners';
import { DetachedBotMenuOwnerContext } from '../botMenuOwnerContext';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { isRemoteSessionWriteBlocked } from '@/features/cc-agent/lib/remoteSessionWriteGuard';
import { sessionsStore } from '@/lib/sessionsStore';
import { listTabKindMenuMetas, useTabKindRegistryVersion } from '../registry';
import type { TabKindId, TabKindMenuMeta } from '../types';
import { canOpenSideChat, openSideChatTab, type SideChatTabPlacement } from './openSideChatTab';
import {
  addGlobalPluginTab, globalTabTitleForGhost, isGlobalTabCapableGhost,
  requestRevealSessionTab, setActiveGlobalTabId, useGlobalTabs, type PluginViewTabState,
} from '../globalTabs';
import { setTabGroup, type TabGroupId } from '../tabGroups';
import { addTab, ensureHydrated, getBucket, setActiveTab, subscribe } from '../store';
import { toast } from '@/lib/toast';
import { useTranslation } from 'react-i18next';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

const BOT_SECONDARY_KINDS = new Set<TabKindId>([
  'review',
  'subagents',
  'background-tasks',
  'terminal',
]);

export interface TabCreationSelectionOptions {
  groupId?: TabGroupId;
  onGlobalTabSelected?: (tabId: string, existed: boolean) => void;
}

export interface TabCreationMenu {
  items: Array<TabKindMenuMeta & {
    disabled: boolean; busy: boolean; group?: 'plugins' | 'workspace'; alreadyOpen?: boolean;
  }>;
  select: (kind: TabKindId, options?: TabCreationSelectionOptions) => void;
}

/** Both entry surfaces share the registry, eligibility, pending state and open actions. */
export function useTabCreationMenu({
  sessionId,
  subagentsAvailable,
  workspaceWebAvailable = true,
  reviewAvailable = true,
  onSelect,
  sideChatPlacement,
}: {
  sessionId: string | null | undefined;
  subagentsAvailable: boolean;
  workspaceWebAvailable?: boolean;
  reviewAvailable?: boolean;
  onSelect: (kind: TabKindId) => void;
  sideChatPlacement?: SideChatTabPlacement;
}): TabCreationMenu {
  useTabKindRegistryVersion();
  const { t } = useTranslation();
  const bucket = useSyncExternalStore(subscribe, () => getBucket(sessionId ?? null));
  const installedGhosts = useInstalledGhosts();
  const globalTabs = useGlobalTabs();
  const pluginEntries = installedGhosts.filter(isGlobalTabCapableGhost).map(ghost => {
    const instanceId = installedGhostStoragePart(ghost);
    const workspace = !!approvedGhostWorkspaceWebOrigin(ghost);
    const conversationScoped = workspace && ghost.manifest.id === 'buildr-workspace';
    return {
      kind: `ghost:${instanceId}` as TabKindId,
      instanceId,
      ghost,
      workspace,
      conversationScoped,
      title: globalTabTitleForGhost(ghost),
      icon: conversationScoped
        ? BuildrNavigationIcon : MAIN_VIEW_ICONS[mainViewIconName(ghost.manifest.mainView)],
      open: (conversationScoped ? bucket.tabs : globalTabs).some(tab =>
        tab.kind === 'plugin-view' && (tab.state as PluginViewTabState | null)?.instanceId === instanceId),
    };
  }).sort((a, b) => a.title.localeCompare(b.title) || a.instanceId.localeCompare(b.instanceId));
  const bots = useBotProfiles();
  const bot = sessionId ? findBotProfileForSession(bots, sessionId) : undefined;
  const detachedOwner = useContext(DetachedBotMenuOwnerContext);
  const linkedOwner = detachedOwner?.sessionId === sessionId ? detachedOwner : null;
  const isBotSession = Boolean(bot || linkedOwner);
  const localSession = useSyncExternalStore(
    sessionsStore.subscribe,
    () => sessionId ? sessionsStore.findById(sessionId) : null,
  );
  const remoteSessions = useRemoteProjectSessions();
  const session = remoteSessions.find(row => row.id === sessionId) ?? localSession;
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const items = listTabKindMenuMetas().filter(item => {
    if (item.kind.startsWith('ghost:')) return false;
    if (item.kind === 'subagents' && !subagentsAvailable) return false;
    if (item.kind === 'review' && !reviewAvailable) return false;
    if (item.kind === 'side-chat' && (isBotSession || !canOpenSideChat(session))) return false;
    return !isBotSession || !BOT_SECONDARY_KINDS.has(item.kind);
  }).map(item => {
    const busy = item.kind === 'side-chat' && !!sessionId && openingSessionId === sessionId;
    return {
      ...item,
      busy,
      disabled: !sessionId || !item.enabled || busy
        || (item.kind === 'side-chat' && isRemoteSessionWriteBlocked(session)),
    };
  });

  const select = (kind: TabKindId, options?: TabCreationSelectionOptions) => {
    const plugin = pluginEntries.find(entry => entry.kind === kind);
    if (plugin?.conversationScoped) {
      if (!sessionId || !workspaceWebAvailable) return;
      const owner = getDataOwnerGeneration();
      void (async () => {
        await ensureHydrated(sessionId);
        if (!isDataOwnerGenerationCurrent(owner)) return;
        const existing = getBucket(sessionId).tabs.find(tab =>
          tab.kind === 'plugin-view' && (tab.state as PluginViewTabState | null)?.instanceId === plugin.instanceId);
        const groupId = options?.groupId ?? 'right';
        if (existing) {
          if (!options?.onGlobalTabSelected) setTabGroup(existing.id, groupId);
          options?.onGlobalTabSelected?.(existing.id, true);
          await setActiveTab(sessionId, existing.id);
          requestRevealSessionTab(sessionId, existing.id);
          return;
        }
        await addTab(sessionId, 'plugin-view', { instanceId: plugin.instanceId, view: 'main' }, {
          groupId,
          onOptimisticAdd: tabId => {
            options?.onGlobalTabSelected?.(tabId, false);
            requestRevealSessionTab(sessionId, tabId);
          },
        });
      })().catch(() => toast.error(t('rightSidebar.tabs.addFailed')));
      return;
    }
    if (plugin) {
      const tab = addGlobalPluginTab(plugin.instanceId, {
        ...(options?.groupId && options.groupId !== 'right' ? { groupId: options.groupId } : {}),
        ghost: plugin.ghost,
        ...(plugin.workspace ? { view: 'main' as const } : {}),
      });
      if (tab) {
        options?.onGlobalTabSelected?.(tab.id, plugin.open);
        setActiveGlobalTabId(tab.id);
      }
      return;
    }
    if (!sessionId || !items.some(item => item.kind === kind && !item.disabled)) return;
    if (kind === 'side-chat') {
      if (pending.current === sessionId) return;
      pending.current = sessionId;
      setOpeningSessionId(sessionId);
      const opening = openSideChatTab(sessionId, {
        placement: sideChatPlacement,
      });
      void opening.finally(() => {
        if (pending.current === sessionId) pending.current = null;
        setOpeningSessionId(current => current === sessionId ? null : current);
      });
      return;
    }
    onSelect(kind);
  };

  // Keep unavailable future entries last on both surfaces.
  const pluginItems = pluginEntries.map(entry => ({
      kind: entry.kind, labelKey: 'rightSidebar.tabs.menu.pluginsLabel', labelText: entry.title,
      descriptionKey: 'rightSidebar.tabs.menu.pluginsLabel', icon: entry.icon, order: 0,
      enabled: true, disabled: entry.conversationScoped && (!sessionId || !workspaceWebAvailable), busy: false, group: entry.workspace ? 'workspace' as const : 'plugins' as const, alreadyOpen: entry.open,
  }));
  return { items: [
    ...pluginItems.filter(item => item.group === 'workspace'),
    ...items.filter(item => item.enabled),
    ...pluginItems.filter(item => item.group === 'plugins'),
    ...items.filter(item => !item.enabled),
  ], select };
}
