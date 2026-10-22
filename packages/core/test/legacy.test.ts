import { marshall } from '@aws-sdk/util-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_EVENT_ID_NAMESPACE,
  mapLegacyItem,
  parseExportLine,
  parseIsoInstant,
  uuidV5,
  type LegacyItem,
} from '../src/index.js';

const base: LegacyItem = {
  PK: 'TENANT#t-042#ENTITY#invoice',
  SK: 'DATE#2024-03-01T10:15:30.123Z#CHANGE#1709288130',
  EventId: '6F9619FF-8B86-4D11-B42D-00C04FC964FF',
  TenantId: 't-042',
  ProjectId: 'p-9',
  Scope: 'billing',
  EntityType: 'invoice',
  EntityId: 'inv-1001',
  EntityLabel: 'Invoice inv-1001',
  Action: 'void',
  ActorId: 'u-17',
  ActorEmail: 'user17@t-042.example.test',
  OccurredAt: '2024-03-01T10:15:30.123Z',
  Changes: '[{"field":"status","old":"open","new":"void"}]',
  Comment: 'customer request',
  ExpiresAt: 1772360130,
};

const reject = (item: LegacyItem) => {
  const result = mapLegacyItem(item);
  if (result.ok) throw new Error('expected a reject');
  return result.reason;
};

describe('mapLegacyItem', () => {
  it('maps a well-formed item', () => {
    const result = mapLegacyItem(base);
    expect(result).toEqual({
      ok: true,
      derivedEventId: false,
      event: {
        eventId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
        tenantId: 't-042',
        projectId: 'p-9',
        scope: 'billing',
        entityType: 'invoice',
        entityId: 'inv-1001',
        entityLabel: 'Invoice inv-1001',
        action: 'void',
        actorId: 'u-17',
        actorEmail: 'user17@t-042.example.test',
        occurredAt: '2024-03-01T10:15:30.123Z',
        changes: [{ field: 'status', old: 'open', new: 'void' }],
        comment: 'customer request',
      },
    });
  });

  it.each(['BILLING', 'Billing', ' billing '])('case-folds scope %j', (scope) => {
    const result = mapLegacyItem({ ...base, Scope: scope });
    expect(result.ok && result.event.scope).toBe('billing');
  });

  it('normalises offsets to UTC', () => {
    const result = mapLegacyItem({ ...base, OccurredAt: '2024-03-01T12:15:30+02:00' });
    expect(result.ok && result.event.occurredAt).toBe('2024-03-01T10:15:30.000Z');
  });

  it('treats missing Changes as no changes and missing ProjectId/Comment as null', () => {
    const { Changes: _c, ProjectId: _p, Comment: _m, ...rest } = base;
    const result = mapLegacyItem(rest);
    expect(result.ok && result.event).toMatchObject({
      changes: [],
      projectId: null,
      comment: null,
    });
  });

  describe('derives a deterministic UUIDv5 when EventId is missing', () => {
    const { EventId: _omit, ...withoutId } = base;

    it('is stable across runs and derived from PK+SK', () => {
      const a = mapLegacyItem(withoutId);
      const b = mapLegacyItem({ ...withoutId });
      expect(a.ok && a.derivedEventId).toBe(true);
      expect(a.ok && a.event.eventId).toBe(b.ok && b.event.eventId);
      expect(a.ok && a.event.eventId).toBe(
        uuidV5(JSON.stringify([base.PK, base.SK]), LEGACY_EVENT_ID_NAMESPACE),
      );
    });

    it('differs when the sort key differs', () => {
      const a = mapLegacyItem(withoutId);
      const b = mapLegacyItem({ ...withoutId, SK: `${base.SK}x` });
      expect(a.ok && a.event.eventId).not.toBe(b.ok && b.event.eventId);
    });
  });

  describe('rejects, never coerces', () => {
    it.each(['finance', '', 'billing!', 'SCOPE#billing'])('invalid_scope for %j', (scope) => {
      expect(reject({ ...base, Scope: scope })).toBe('invalid_scope');
    });

    it('invalid_scope when Scope is absent', () => {
      const { Scope: _s, ...rest } = base;
      expect(reject(rest as LegacyItem)).toBe('invalid_scope');
    });

    it.each([
      '2024-02-30T10:00:00Z',
      '2023-02-29T10:00:00Z',
      '2024-13-01T10:00:00Z',
      '2024-03-01T24:00:00Z',
      '2024-03-01T10:15:30',
      '03/01/2024 10:15',
      '1709288130',
      'yesterday',
    ])('invalid_date for %j', (occurredAt) => {
      expect(reject({ ...base, OccurredAt: occurredAt })).toBe('invalid_date');
    });

    it.each([
      '{"field":"status"}',
      'status: open -> void',
      '[{"old":"open"}]',
      '[1,2]',
      '[{"field":""}]',
      'null',
    ])('invalid_changes for %j', (changes) => {
      expect(reject({ ...base, Changes: changes })).toBe('invalid_changes');
    });

    it('invalid_changes when Changes is not a string', () => {
      expect(reject({ ...base, Changes: [] as unknown as string })).toBe('invalid_changes');
    });

    it.each([
      'evt-123',
      '',
      '6f9619ff8b864d11b42d00c04fc964ff',
      '6f9619ff-8b86-4d11-b42d-00c04fc964f',
    ])('invalid_event_id for %j', (eventId) => {
      expect(reject({ ...base, EventId: eventId })).toBe('invalid_event_id');
    });

    it.each([
      'TenantId',
      'EntityType',
      'EntityId',
      'EntityLabel',
      'Action',
      'ActorId',
      'ActorEmail',
    ] as const)('missing_field when %s is absent', (field) => {
      const { [field]: _omit, ...item } = base;
      expect(reject(item as LegacyItem)).toBe('missing_field');
    });
  });
});

describe('parseIsoInstant', () => {
  it('accepts leap days and microseconds', () => {
    expect(parseIsoInstant('2024-02-29T23:59:59.123456Z')?.toISOString()).toBe(
      '2024-02-29T23:59:59.123Z',
    );
  });
});

describe('parseExportLine', () => {
  it('unmarshalls a DynamoDB JSON export line', () => {
    const line = JSON.stringify({ Item: marshall(base) });
    expect(parseExportLine(line)).toEqual(base);
  });

  it('skips blank lines', () => {
    expect(parseExportLine('  ')).toBeUndefined();
  });

  it('throws on a line that is not an export record', () => {
    expect(() => parseExportLine('{"PK":"x"}')).toThrow(/Item/);
    expect(() => parseExportLine('{"Item":{"PK":{"N":"1"}}}')).toThrow(/PK/);
    expect(() => parseExportLine('not json')).toThrow();
  });
});
