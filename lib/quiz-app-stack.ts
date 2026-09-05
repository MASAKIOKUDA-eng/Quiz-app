import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * QuizAppStack
 *
 * Fully-serverless, cost-minimized quiz application:
 *  - DynamoDB single-table, PAY_PER_REQUEST (on-demand => no idle cost).
 *  - A single ARM64 (Graviton) Lambda behind an API Gateway v2 HTTP API
 *    (HTTP API is cheaper than REST API). Lambda scales to zero.
 *  - No VPC and no NAT gateway, so there is no always-on/idle compute cost.
 *
 * Frontend hosting (FEAT-004): the SPA is served by AWS Amplify Hosting
 * (Hosting/CI-CD only, NOT an Amplify backend), connected to the Git repo
 * via the Amplify console. The previous private-S3 + CloudFront static
 * hosting was REMOVED here on purpose:
 *   1. Amplify Hosting now serves the SPA, so keeping S3 + CloudFront for
 *      the same job is redundant.
 *   2. That CloudFront distribution required a distribution-wide
 *      403/404 -> index.html rewrite for SPA routing, which also clobbered
 *      the API's legitimate 4xx JSON responses (they came back as
 *      index.html/200). Dropping CloudFront removes that footgun.
 * Because the SPA is now served from the Amplify origin and calls the API
 * cross-origin, the HTTP API CORS config below allows cross-origin calls
 * (including the Authorization header for the admin route). The Amplify App
 * is intentionally NOT defined in CDK (that needs @aws-cdk/aws-amplify-alpha
 * plus a Git token); the operator connects the repo in the Amplify console.
 * See README.md for the Amplify Hosting setup.
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
      // CORS: the SPA is served by Amplify Hosting (a different origin than
      // this API), so the browser makes CROSS-ORIGIN calls and issues CORS
      // preflights. We therefore allow:
      //   - GET/POST/OPTIONS methods (OPTIONS for the preflight itself),
      //   - both 'content-type' AND 'authorization' headers. The admin route
      //     (POST /api/admin/quizzes) sends `Authorization: Bearer <jwt>`, so
      //     'authorization' MUST be in allowHeaders or the preflight fails.
      // `allowOrigins: ['*']` is kept as a conscious trade-off for this
      // public, unauthenticated demo (the only authenticated route is the
      // admin write route, which is additionally protected by the Cognito
      // JWT authorizer regardless of CORS). SECURITY NOTE: tighten
      // allowOrigins to the real Amplify domain (e.g.
      // ['https://main.<appId>.amplifyapp.com']) once it is known - see
      // README.md. CORS is a browser-side control and does not by itself
      // authorize the API, but narrowing the origin is good hygiene.
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['content-type', 'authorization'],
      },
    });

    // ---------------------------------------------------------------
    // (c.1) Amazon Cognito: admin authentication for the write API.
    //
    //   - A User Pool with sign-in by email. Self sign-up is DISABLED so
    //     only an operator can create admin users (via the console/CLI:
    //     `aws cognito-idp admin-create-user ...`). No idle cost.
    //   - A Hosted UI domain (Cognito prefix domain). The prefix MUST be
    //     globally unique across all AWS accounts, so it is derived from
    //     the AWS account id (`quiz-admin-<accountId>`) to keep it stable
    //     and unique without manual coordination. Override with the
    //     `cognitoDomainPrefix` CDK context value if the derived name is
    //     already taken (e.g. `-c cognitoDomainPrefix=my-unique-prefix`).
    //   - A PUBLIC app client (no client secret) suitable for a browser
    //     SPA, with the Hosted UI OAuth flows enabled.
    //
    //   The admin SPA's base URL is not known at synth time (it becomes an
    //   Amplify Hosting domain later), so callback/logout URLs are driven
    //   by the `adminAppBaseUrl` CfnParameter (default http://localhost:8080
    //   for local testing). Update the app client callback/logout URLs with
    //   the real Amplify domain after connecting the repo to Amplify.
    // ---------------------------------------------------------------
    const adminAppBaseUrl = new cdk.CfnParameter(this, 'adminAppBaseUrl', {
      type: 'String',
      default: 'http://localhost:8080',
      description:
        'Base URL of the admin SPA (Amplify Hosting domain in production). Used to build the Cognito Hosted UI callback/logout URLs. Update after connecting the repo to Amplify.',
    });

    const userPool = new cognito.UserPool(this, 'AdminUserPool', {
      // Only an operator creates admin users; public sign-up is off.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Demo stack: allow the pool to be torn down with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Hosted UI domain prefix. Must be globally unique; derive from the
    // account id and allow an override via CDK context.
    const domainPrefix =
      (this.node.tryGetContext('cognitoDomainPrefix') as string | undefined) ??
      `quiz-admin-${cdk.Stack.of(this).account}`;

    userPool.addDomain('AdminUserPoolDomain', {
      cognitoDomain: { domainPrefix },
    });

    // Callback/logout URLs: the admin page is served at `/admin.html`.
    const callbackUrls = [
      `${adminAppBaseUrl.valueAsString}/admin.html`,
      'http://localhost:8080/admin.html',
    ];
    const logoutUrls = [
      `${adminAppBaseUrl.valueAsString}/admin.html`,
      'http://localhost:8080/admin.html',
    ];

    const userPoolClient = userPool.addClient('AdminAppClient', {
      // Public browser client: NO client secret.
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls,
        logoutUrls,
      },
    });

    // JWT authorizer bound to the user pool issuer. The audience is the
    // app client id. API Gateway validates the JWT before invoking the
    // Lambda, so the admin handler branch can trust the caller.
    const issuer = `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${userPool.userPoolId}`;
    const adminJwtAuthorizer = new HttpJwtAuthorizer(
      'AdminJwtAuthorizer',
      issuer,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      },
    );

    // Routes are registered under an `/api` prefix. The SPA (served from
    // Amplify Hosting) reaches them cross-origin at
    // `<ApiEndpoint>/api/...`; CORS above permits those calls.
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

    // Authenticated admin write route: create a quiz. Protected by the
    // Cognito JWT authorizer; the three routes above stay OPEN.
    httpApi.addRoutes({
      path: '/api/admin/quizzes',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: adminJwtAuthorizer,
    });

    // ---------------------------------------------------------------
    // (d) Frontend hosting.
    //
    //   The static SPA is hosted by AWS Amplify Hosting, connected to the
    //   Git repository via the Amplify console (Hosting only, no Amplify
    //   backend). See README.md and amplify.yml. There is intentionally NO
    //   S3 + CloudFront frontend hosting here anymore (removed in FEAT-004):
    //   Amplify serves the SPA, and dropping CloudFront also removes the
    //   distribution-wide 403/404 -> index.html rewrite that used to clobber
    //   the API's 4xx JSON responses. The Amplify build injects the runtime
    //   config (API_BASE / COGNITO_DOMAIN / COGNITO_CLIENT_ID) into
    //   frontend/config.js from Amplify environment variables set to the
    //   CfnOutputs below (API_BASE = ApiEndpoint + '/api').
    // ---------------------------------------------------------------

    // ---------------------------------------------------------------
    // (e) Outputs.
    // ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description:
        'Base URL of the quiz HTTP API (routes are under /api, e.g. /api/quizzes). The Amplify-hosted SPA calls these cross-origin; set the Amplify env var API_BASE to this value + "/api".',
    });
    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    // Cognito outputs consumed by the admin SPA and for bootstrapping the
    // first admin user.
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool id (admin authentication)',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool app client id (public browser client)',
    });
    new cdk.CfnOutput(this, 'UserPoolHostedUiDomain', {
      value: `https://${domainPrefix}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`,
      description:
        'Cognito Hosted UI base URL. The admin SPA redirects here for login. The domain prefix must be globally unique.',
    });
  }
}
