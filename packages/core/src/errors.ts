/**
 * PostgreSQL echoes statement fragments in its error text (e.g. `syntax error at or near "'...'"`).
 * For ALTER ROLE ... PASSWORD that fragment is a credential, so every quoted literal is masked before
 * an error is logged or handed to CloudFormation. Identifiers ("double quoted") are kept: they are
 * what makes the message useful.
 */
const QUOTED_LITERAL = /[Ee]?'(?:[^'\\]|''|\\.)*'?/g;

export function scrubLiterals(text: string): string {
  return text.replace(QUOTED_LITERAL, "'***'");
}

export interface ErrorDescription {
  name: string;
  message: string;
  code?: string;
  constraint?: string;
}

function readString(value: object, key: string): string | undefined {
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Safe-to-log view of any thrown value. `detail`, `where` and the failing statement are deliberately
 * dropped: they carry row values and statement text.
 */
export function describeError(error: unknown): ErrorDescription {
  if (error instanceof Error) {
    const code = readString(error, 'code');
    const constraint = readString(error, 'constraint');
    const description: ErrorDescription = {
      name: error.name,
      message: scrubLiterals(error.message),
    };
    if (code !== undefined) description.code = code;
    if (constraint !== undefined) description.constraint = constraint;
    return description;
  }
  return { name: 'NonError', message: scrubLiterals(String(error)) };
}

export function sqlState(error: unknown): string | undefined {
  return error instanceof Error ? readString(error, 'code') : undefined;
}

export const SqlState = {
  insufficientPrivilege: '42501',
  restrictViolation: '23001',
  checkViolation: '23514',
  uniqueViolation: '23505',
  invalidPassword: '28P01',
  invalidAuthorization: '28000',
} as const;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}
