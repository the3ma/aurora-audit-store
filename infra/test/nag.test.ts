import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { DEV, PROD, synth } from './support/synth';

const NAG = Match.stringLikeRegexp('(AwsSolutions|CdkNagValidationFailure)-?.*');

describe('cdk-nag AwsSolutions', () => {
  test.each([
    ['dev (no authorizer)', DEV],
    ['prod (JWT, DR copy, reader)', PROD],
    ['dev + legacy table + NAT', { ...DEV, createLegacyTable: 'true', natGateways: '1' }],
  ])('%s: zero unsuppressed errors and warnings', (_name, context) => {
    const { built, annotations } = synth(context);
    expect(annotations.findError('*', NAG)).toEqual([]);
    expect(annotations.findWarning('*', NAG)).toEqual([]);
    if (built.drStack) {
      const dr = Annotations.fromStack(built.drStack);
      expect(dr.findError('*', NAG)).toEqual([]);
      expect(dr.findWarning('*', NAG)).toEqual([]);
    }
  });

  test('the open-API suppression only exists when no JWT issuer is configured', () => {
    const open = JSON.stringify(synth(DEV).json);
    const closed = JSON.stringify(synth(PROD).json);
    expect(open).toContain('No jwtIssuer configured');
    expect(closed).not.toContain('No jwtIssuer configured');
  });

  test('deletion-protection suppression is dev-only', () => {
    expect(JSON.stringify(synth(DEV).json)).toContain('AwsSolutions-RDS10');
    expect(JSON.stringify(synth(PROD).json)).not.toContain('AwsSolutions-RDS10');
  });
});
