# Versioned migrations

Add future PostgreSQL upgrade scripts here using this name format:

```text
0002_short_description.sql
0003_another_change.sql
```

Rules:

- Never edit a migration after it has been applied on a server.
- Keep scripts idempotent when practical, for example `ADD COLUMN IF NOT EXISTS`.
- Update `db/schema.sql` as the fresh-install schema, and add a versioned migration for existing servers.
