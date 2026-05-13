# tars-admin

Web admin for TARS-based AI agent bots. Current scope: SQLite chat audit + delete.

## Setup

```bash
cp .env.sample .env       # adjust if needed
npm install
npm run dev:start
```

Open http://localhost:3000.

## Docker

```bash
cp .env.sample .env
docker compose up
```

## Environment

| Var       | Default        | Notes                                       |
| --------- | -------------- | ------------------------------------------- |
| `PORT`    | `3000`         |                                             |
| `DB_PATH` | `pyclaudir.db` | Relative (to project root) or absolute path |
