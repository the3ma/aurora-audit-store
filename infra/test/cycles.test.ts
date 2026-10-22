import { Template } from 'aws-cdk-lib/assertions';
import { dependencyGraph, findCycles } from './support/cycles';
import { DEV, PROD, synth, type CfnTemplate } from './support/synth';

// `cdk synth` does not detect cycles that only exist across DependsOn + intrinsic references;
// CloudFormation rejects them at deploy time. Walk the synthesized template ourselves.
describe('CloudFormation dependency cycles', () => {
  test.each([
    ['dev', DEV],
    ['prod', PROD],
    ['dev + legacy table + NAT', { ...DEV, createLegacyTable: 'true', natGateways: '1' }],
  ])('%s template is acyclic', (_name, context) => {
    const { json } = synth(context);
    expect(findCycles(dependencyGraph(json))).toEqual([]);
  });

  test('DR vault stack is acyclic', () => {
    const { built } = synth(PROD);
    if (!built.drStack) throw new Error('expected a DR stack');
    const json = Template.fromStack(built.drStack).toJSON() as CfnTemplate;
    expect(findCycles(dependencyGraph(json))).toEqual([]);
  });
});

describe('cycle detector', () => {
  const t = (resources: CfnTemplate['Resources']): CfnTemplate => ({ Resources: resources });

  test('finds a Ref / GetAtt / Sub / DependsOn cycle', () => {
    const template = t({
      A: { Type: 'X', Properties: { p: { Ref: 'B' } } },
      B: { Type: 'X', Properties: { p: { 'Fn::GetAtt': ['C', 'Arn'] } } },
      C: { Type: 'X', Properties: { p: { 'Fn::Sub': 'arn:${D.Arn}:${AWS::Region}' } } },
      D: { Type: 'X', DependsOn: ['A'] },
      E: { Type: 'X', Properties: { p: { Ref: 'A' } } },
    });
    expect(findCycles(dependencyGraph(template))).toEqual([['A', 'B', 'C', 'D']]);
  });

  test('finds a self-loop and the "Id.Attr" GetAtt form', () => {
    const template = t({ A: { Type: 'X', Properties: { p: { 'Fn::GetAtt': 'A.Arn' } } } });
    expect(findCycles(dependencyGraph(template))).toEqual([['A']]);
  });

  test('ignores parameters, Sub locals and escaped ${!literal}', () => {
    const template = t({
      A: { Type: 'X', Properties: { p: { Ref: 'SomeParameter' }, q: { 'Fn::Sub': ['${B}-${!A}', { B: 'x' }] } } },
      B: { Type: 'X', Properties: { p: { Ref: 'A' } } },
    });
    expect(findCycles(dependencyGraph(template))).toEqual([]);
  });
});
