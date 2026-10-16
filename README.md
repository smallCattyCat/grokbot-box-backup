# grokbot-box-backup

Public backup of selected **Grok Bot box** trees (Tier A + `cmooc/screenshots`).

- Layout: `workspace/` → box `/workspace`, `home-box/reference/` → `/home/box/reference`
- See [RESTORE.md](./RESTORE.md) for install / secrets / what is **not** included
- See [workspace/grokbot-backup-plan.md](./workspace/grokbot-backup-plan.md) for the inventory
- `sync.sh` re-syncs the same scope when `GITHUB_BACKUP_TOKEN` is set

**No API keys, cookies, chat transcripts, or `node_modules` are stored here.**
