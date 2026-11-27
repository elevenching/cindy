# Buildr for Cindy Dev

This desktop development plugin opens the official local Buildr Dev web app in Cindy's full-width page and workspace-aware right sidebar. The draft package targets the local Buildr Dev origin `http://127.0.0.1:4458` and requires a Cindy desktop build with `mainView.workspaceWeb`. If your Buildr installation uses a different port, set the exact origin in `ghost.json` before packaging. Start Buildr Dev before opening the panel.

The workspace registry supplies the initial route for the conversation. A conversation's worktree and its primary checkout share an instance when they belong to the same registered workspace. Changing the active workspace or page inside Buildr preserves that navigation when you return to the conversation.

The icon is from the installed Buildr Dev application's own resources. This is a local development package, with no release-version support claim.
