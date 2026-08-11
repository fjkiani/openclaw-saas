"""
Drizzle schema <-> raw SQL migration drift checker.

Why this exists: this repo hand-writes raw SQL migrations (0001..0008) while
`drizzle-kit push` reads the TypeScript schema. If the two disagree, the app
type-checks and the migration applies, and then production fails at query time
with `column ... does not exist`. There is no Node toolchain in this sandbox to
run `drizzle-kit generate`, so the migration was hand-written; this script is
the substitute for that safety net.

It does two independent things:
  1. Parses the SQL with pglast (the real PostgreSQL 17 grammar) so a syntax
     error cannot reach the database.
  2. Extracts (table -> {column: (sql_type, not_null, has_default)}) from BOTH
     the TS schema and the SQL, and diffs them.

Exit code is nonzero on any drift.
"""

from __future__ import annotations

import re
import sys
from typing import Dict, Tuple

import pglast
from pglast import ast as pgast

# Drizzle pg-core builder -> the postgres type the raw SQL must declare.
TS_TO_SQL = {
    "serial": "serial",
    "text": "text",
    "integer": "int4",
    "boolean": "bool",
    "jsonb": "jsonb",
    "real": "float4",
    "timestamp": "timestamptz",  # every timestamp here is { withTimezone: true }
}

# pglast type names -> the same normalized space.
SQL_TYPE_NORM = {
    "serial": "serial",
    "text": "text",
    "int4": "int4",
    "integer": "int4",
    "bool": "bool",
    "boolean": "bool",
    "jsonb": "jsonb",
    "float4": "float4",
    "real": "float4",
    "timestamptz": "timestamptz",
}

Column = Tuple[str, bool, bool]  # (type, not_null, has_default)


def parse_ts_schema(path: str) -> Dict[str, Dict[str, Column]]:
    """Extract pgTable definitions from a Drizzle schema file."""
    src = open(path, encoding="utf-8").read()
    # Strip // line comments so commented-out columns are not counted.
    src = re.sub(r"//[^\n]*", "", src)

    tables: Dict[str, Dict[str, Column]] = {}
    for m in re.finditer(r'pgTable\(\s*"([a-z0-9_]+)"\s*,\s*\{', src):
        table = m.group(1)
        # Walk braces from the opening { of the column object.
        i = m.end() - 1
        depth = 0
        for j in range(i, len(src)):
            if src[j] == "{":
                depth += 1
            elif src[j] == "}":
                depth -= 1
                if depth == 0:
                    body = src[i + 1 : j]
                    break
        else:
            raise ValueError(f"unbalanced pgTable body for {table}")

        cols: Dict[str, Column] = {}
        # e.g.  entityId: integer("entity_id").notNull(),
        # The modifier chain may span several lines
        # (`.notNull()\n.defaultNow()\n.$onUpdate(...)`), so it is collected by
        # scanning to the depth-0 comma rather than to end-of-line — reading only
        # the first line silently loses .notNull() and reports phantom drift.
        for cm in re.finditer(
            r'(\w+)\s*:\s*(\w+)\(\s*"([a-z0-9_]+)"[^,)]*(?:,\s*\{[^}]*\})?\s*\)',
            body,
        ):
            _ts_name, builder, sql_name = cm.groups()
            depth = 0
            end = len(body)
            for k in range(cm.end(), len(body)):
                ch = body[k]
                if ch in "({[":
                    depth += 1
                elif ch in ")}]":
                    depth -= 1
                elif ch == "," and depth == 0:
                    end = k
                    break
            modifiers = body[cm.end() : end]
            if builder not in TS_TO_SQL:
                raise ValueError(f"{table}.{sql_name}: unmapped builder {builder!r}")
            sql_type = TS_TO_SQL[builder]
            is_pk = ".primaryKey()" in modifiers
            not_null = ".notNull()" in modifiers or is_pk
            has_default = (
                ".default(" in modifiers
                or ".defaultNow()" in modifiers
                or builder == "serial"
            )
            cols[sql_name] = (sql_type, not_null, has_default)
        tables[table] = cols
    return tables


def parse_sql_migration(path: str) -> Dict[str, Dict[str, Column]]:
    """Extract CREATE TABLE definitions using the real PostgreSQL parser."""
    sql = open(path, encoding="utf-8").read()
    tree = pglast.parse_sql(sql)  # raises pglast.parser.ParseError on bad syntax

    tables: Dict[str, Dict[str, Column]] = {}
    for raw in tree:
        stmt = raw.stmt
        if not isinstance(stmt, pgast.CreateStmt):
            continue
        table = stmt.relation.relname
        cols: Dict[str, Column] = {}
        for elt in stmt.tableElts or ():
            if not isinstance(elt, pgast.ColumnDef):
                continue
            names = [n.sval for n in elt.typeName.names]
            tname = names[-1]
            norm = SQL_TYPE_NORM.get(tname)
            if norm is None:
                raise ValueError(f"{table}.{elt.colname}: unmapped sql type {tname!r}")
            not_null = False
            has_default = norm == "serial"
            for c in elt.constraints or ():
                # ConstrType is an IntEnum: str() gives "1", not the name.
                # Use .name (CONSTR_NOTNULL / CONSTR_PRIMARY / CONSTR_DEFAULT).
                k = getattr(c.contype, "name", str(c.contype))
                if k == "CONSTR_NOTNULL":
                    not_null = True
                elif k == "CONSTR_PRIMARY":
                    not_null = True
                    has_default = True
                elif k == "CONSTR_DEFAULT":
                    has_default = True
            cols[elt.colname] = (norm, not_null, has_default)
        tables[table] = cols
    return tables


def diff(
    ts: Dict[str, Dict[str, Column]], sql: Dict[str, Dict[str, Column]]
) -> list[str]:
    problems: list[str] = []
    for table, ts_cols in sorted(ts.items()):
        if table not in sql:
            problems.append(f"MISSING TABLE in migration: {table}")
            continue
        sql_cols = sql[table]
        for col, spec in sorted(ts_cols.items()):
            if col not in sql_cols:
                problems.append(f"{table}.{col}: in TS schema, absent from SQL")
                continue
            if sql_cols[col] != spec:
                problems.append(
                    f"{table}.{col}: TS {spec} != SQL {sql_cols[col]}  "
                    f"(type, not_null, has_default)"
                )
        for col in sorted(set(sql_cols) - set(ts_cols)):
            problems.append(f"{table}.{col}: in SQL, absent from TS schema")
    return problems


def main() -> int:
    ts_path, sql_path = sys.argv[1], sys.argv[2]

    try:
        sql_tables = parse_sql_migration(sql_path)
    except Exception as exc:  # noqa: BLE001 - want the raw parser message
        print(f"[FAIL] PostgreSQL parse error in {sql_path}:\n  {exc}")
        return 2
    print(f"[OK]   {sql_path} parses under the PostgreSQL grammar")

    ts_tables = parse_ts_schema(ts_path)
    print(f"[OK]   {ts_path}: {len(ts_tables)} pgTable definitions")

    problems = diff(ts_tables, sql_tables)
    for table in sorted(ts_tables):
        n = len(ts_tables[table])
        mark = "PASS" if not any(p.startswith(table + ".") for p in problems) else "FAIL"
        print(f"  [{mark}] {table:<24} {n} columns")

    if problems:
        print(f"\n[FAIL] {len(problems)} schema drift problem(s):")
        for p in problems:
            print(f"   - {p}")
        return 1

    total = sum(len(c) for c in ts_tables.values())
    print(f"\n[PASS] no drift: {len(ts_tables)} tables / {total} columns identical")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
