import { hasGhostWorkspaceWebPrerequisites, isGhostWorkspaceWebOrigin } from '@cindy/plugin-protocol';
import type { InstalledGhost } from './ghost';

export const LOCAL_PROJECT_DRAFT_SIDEBAR_PREFIX = '__new_maker_project_draft__:local:';

export const GHOST_WORKSPACE_WEB_PARTITION = 'cindy-workspace-web:';

export interface GhostWorkspaceWebPage {
  workspaceId: string | null;
  url: string;
}

export function approvedGhostWorkspaceWebOrigin(ghost: InstalledGhost | null | undefined): string | null {
  if (!ghost?.enabled || ghost.approval?.state !== 'approved') return null;
  const origin = ghost.manifest.mainView?.workspaceWeb;
  return isGhostWorkspaceWebOrigin(origin) && hasGhostWorkspaceWebPrerequisites(ghost.manifest) ? origin : null;
}

export function isGhostWorkspaceWebUrl(origin: string, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function resolveGhostWorkspaceWebPage(origin: string, value: unknown): GhostWorkspaceWebPage | null {
  if (!value || typeof value !== 'object') return null;
  const { workspaceId, path } = value as { workspaceId?: unknown; path?: unknown };
  if (workspaceId !== null && (typeof workspaceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(workspaceId))) return null;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  const url = origin + path;
  if (!isGhostWorkspaceWebUrl(origin, url)) return null;
  return { workspaceId, url };
}
