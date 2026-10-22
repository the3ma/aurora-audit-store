/**
 * Static gate over migration SQL: an append-only store must never ship a destructive statement.
 * Comments and quoted literals are blanked first (so `-- never DROP TABLE` or RAISE messages do not
 * trip it); dollar-quoted function bodies are kept, because statements inside them do execute.
 */
export interface Violation {
  readonly rule: string;
  readonly statement: string;
}

const RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['DROP TABLE', /^\s*DROP\s+TABLE\b/i],
  ['DROP TYPE', /^\s*DROP\s+TYPE\b/i],
  ['DROP SCHEMA/DATABASE', /^\s*DROP\s+(SCHEMA|DATABASE)\b/i],
  ['DROP COLUMN', /\bDROP\s+COLUMN\b/i],
  // ALTER TABLE t DROP x - COLUMN is optional in PostgreSQL.
  ['ALTER TABLE ... DROP <column>', /^\s*ALTER\s+TABLE\b[\s\S]*\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|EXPRESSION\b|IDENTITY\b)/i],
  ['ALTER TYPE ... RENAME', /^\s*ALTER\s+TYPE\b[\s\S]*\bRENAME\b/i],
  ['TRUNCATE', /^\s*TRUNCATE\b/i],
  ['DELETE FROM audit_event', /^\s*DELETE\s+FROM\s+(ONLY\s+)?("?public"?\.)?"?audit_event"?(\s|$)/i],
  ['DISABLE TRIGGER', /^\s*ALTER\s+TABLE\b[\s\S]*\bDISABLE\s+TRIGGER\b/i],
];

/** Replaces comments and single-quoted literals with spaces; keeps $tag$ bodies. */
export function stripCommentsAndLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && n === '*') {
      // PostgreSQL block comments nest.
      let depth = 0;
      do {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      } while (depth > 0 && i < sql.length);
      out += ' ';
    } else if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
    } else {
      out += c ?? '';
      i++;
    }
  }
  return out;
}

/** Splits on `;` - inside dollar-quoted bodies too, so each inner statement is checked on its own. */
export function statements(sql: string): string[] {
  return stripCommentsAndLiterals(sql)
    .split(';')
    .map((s) => s.replace(/\$[A-Za-z_]*\$/g, ' ').replace(/^\s*(BEGIN|DECLARE)\b/i, ' ').trim())
    .filter((s) => s.length > 0);
}

export function destructiveStatements(sql: string): Violation[] {
  const found: Violation[] = [];
  for (const statement of statements(sql)) {
    // A plpgsql body like `... AS $$ BEGIN TRUNCATE x` leaves the inner statement mid-fragment.
    const candidates = [statement, ...statement.split(/\bBEGIN\b|\bTHEN\b|\bELSE\b|\bLOOP\b/i).slice(1)];
    for (const [rule, pattern] of RULES) {
      if (candidates.some((s) => pattern.test(s))) found.push({ rule, statement: statement.replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  return found;
}
