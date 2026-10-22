import { type Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { join } from 'node:path';
import { REPO_ROOT } from '../migrations';

export const HANDLER_DIR = join(REPO_ROOT, 'packages', 'functions', 'src', 'handlers');
export const RUNTIME = lambda.Runtime.NODEJS_22_X;

export interface AuditFunctionProps {
  readonly prefix: string;
  /** Handler file name without extension, e.g. `migrate` -> packages/functions/src/handlers/migrate.ts. */
  readonly handlerName: string;
  readonly description: string;
  readonly vpc: ec2.IVpc;
  readonly vpcSubnets: ec2.SubnetSelection;
  readonly securityGroup: ec2.ISecurityGroup;
  readonly environment: Record<string, string>;
  readonly timeout: Duration;
  readonly memorySize?: number;
  readonly reservedConcurrentExecutions?: number;
  readonly logRetention: logs.RetentionDays;
  readonly skipBundling: boolean;
  /** Async invocations (EventBridge): retries of a failed run. */
  readonly retryAttempts?: number;
}

/**
 * NodejsFunction for a contract handler. With `skipBundling` (tests, CI synth without the workspace
 * installed) the code is an inline placeholder, but name, handler, runtime and wiring are identical.
 */
export class AuditFunction extends Construct {
  readonly fn: lambda.Function;
  readonly logGroup: logs.LogGroup;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: AuditFunctionProps) {
    super(scope, id);
    const functionName = `${props.prefix}-${props.handlerName}`;

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Own role instead of AWSLambdaBasicExecutionRole / AWSLambdaVPCAccessExecutionRole: logs only to
    // this function's log group.
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `${functionName} execution role`,
    });
    this.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'OwnLogGroup',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [this.logGroup.logGroupArn],
      }),
    );
    this.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'VpcNetworkInterfaces',
        // Lambda manages Hyperplane ENIs with the execution role; these EC2 actions are not
        // resource-scopable in a way Lambda's create-time validation accepts.
        actions: [
          'ec2:CreateNetworkInterface',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DescribeSubnets',
          'ec2:DeleteNetworkInterface',
          'ec2:AssignPrivateIpAddresses',
          'ec2:UnassignPrivateIpAddresses',
        ],
        resources: ['*'],
      }),
    );

    const common: lambda.FunctionOptions = {
      functionName,
      role: this.role,
      description: props.description,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout,
      vpc: props.vpc,
      vpcSubnets: props.vpcSubnets,
      securityGroups: [props.securityGroup],
      environment: { LOG_LEVEL: 'info', NODE_OPTIONS: '--enable-source-maps', ...props.environment },
      logGroup: this.logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      ...(props.reservedConcurrentExecutions !== undefined && { reservedConcurrentExecutions: props.reservedConcurrentExecutions }),
      ...(props.retryAttempts !== undefined && { retryAttempts: props.retryAttempts }),
    };

    if (props.skipBundling) {
      this.fn = new lambda.Function(this, 'Fn', {
        ...common,
        runtime: RUNTIME,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`exports.handler = async () => { throw new Error('placeholder for ${props.handlerName}: synthesized with skipBundling=true'); };`),
      });
    } else {
      this.fn = new nodejs.NodejsFunction(this, 'Fn', {
        ...common,
        runtime: RUNTIME,
        entry: join(HANDLER_DIR, `${props.handlerName}.ts`),
        handler: 'handler',
        projectRoot: REPO_ROOT,
        depsLockFilePath: join(REPO_ROOT, 'package-lock.json'),
        bundling: {
          format: nodejs.OutputFormat.ESM,
          target: 'node22',
          mainFields: ['module', 'main'],
          minify: true,
          sourceMap: true,
          // The workspace packages are ESM; pg still uses require() internally.
          banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
          loader: { '.sql': 'text', '.pem': 'text' },
          // The Node 22 runtime ships AWS SDK v3; pg-native is an optional binding pg never loads here.
          externalModules: ['@aws-sdk/*', 'pg-native'],
        },
      });
    }
  }
}
