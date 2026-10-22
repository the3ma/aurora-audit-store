import { App } from 'aws-cdk-lib';
import { Annotations, Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp, type BuiltApp } from '../../lib/build-app';

export const cdkJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'cdk.json'), 'utf8')) as { context: Record<string, unknown> };

export interface Synth {
  readonly built: BuiltApp;
  readonly template: Template;
  readonly json: CfnTemplate;
  readonly annotations: Annotations;
}

export interface CfnResourceJson {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
  readonly DependsOn?: string | string[];
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly Condition?: string;
}

export interface CfnTemplate {
  readonly Resources: Record<string, CfnResourceJson>;
  readonly [section: string]: unknown;
}

const cache = new Map<string, Synth>();

/** Synthesizes the app exactly like `npm run synth` (cdk.json feature flags + skipBundling). */
export function synth(context: Record<string, string> = {}): Synth {
  const key = JSON.stringify(context);
  const hit = cache.get(key);
  if (hit) return hit;
  const app = new App({ context: { ...cdkJson.context, skipBundling: 'true', ...context } });
  const built = buildApp(app);
  const template = Template.fromStack(built.stack);
  const result: Synth = {
    built,
    template,
    json: template.toJSON() as CfnTemplate,
    annotations: Annotations.fromStack(built.stack),
  };
  cache.set(key, result);
  return result;
}

export function resourcesOfType(t: CfnTemplate, type: string): Array<[string, CfnResourceJson]> {
  return Object.entries(t.Resources).filter(([, r]) => r.Type === type);
}

export function dependsOn(r: CfnResourceJson): string[] {
  if (r.DependsOn === undefined) return [];
  return Array.isArray(r.DependsOn) ? r.DependsOn : [r.DependsOn];
}

export const DEV = { stage: 'dev' };
export const PROD = { stage: 'prod', drRegion: 'eu-west-1', jwtIssuer: 'https://auth.example.test/', jwtAudience: 'audit-api', corsOrigins: 'https://app.example.test', alarmEmail: 'oncall@example.test' };
