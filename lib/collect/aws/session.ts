import { APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { ConfigServiceClient } from "@aws-sdk/client-config-service";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EKSClient } from "@aws-sdk/client-eks";
import { ElastiCacheClient } from "@aws-sdk/client-elasticache";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { NetworkFirewallClient } from "@aws-sdk/client-network-firewall";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { RDSClient } from "@aws-sdk/client-rds";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { WorkSpacesClient } from "@aws-sdk/client-workspaces";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { MizarConfig } from "@/lib/config";

/**
 * Credentials come only from the SDK default provider chain (env, SSO/profile, ECS/EKS/Lambda task roles,
 * EC2 instance profile); member accounts are reached by assuming `aws.roleName` from there.
 */

/** Throttling across many accounts is expected: retry patiently, with client-side rate limiting. */
const RETRY = { maxAttempts: 10, retryMode: "adaptive" } as const;

export interface Caller {
  accountId: string;
  arn: string;
  /** `aws`, `aws-cn`, `aws-us-gov`, ...: taken from the caller ARN, never assumed. */
  partition: string;
}

/** `undefined` credentials mean "the default provider chain". */
export type Credentials = ReturnType<typeof fromTemporaryCredentials> | undefined;

/**
 * Region for global APIs and the aggregator: configured, else whatever the SDK resolves (AWS_REGION, then the
 * profile's `region` in ~/.aws/config, ...), else us-east-1.
 */
export async function homeRegion(config: MizarConfig["aws"]): Promise<string> {
  if (config.region) return config.region;
  const sts = new STSClient({});
  try {
    return await sts.config.region();
  } catch {
    return "us-east-1";
  } finally {
    sts.destroy();
  }
}

export async function whoAmI(region: string): Promise<Caller> {
  const sts = new STSClient({ region, ...RETRY });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return { accountId: identity.Account!, arn: identity.Arn!, partition: identity.Arn!.split(":")[1] };
  } catch (error) {
    throw new Error(
      `No usable AWS credentials (${(error as Error).message}). Mizar uses the AWS SDK default provider chain: ` +
        "set AWS_PROFILE (and run `aws sso login`), or run where an instance/task role is available.",
    );
  } finally {
    sts.destroy();
  }
}

/** Whether `credentials` work at all: one cheap call, so an unreachable account is reported once, not per API. */
export async function canAuthenticate(credentials: Credentials, region: string): Promise<string | undefined> {
  const sts = new STSClient({ region, credentials, ...RETRY });
  try {
    await sts.send(new GetCallerIdentityCommand({}));
    return undefined;
  } catch (error) {
    return (error as Error).message;
  } finally {
    sts.destroy();
  }
}

export function roleArn(config: MizarConfig["aws"], caller: Caller, accountId: string): string {
  return `arn:${caller.partition}:iam::${accountId}:role${config.rolePath}${config.roleName}`;
}

/** Credentials for reading `accountId`: the caller's own, or the assumed read-only role (refreshed automatically). */
export function credentialsFor(config: MizarConfig["aws"], caller: Caller, accountId: string, region: string): Credentials {
  if (accountId === caller.accountId && !config.assumeRoleInCallerAccount) return undefined;
  return assumeRole(roleArn(config, caller, accountId), config.externalId, region);
}

function assumeRole(arn: string, externalId: string | undefined, region: string): Credentials {
  return fromTemporaryCredentials({
    params: { RoleArn: arn, RoleSessionName: "mizar-collector", DurationSeconds: 3600, ...(externalId ? { ExternalId: externalId } : {}) },
    clientConfig: { region, ...RETRY },
  });
}

export function costRoleArn(config: MizarConfig["aws"], caller: Caller, accountId: string): string {
  return `arn:${caller.partition}:iam::${accountId}:role${config.cost.rolePath}${config.cost.roleName}`;
}

/** Cost Explorer from the caller's own account needs no role; any other account through `aws.cost.roleName`. */
export function costCredentials(config: MizarConfig["aws"], caller: Caller, accountId: string, region: string): Credentials {
  return accountId === caller.accountId ? undefined : assumeRole(costRoleArn(config, caller, accountId), config.externalId, region);
}

export interface RegionClients {
  ec2: EC2Client;
  elb: ElasticLoadBalancingV2Client;
  ecs: ECSClient;
  eks: EKSClient;
  lambda: LambdaClient;
  rds: RDSClient;
  dynamodb: DynamoDBClient;
  sqs: SQSClient;
  cloudwatch: CloudWatchClient;
  elasticache: ElastiCacheClient;
  apigateway: APIGatewayClient;
  apigatewayv2: ApiGatewayV2Client;
  networkFirewall: NetworkFirewallClient;
  workspaces: WorkSpacesClient;
}

export function regionClients(region: string, credentials: Credentials): RegionClients {
  const options = { region, credentials, ...RETRY };
  return {
    ec2: new EC2Client(options),
    elb: new ElasticLoadBalancingV2Client(options),
    ecs: new ECSClient(options),
    eks: new EKSClient(options),
    lambda: new LambdaClient(options),
    rds: new RDSClient(options),
    dynamodb: new DynamoDBClient(options),
    sqs: new SQSClient(options),
    cloudwatch: new CloudWatchClient(options),
    elasticache: new ElastiCacheClient(options),
    apigateway: new APIGatewayClient(options),
    apigatewayv2: new ApiGatewayV2Client(options),
    networkFirewall: new NetworkFirewallClient(options),
    workspaces: new WorkSpacesClient(options),
  };
}

export function destroyClients(clients: object): void {
  for (const client of Object.values(clients)) (client as { destroy(): void }).destroy();
}

export const ec2Client = (region: string, credentials: Credentials) => new EC2Client({ region, credentials, ...RETRY });
export const s3Client = (region: string, credentials: Credentials) => new S3Client({ region, credentials, ...RETRY });
/** CloudFront is global; its API lives in one region per partition (none in GovCloud). */
export function cloudFrontRegion(partition: string): string | undefined {
  return partition === "aws" ? "us-east-1" : partition === "aws-cn" ? "cn-northwest-1" : undefined;
}
export const cloudFrontClient = (region: string, credentials: Credentials) => new CloudFrontClient({ region, credentials, ...RETRY });
/** Cost Explorer is global too; one region per partition (none in GovCloud, billed through a commercial account). */
export function costExplorerRegion(partition: string): string | undefined {
  return partition === "aws" ? "us-east-1" : partition === "aws-cn" ? "cn-northwest-1" : undefined;
}
export const costExplorerClient = (region: string, credentials: Credentials) => new CostExplorerClient({ region, credentials, ...RETRY });
export const iamClient = (region: string, credentials: Credentials) => new IAMClient({ region, credentials, ...RETRY });
export const configClient = (region: string) => new ConfigServiceClient({ region, ...RETRY });
export const organizationsClient = (region: string) => new OrganizationsClient({ region, ...RETRY });
