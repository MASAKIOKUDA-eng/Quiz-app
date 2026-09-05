import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaIntegration,
  WebSocketLambdaIntegration,
} from 'aws-cdk-lib/aws-apigatewayv2-integrations';
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
      // Realtime battle (FEAT-002): battle ROOM#/CONN#/PLAYER# items carry a
      // numeric `ttl` (epoch seconds) so DynamoDB auto-expires stale rooms
      // and connections at no cost. Existing QUIZ# items simply omit `ttl`
      // and are never expired, so this is purely additive.
      timeToLiveAttribute: 'ttl',
    });

    // ---------------------------------------------------------------
    // (b) API Lambda: ARM64/Graviton (cheaper), latest Node runtime.
    //     @aws-sdk/* is provided by the Node runtime, so mark it
    //     external so esbuild does not bundle it.
    // ---------------------------------------------------------------
    // Single allowed browser origin, used BOTH for the API Gateway CORS
    // preflight AND (via the Lambda's ALLOWED_ORIGIN env var) for the
    // `access-control-allow-origin` header on every Lambda JSON response, so
    // the two stay coherent. It is a synth-time CDK context value (not a
    // CfnParameter) so the literal string can be placed directly in the
    // `allowOrigins` array and the Lambda environment. Override per-deploy
    // with `-c allowedOrigin=https://my.domain`. Defaults to the Amplify
    // Hosting domain for this app.
    const allowedOrigin =
      (this.node.tryGetContext('allowedOrigin') as string | undefined) ??
      'https://main.d2uwsqpk41y7so.amplifyapp.com';

    const apiFunction = new NodejsFunction(this, 'ApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      entry: path.join(__dirname, '..', 'lambda', 'index.ts'),
      handler: 'handler',
      environment: {
        TABLE_NAME: table.tableName,
        // Kept in sync with the CORS allowOrigins below so the Lambda's
        // access-control-allow-origin response header matches the preflight.
        ALLOWED_ORIGIN: allowedOrigin,
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
      //   - GET/POST/PUT/DELETE/OPTIONS methods (OPTIONS for the preflight
      //     itself; PUT/DELETE for the admin edit/delete routes),
      //   - both 'content-type' AND 'authorization' headers. The admin routes
      //     send `Authorization: Bearer <jwt>`, so 'authorization' MUST be in
      //     allowHeaders or the preflight fails.
      // `allowOrigins` is tightened to a SINGLE origin (`allowedOrigin`,
      // defaulting to the Amplify Hosting domain, overridable per-deploy via
      // the `allowedOrigin` CDK context) instead of the previous '*'. The
      // Lambda's access-control-allow-origin response header is set to the
      // same value (ALLOWED_ORIGIN env var) so preflight and actual responses
      // agree. CORS is a browser-side control and does not by itself
      // authorize the API (the admin routes are additionally protected by the
      // Cognito JWT authorizer), but narrowing the origin is good hygiene.
      corsPreflight: {
        allowOrigins: [allowedOrigin],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
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
    //
    // The primary entry is derived from the `adminAppBaseUrl` parameter (the
    // Amplify domain in production). We ALSO trust `http://localhost:8080/admin.html`
    // by default so a developer can run the SPA locally against the Hosted UI.
    // That localhost entry must NOT be trusted by a production pool, but
    // `adminAppBaseUrl` is a CfnParameter whose value is a synth-time token
    // (`.valueAsString`), so we cannot string-compare it to decide. Instead we
    // gate the localhost entry behind a plain synth-time CDK context flag,
    // `includeLocalhostCallback`, which defaults to true for developer
    // convenience. For production deploys, operators pass
    // `-c includeLocalhostCallback=false` so the pool does not trust a
    // localhost redirect target.
    //
    // NOTE: values passed via `-c key=value` arrive as the STRING "false",
    // which is truthy in JS, so we explicitly treat "false"/false as false
    // (any other value, including the unset default, keeps localhost enabled).
    const includeLocalhostCallbackCtx = this.node.tryGetContext(
      'includeLocalhostCallback',
    );
    const includeLocalhostCallback =
      includeLocalhostCallbackCtx !== false &&
      includeLocalhostCallbackCtx !== 'false';

    // The admin SPA lives at `/admin.html`. The realtime battle HOST view
    // (FEAT-002) lives in the PUBLIC app at `/index.html`, but it reuses the
    // SAME Cognito Hosted UI login, so the Hosted UI redirects the host back
    // to `/index.html`. That URL must therefore ALSO be a trusted
    // callback/logout URL on this app client, alongside the existing
    // `/admin.html` entries (which are kept unchanged). Both follow the same
    // `adminAppBaseUrl` + `includeLocalhostCallback` gating.
    const callbackUrls = [
      `${adminAppBaseUrl.valueAsString}/admin.html`,
      `${adminAppBaseUrl.valueAsString}/index.html`,
    ];
    const logoutUrls = [
      `${adminAppBaseUrl.valueAsString}/admin.html`,
      `${adminAppBaseUrl.valueAsString}/index.html`,
    ];
    if (includeLocalhostCallback) {
      callbackUrls.push('http://localhost:8080/admin.html');
      callbackUrls.push('http://localhost:8080/index.html');
      logoutUrls.push('http://localhost:8080/admin.html');
      logoutUrls.push('http://localhost:8080/index.html');
    }

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

    // Authenticated admin single-quiz routes: read (answerIndex-inclusive),
    // full-replace edit, and delete. All bound to the SAME JWT authorizer as
    // the create route above; the public routes stay OPEN.
    httpApi.addRoutes({
      path: '/api/admin/quizzes/{quizId}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: adminJwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/api/admin/quizzes/{quizId}',
      methods: [apigwv2.HttpMethod.PUT],
      integration,
      authorizer: adminJwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/api/admin/quizzes/{quizId}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: adminJwtAuthorizer,
    });

    // ---------------------------------------------------------------
    // (c.2) Realtime battle (FEAT-002): a dedicated ARM64 WebSocket Lambda
    //       behind an API Gateway v2 WebSocket API.
    //
    //   The WebSocket handler runs the server-authoritative battle game
    //   state machine: it stores rooms/connections/players in the SAME
    //   DynamoDB table under ROOM#/CONN# namespaces (QUIZ# items untouched),
    //   scores answers server-side using the stored answerIndex (never
    //   broadcasting it), and pushes state to every room connection via the
    //   API Gateway Management API (ManageConnections grant below).
    //
    //   Host-only actions (createRoom/startGame/nextQuestion/endGame) are
    //   gated by verifying the SAME Cognito id token the admin SPA already
    //   obtains via the Hosted UI, so the handler is given the issuer URL
    //   and the app client id to check iss/aud/signature. Participants
    //   (joinRoom/submitAnswer) connect with just a name + roomId, no token.
    // ---------------------------------------------------------------
    const wsFunction = new NodejsFunction(this, 'WsFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      entry: path.join(__dirname, '..', 'lambda', 'ws.ts'),
      handler: 'handler',
      environment: {
        TABLE_NAME: table.tableName,
        ALLOWED_ORIGIN: allowedOrigin,
        // Host JWT verification: the handler validates the Cognito id token
        // against this issuer + audience (client id) and the pool JWKS.
        COGNITO_ISSUER: issuer,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        // aws-sdk v3 (incl. @aws-sdk/client-apigatewaymanagementapi) ships
        // with the Node runtime; keep it external.
        externalModules: ['@aws-sdk/*'],
      },
    });

    table.grantReadWriteData(wsFunction);

    const wsIntegration = new WebSocketLambdaIntegration(
      'WsIntegration',
      wsFunction,
    );

    const wsApi = new apigwv2.WebSocketApi(this, 'QuizWebSocketApi', {
      description: 'Realtime quiz battle WebSocket API',
      connectRouteOptions: { integration: wsIntegration },
      disconnectRouteOptions: { integration: wsIntegration },
      defaultRouteOptions: { integration: wsIntegration },
    });

    // Custom battle action routes (matched on the JSON body `action` field
    // via the WebSocket API's default route-selection expression
    // `$request.body.action`).
    for (const action of [
      'createRoom',
      'joinRoom',
      'startGame',
      'submitAnswer',
      'nextQuestion',
      'endGame',
    ]) {
      wsApi.addRoute(action, { integration: wsIntegration });
    }

    const wsStage = new apigwv2.WebSocketStage(this, 'QuizWebSocketStage', {
      webSocketApi: wsApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    // Let the WebSocket Lambda call the API Gateway Management API
    // (PostToConnection) to push state to connected clients.
    wsApi.grantManageConnections(wsFunction);

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

    // Realtime battle (FEAT-002) WebSocket endpoint. The SPA connects here
    // for the live battle. Set the Amplify env var WS_URL to this value (it
    // is mapped to VITE_WS_URL at build time, mirroring API_BASE).
    new cdk.CfnOutput(this, 'WebSocketEndpoint', {
      value: wsStage.url,
      description:
        'wss:// URL of the realtime battle WebSocket API (prod stage). Set the Amplify env var WS_URL to this value; it is mapped to VITE_WS_URL at build time.',
    });
  }
}
