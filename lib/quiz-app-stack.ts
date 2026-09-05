import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

/**
 * QuizAppStack
 *
 * Fully-serverless, cost-minimized quiz application:
 *  - DynamoDB single-table, PAY_PER_REQUEST (on-demand => no idle cost).
 *  - A single ARM64 (Graviton) Lambda behind an API Gateway v2 HTTP API
 *    (HTTP API is cheaper than REST API). Lambda scales to zero.
 *  - Static SPA hosted in a private S3 bucket fronted by CloudFront with
 *    Origin Access Control (PRICE_CLASS_100 = cheapest edge footprint).
 *  - No VPC and no NAT gateway, so there is no always-on/idle compute cost.
 */
export class QuizAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------
    // (a) DynamoDB single-table (on-demand billing => no idle cost).
    //     Quiz meta:  pk=QUIZ#<quizId>  sk=META
    //     Question:   pk=QUIZ#<quizId>  sk=Q#<n>
    // ---------------------------------------------------------------
    const table = new dynamodb.Table(this, 'QuizTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Demo stack: allow the table to be torn down with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // Point-in-time recovery left off to keep the demo cost minimal.
      pointInTimeRecovery: false,
    });

    // ---------------------------------------------------------------
    // (b) API Lambda: ARM64/Graviton (cheaper), latest Node runtime.
    //     @aws-sdk/* is provided by the Node runtime, so mark it
    //     external so esbuild does not bundle it.
    // ---------------------------------------------------------------
    const apiFunction = new NodejsFunction(this, 'ApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      entry: path.join(__dirname, '..', 'lambda', 'index.ts'),
      handler: 'handler',
      environment: {
        TABLE_NAME: table.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        // aws-sdk v3 ships with the Node runtime; keep it external.
        externalModules: ['@aws-sdk/*'],
      },
    });

    table.grantReadWriteData(apiFunction);

    // ---------------------------------------------------------------
    // (c) HTTP API (API Gateway v2) - cheaper than REST API.
    // ---------------------------------------------------------------
    const integration = new HttpLambdaIntegration('ApiIntegration', apiFunction);

    const httpApi = new apigwv2.HttpApi(this, 'QuizHttpApi', {
      description: 'Serverless quiz HTTP API',
      // CORS: the SPA calls the API same-origin through the CloudFront
      // `/api/*` behavior (see below), so browsers do not normally issue
      // cross-origin preflights. `allowOrigins: ['*']` is kept as a
      // conscious trade-off so the API also stays usable directly (e.g.
      // curl, or a custom domain) for this public, unauthenticated demo
      // that persists no per-user data. Tighten to the CloudFront domain
      // if this ever carries private data. Note: the CloudFront domain is
      // created in this same stack, so referencing it here would introduce
      // a circular dependency; same-origin routing avoids needing it.
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['content-type'],
      },
    });

    // Routes are registered under an `/api` prefix so the SPA can reach
    // them same-origin via the CloudFront `/api/*` cache behavior without
    // any path rewriting at the edge.
    httpApi.addRoutes({
      path: '/api/quizzes',
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });
    httpApi.addRoutes({
      path: '/api/quizzes/{quizId}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });
    httpApi.addRoutes({
      path: '/api/quizzes/{quizId}/submit',
      methods: [apigwv2.HttpMethod.POST],
      integration,
    });

    // ---------------------------------------------------------------
    // (d) Static site: private S3 bucket + CloudFront (OAC).
    // ---------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // The HTTP API origin. `httpApi.apiEndpoint` is
    // `https://<id>.execute-api.<region>.amazonaws.com`; CloudFront needs
    // just the host, so strip the scheme.
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'Quiz app static site',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        // Forward `/api/*` to the HTTP API so the SPA can call the API
        // same-origin (window.API_BASE = '/api'). No caching, and forward
        // the query string / needed headers so GET and POST both work.
        'api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forward everything except the Host header (the origin needs
          // its own execute-api host, not the CloudFront domain).
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      // SPA routing: send 403/404 back to index.html with a 200 so client
      // side routing works. NOTE: CloudFront custom error responses are
      // distribution-wide and cannot be scoped to a single behavior, so a
      // 4xx from the API would also be rewritten to index.html/200. The
      // SPA's fetch helper guards against this by verifying the response is
      // JSON (see frontend/app.js), turning a swallowed HTML body into a
      // clear error instead of a JSON parse crash.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'frontend'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ---------------------------------------------------------------
    // (e) Outputs.
    // ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description:
        'Base URL of the quiz HTTP API (routes are under /api, e.g. /api/quizzes). The SPA reaches these same-origin via CloudFront /api/*.',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront domain serving the quiz SPA',
    });
    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });
  }
}
