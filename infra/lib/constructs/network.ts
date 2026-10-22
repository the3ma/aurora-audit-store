import { Stack, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { VpcConfig } from '../config';

export const DB_PORT = 5432;
export const VPC_CIDR = '10.40.0.0/16';

/** Every principal that is allowed to open a connection to the cluster. */
export const DB_CLIENTS = ['migrate', 'api', 'mv-refresh', 'digest', 'backfill', 'rotation'] as const;
export type DbClient = (typeof DB_CLIENTS)[number];

export interface NetworkProps {
  readonly prefix: string;
  readonly vpc: VpcConfig;
  readonly logRetention: logs.RetentionDays;
}

export class Network extends Construct {
  readonly vpc: ec2.IVpc;
  /** Literal for a created VPC, so rules referencing it stay statically checkable. */
  readonly vpcCidr: string;
  readonly dbSubnets: ec2.SubnetSelection;
  readonly appSubnets: ec2.SubnetSelection;
  readonly clusterSecurityGroup: ec2.SecurityGroup;
  /** SG per DB client, plus one for archive-export which only talks to AWS APIs. */
  readonly clientSecurityGroups: Record<DbClient, ec2.SecurityGroup>;
  readonly archiveExportSecurityGroup: ec2.SecurityGroup;
  /** Resources a DB client needs before its first connection (ingress rules, endpoints). */
  readonly readiness: Construct[] = [];

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);

    let createEndpoints: boolean;
    if (props.vpc.mode === 'import') {
      this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpc.vpcId });
      this.dbSubnets = props.vpc.dbSubnetGroupName
        ? { subnetGroupName: props.vpc.dbSubnetGroupName }
        : { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
      this.appSubnets = props.vpc.appSubnetGroupName
        ? { subnetGroupName: props.vpc.appSubnetGroupName }
        : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
      createEndpoints = props.vpc.createEndpoints;
      this.vpcCidr = this.vpc.vpcCidrBlock;
    } else {
      const withNat = props.vpc.natGateways > 0;
      const subnetConfiguration: ec2.SubnetConfiguration[] = [
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        // Without NAT the app tier is isolated too: it reaches AWS only through the endpoints below.
        { name: 'app', subnetType: withNat ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
      ];
      if (withNat) subnetConfiguration.push({ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26 });

      const flowLogGroup = new logs.LogGroup(this, 'FlowLogs', { retention: props.logRetention });
      const vpc = new ec2.Vpc(this, 'Vpc', {
        vpcName: `${props.prefix}-vpc`,
        ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
        maxAzs: 2,
        natGateways: props.vpc.natGateways,
        subnetConfiguration,
        flowLogs: {
          rejected: { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup), trafficType: ec2.FlowLogTrafficType.REJECT },
        },
      });
      this.vpc = vpc;
      this.vpcCidr = VPC_CIDR;
      this.dbSubnets = { subnetGroupName: 'db' };
      this.appSubnets = { subnetGroupName: 'app' };
      createEndpoints = true;
    }

    this.clusterSecurityGroup = new ec2.SecurityGroup(this, 'ClusterSg', {
      vpc: this.vpc,
      description: `${props.prefix} Aurora cluster - ${DB_PORT} from named client SGs only`,
      allowAllOutbound: false,
      disableInlineRules: true,
    });

    const clients = {} as Record<DbClient, ec2.SecurityGroup>;
    for (const name of DB_CLIENTS) {
      const sg = this.clientSecurityGroup(name, props.prefix);
      // Standalone ingress/egress resources (not inline): two SGs referencing each other inline is a
      // CloudFormation dependency cycle.
      const ingress = new ec2.CfnSecurityGroupIngress(this, `DbIngress-${name}`, {
        groupId: this.clusterSecurityGroup.securityGroupId,
        sourceSecurityGroupId: sg.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: DB_PORT,
        toPort: DB_PORT,
        description: `postgres from ${name}`,
      });
      new ec2.CfnSecurityGroupEgress(this, `DbEgress-${name}`, {
        groupId: sg.securityGroupId,
        destinationSecurityGroupId: this.clusterSecurityGroup.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: DB_PORT,
        toPort: DB_PORT,
        description: 'postgres to the audit cluster',
      });
      this.readiness.push(ingress);
      clients[name] = sg;
    }
    this.clientSecurityGroups = clients;
    this.archiveExportSecurityGroup = this.clientSecurityGroup('archive-export', props.prefix);

    if (createEndpoints) this.addEndpoints(props.prefix);
  }

  private clientSecurityGroup(name: string, prefix: string): ec2.SecurityGroup {
    const sg = new ec2.SecurityGroup(this, `Sg-${name}`, {
      vpc: this.vpc,
      description: `${prefix} ${name}`,
      allowAllOutbound: false,
      disableInlineRules: true,
    });
    // HTTPS egress is only useful towards VPC endpoints (no IGW/NAT by default); what can be reached
    // through them is governed by the endpoint policies, not by this rule. Prefix-list scoping would
    // need an account/region lookup at synth time.
    new ec2.CfnSecurityGroupEgress(this, `HttpsEgress-${name}`, {
      groupId: sg.securityGroupId,
      cidrIp: '0.0.0.0/0',
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      description: 'HTTPS to AWS APIs via VPC endpoints',
    });
    return sg;
  }

  private addEndpoints(prefix: string): void {
    const account = Stack.of(this).account;
    const sameAccount = { StringEquals: { 'aws:ResourceAccount': account } };

    const s3 = this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3, subnets: [this.appSubnets] });
    // Data can only leave through the S3 endpoint into buckets of this account.
    s3.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:GetBucketLocation', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
        resources: ['*'],
        conditions: sameAccount,
      }),
    );
    const ddb = this.vpc.addGatewayEndpoint('DynamoDbEndpoint', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB, subnets: [this.appSubnets] });
    ddb.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: ['dynamodb:DescribeTable', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchGetItem', 'dynamodb:DescribeExport', 'dynamodb:ExportTableToPointInTime'],
        resources: ['*'],
        conditions: sameAccount,
      }),
    );
    this.readiness.push(s3, ddb);

    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      description: `${prefix} interface endpoints - 443 from the VPC`,
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(ec2.Peer.ipv4(this.vpcCidr), ec2.Port.tcp(443), 'HTTPS from the VPC');

    const services: Array<[string, ec2.InterfaceVpcEndpointAwsService]> = [
      ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['Kms', ec2.InterfaceVpcEndpointAwsService.KMS],
      ['Logs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['Monitoring', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING],
      ['Rds', ec2.InterfaceVpcEndpointAwsService.RDS],
      ['Sts', ec2.InterfaceVpcEndpointAwsService.STS],
    ];
    for (const [name, service] of services) {
      const ep = this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        subnets: this.appSubnets,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
        open: false,
      });
      Tags.of(ep).add('Name', `${prefix}-${name.toLowerCase()}`);
      this.readiness.push(ep);
    }
  }
}
